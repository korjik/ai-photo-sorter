import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGroups,
  buildPlaceLabelInstructions,
  collectFiles,
  deleteSourceFiles,
  fallbackPlaceLabel,
  findDestinationDuplicates,
  chooseShortestNameCanonical,
  limitFilesToProcess,
  normalizeCachedDecision,
  parseArgs,
  parsePositiveIntegerFlag,
  placeFile,
  readConfigFile,
  resolveAlias,
  rewritePlaceDecision,
  slugifyPlace,
} from "../src/index.ts";

function sourceFile(fileName: string) {
  return {
    sourceRoot: "/photos",
    filePath: `/photos/${fileName}`,
    fileName,
    extension: ".jpg",
    sizeBytes: 1,
    mtimeMs: 0,
  };
}

function metadata(fileName: string, capturedAt: Date) {
  return {
    ...sourceFile(fileName),
    relativePath: fileName,
    capturedAt,
    capturedAtSource: "DateTimeOriginal",
    timestampMs: capturedAt.getTime(),
    locationSource: "missing" as const,
  };
}

function config(sourceRoot: string, ignoreFolders?: string[]) {
  return {
    sourceRoots: [sourceRoot],
    outputRoot: path.join(sourceRoot, "out"),
    mode: "hardlink" as const,
    inferenceWindowMinutes: 90,
    supportedExtensions: [".jpg"],
    ignoreFolders,
    openai: {
      enabled: false,
      model: "gpt-5-mini",
    },
    geocoding: {
      provider: "nominatim" as const,
      userAgent: "ai-photo-sorter-test/1.0",
      language: "en",
      rateLimitMs: 0,
      nearbyRadiusMeters: 800,
      nearbyLimit: 8,
    },
    aliases: [],
  };
}

test("parseArgs reads --limit as a positive integer", () => {
  assert.deepEqual(
    parseArgs(["--config", "ai-photo-sorter.config.json", "--dry-run", "--limit", "100"]),
    {
      execute: false,
      dryRun: true,
      deleteSource: false,
      dedupOnly: false,
      configPath: "ai-photo-sorter.config.json",
      limit: 100,
    },
  );
});

test("parseArgs lets --dry-run override --execute", () => {
  assert.deepEqual(parseArgs(["--execute", "--dry-run", "--limit", "2"]), {
    execute: false,
    dryRun: true,
    deleteSource: false,
    dedupOnly: false,
    configPath: undefined,
    limit: 2,
  });
});

test("parseArgs enables execute mode without dry-run", () => {
  assert.deepEqual(parseArgs(["--execute"]), {
    execute: true,
    dryRun: false,
    deleteSource: false,
    dedupOnly: false,
    configPath: undefined,
    limit: undefined,
  });
});

test("parseArgs enables source deletion with --delete", () => {
  assert.deepEqual(parseArgs(["--execute", "--delete"]), {
    execute: true,
    dryRun: false,
    deleteSource: true,
    dedupOnly: false,
    configPath: undefined,
    limit: undefined,
  });
});

test("parseArgs enables dedup-only mode", () => {
  assert.deepEqual(parseArgs(["--dedup-only", "--execute"]), {
    execute: true,
    dryRun: false,
    deleteSource: false,
    dedupOnly: true,
    configPath: undefined,
    limit: undefined,
  });
});

test("parsePositiveIntegerFlag rejects invalid values", () => {
  assert.throws(() => parsePositiveIntegerFlag("--limit", undefined), /positive integer/);
  assert.throws(() => parsePositiveIntegerFlag("--limit", "0"), /positive integer/);
  assert.throws(() => parsePositiveIntegerFlag("--limit", "-1"), /positive integer/);
  assert.throws(() => parsePositiveIntegerFlag("--limit", "1.5"), /positive integer/);
  assert.throws(() => parsePositiveIntegerFlag("--limit", "abc"), /positive integer/);
});

test("readConfigFile explains missing default /config mount", async () => {
  await assert.rejects(
    readConfigFile("/config/ai-photo-sorter.config.json"),
    /Mount a folder containing ai-photo-sorter\.config\.json to \/config/,
  );
});

test("readConfigFile reads an explicit config path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const configPath = path.join(root, "custom.config.json");
    await fs.writeFile(configPath, "{}");

    assert.equal(await readConfigFile(configPath), "{}");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("limitFilesToProcess caps the unique processing queue without mutating it", () => {
  const files = [sourceFile("a.jpg"), sourceFile("b.jpg"), sourceFile("c.jpg")];

  assert.deepEqual(limitFilesToProcess(files, 2), files.slice(0, 2));
  assert.deepEqual(limitFilesToProcess(files), files);
  assert.equal(files.length, 3);
});

test("limitFilesToProcess returns all files when the limit is larger than the queue", () => {
  const files = [sourceFile("a.jpg"), sourceFile("b.jpg")];

  assert.deepEqual(limitFilesToProcess(files, 10), files);
});

test("placeFile deletes source after successful copy when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const sourcePath = path.join(root, "source.jpg");
    const targetPath = path.join(root, "target.jpg");
    await fs.writeFile(sourcePath, "image");

    await placeFile(sourcePath, targetPath, "copy", true);

    assert.equal(await fs.readFile(targetPath, "utf8"), "image");
    await assert.rejects(fs.access(sourcePath), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("placeFile keeps source after copy by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const sourcePath = path.join(root, "source.jpg");
    const targetPath = path.join(root, "target.jpg");
    await fs.writeFile(sourcePath, "image");

    await placeFile(sourcePath, targetPath, "copy");

    assert.equal(await fs.readFile(sourcePath, "utf8"), "image");
    assert.equal(await fs.readFile(targetPath, "utf8"), "image");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("placeFile deletes source after successful hardlink when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const sourcePath = path.join(root, "source.jpg");
    const targetPath = path.join(root, "target.jpg");
    await fs.writeFile(sourcePath, "image");

    await placeFile(sourcePath, targetPath, "hardlink", true);

    assert.equal(await fs.readFile(targetPath, "utf8"), "image");
    await assert.rejects(fs.access(sourcePath), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleteSourceFiles deletes skipped duplicate source paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const firstPath = path.join(root, "duplicate-a.jpg");
    const secondPath = path.join(root, "duplicate-b.jpg");
    await fs.writeFile(firstPath, "image");
    await fs.writeFile(secondPath, "image");

    await deleteSourceFiles([{ filePath: firstPath }, { filePath: secondPath }]);

    await assert.rejects(fs.access(firstPath), /ENOENT/);
    await assert.rejects(fs.access(secondPath), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("chooseShortestNameCanonical keeps the shortest filename", () => {
  const files = [
    sourceFile("longer-name.jpg"),
    sourceFile("a.jpg"),
    sourceFile("same.jpg"),
  ];

  assert.equal(chooseShortestNameCanonical(files).fileName, "a.jpg");
});

test("chooseShortestNameCanonical uses stable sorting for equal name lengths", () => {
  const files = [sourceFile("b.jpg"), sourceFile("a.jpg")];

  assert.equal(chooseShortestNameCanonical(files).fileName, "a.jpg");
});

test("findDestinationDuplicates marks exact duplicates except the shortest filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const destination = path.join(root, "AI-sorted");
    const folder = path.join(destination, "2025", "01-12_Home");
    await fs.mkdir(folder, { recursive: true });

    const keepPath = path.join(folder, "a.jpg");
    const duplicatePath = path.join(folder, "longer-name.jpg");
    const differentPath = path.join(folder, "different.jpg");
    await fs.writeFile(keepPath, "same image");
    await fs.writeFile(duplicatePath, "same image");
    await fs.writeFile(differentPath, "other image");

    const files = await collectFiles(config(destination));
    const duplicates = await findDestinationDuplicates(files, {
      reverseGeocode: {},
      aiPlaceLabels: {},
      fileHashes: {},
    });

    assert.deepEqual(
      duplicates.map((duplicate) => ({
        fileName: duplicate.fileName,
        keepFileName: duplicate.keepFileName,
      })),
      [{ fileName: "longer-name.jpg", keepFileName: "a.jpg" }],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("buildGroups formats month and day with a dash", () => {
  const groups = buildGroups([
    {
      record: metadata("bear-valley.jpg", new Date("2025-01-12T18:00:00.000Z")),
      context: { aliasLabel: "Bear Valley" },
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].year, "2025");
  assert.equal(groups[0].monthDay, "01-12");
});

test("buildGroups combines records with the same date and location", () => {
  const groups = buildGroups([
    {
      record: metadata("first.jpg", new Date("2025-01-12T18:00:00.000Z")),
      context: { aliasLabel: "Home" },
    },
    {
      record: metadata("second.jpg", new Date("2025-01-12T20:00:00.000Z")),
      context: { aliasLabel: "Home" },
    },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, 2);
});

test("buildGroups separates records with different locations on the same date", () => {
  const groups = buildGroups([
    {
      record: metadata("home.jpg", new Date("2025-01-12T18:00:00.000Z")),
      context: { aliasLabel: "Home" },
    },
    {
      record: metadata("park.jpg", new Date("2025-01-12T20:00:00.000Z")),
      context: { aliasLabel: "Park" },
    },
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["2025-01-12__alias:Home", "2025-01-12__alias:Park"],
  );
});

test("resolveAlias matches normalized address abbreviations", () => {
  const alias = resolveAlias(
    10.0001,
    20.0001,
    {
      displayName:
        "100, Example Valley Court, Example Neighborhood, Sample City, California, 90000, United States",
      nearbyFeatures: ["Example Park", "Sample Ridge"],
    },
    [
      {
        label: "Home",
        addressContains: ["100 example vly"],
      },
    ],
  );

  assert.equal(alias, "Home");
});

test("resolveAlias requires all configured address fragments", () => {
  const alias = resolveAlias(
    10.0001,
    20.0001,
    {
      displayName:
        "100, Example Valley Court, Example Neighborhood, Sample City, California, 90000, United States",
      nearbyFeatures: ["Example Park", "Sample Ridge"],
    },
    [
      {
        label: "Home",
        addressContains: ["100", "Example Valley", "Sample City"],
      },
      {
        label: "Cabin",
        addressContains: ["100", "Missing Town"],
      },
    ],
  );

  assert.equal(alias, "Home");
});

test("resolveAlias does not match a partial address fragment set", () => {
  const alias = resolveAlias(
    10.0001,
    20.0001,
    {
      displayName:
        "100, Example Valley Court, Example Neighborhood, Sample City, California, 90000, United States",
      nearbyFeatures: ["Example Park", "Sample Ridge"],
    },
    [
      {
        label: "Cabin",
        addressContains: ["100", "Missing Town"],
      },
    ],
  );

  assert.equal(alias, undefined);
});

test("resolveAlias matches home by coordinate radius before OpenAI labeling", () => {
  const alias = resolveAlias(
    10.0002,
    20.0002,
    {
      displayName:
        "100, Example Valley Court, Example Neighborhood, Sample City, California, 90000, United States",
      nearbyFeatures: ["Example Park", "Sample Ridge"],
    },
    [
      {
        label: "Home",
        coordinates: {
          latitude: 10,
          longitude: 20,
          radiusMeters: 300,
        },
      },
    ],
  );

  assert.equal(alias, "Home");
});

test("fallbackPlaceLabel uses Misc when no location context exists", () => {
  assert.equal(fallbackPlaceLabel({}), "Misc");
});

test("slugifyPlace uses Misc for empty labels", () => {
  assert.equal(slugifyPlace(""), "Misc");
});

test("normalizeCachedDecision maps legacy Unknown_Place labels to Misc", () => {
  assert.equal(normalizeCachedDecision("Unknown_Place")?.label, "Misc");
  assert.equal(
    normalizeCachedDecision({
      label: "Unknown_Place",
      strategy: "fallback",
      reason: 'The folder was named from nearby reverse-geocode data as "Unknown_Place".',
    })?.label,
    "Misc",
  );
});

test("rewritePlaceDecision generalizes labels from selected label text", () => {
  const group = buildGroups([
    {
      record: metadata("trail.jpg", new Date("2025-07-27T18:00:00.000Z")),
      context: {
        reverse: {
          displayName: "Example Village, Example County, United States",
          nearbyFeatures: [],
        },
      },
    },
  ])[0];

  const decision = rewritePlaceDecision(
    {
      label: "Example Falls Trail",
      strategy: "openai",
      reason: 'OpenAI selected "Example Falls Trail".',
    },
    group,
    [{ label: "Example National Park", matchContains: ["Example Falls"] }],
  );

  assert.equal(decision.label, "Example National Park");
  assert.match(decision.reason, /Rewritten to "Example National Park"/);
});

test("rewritePlaceDecision generalizes labels from reverse-geocode context", () => {
  const group = buildGroups([
    {
      record: metadata("camp.jpg", new Date("2025-07-27T18:00:00.000Z")),
      context: {
        reverse: {
          displayName: "Example Valley Backpackers Campground, Example National Park, United States",
          nearbyFeatures: [],
        },
      },
    },
  ])[0];

  const decision = rewritePlaceDecision(
    {
      label: "Backpackers Campground",
      strategy: "cache",
      reason: 'Reused cached label "Backpackers Campground" from a previous run.',
    },
    group,
    [{ label: "Example National Park", matchContains: ["Example National Park"] }],
  );

  assert.equal(decision.label, "Example National Park");
});

test("buildPlaceLabelInstructions asks OpenAI to prefer broader destinations", () => {
  const instructions = buildPlaceLabelInstructions();

  assert.match(instructions, /broadest useful destination/);
  assert.match(instructions, /national park/);
  assert.match(instructions, /trail, campground, lodge/);
});

test("collectFiles ignores @eaDir folders by default", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    await fs.writeFile(path.join(root, "keep.jpg"), "keep");
    await fs.mkdir(path.join(root, "@eaDir"));
    await fs.writeFile(path.join(root, "@eaDir", "skip.jpg"), "skip");

    const files = await collectFiles(config(root));

    assert.deepEqual(
      files.map((file) => file.fileName),
      ["keep.jpg"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectFiles ignores Synology thumbnail folders below media-like directory names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    await fs.writeFile(path.join(root, "keep.jpg"), "keep");
    const thumbnailFolder = path.join(root, "@eaDir", "062100BD-D11F-4A49-BDE4-56CB517EEC66.HEIC");
    await fs.mkdir(thumbnailFolder, { recursive: true });
    await fs.writeFile(path.join(thumbnailFolder, "SYNOFILE_THUMB_M.jpg"), "skip");

    const files = await collectFiles(config(root));

    assert.deepEqual(
      files.map((file) => file.fileName),
      ["keep.jpg"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectFiles skips a source root that is itself ignored", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    const ignoredRoot = path.join(root, "@eaDir");
    await fs.mkdir(ignoredRoot);
    await fs.writeFile(path.join(ignoredRoot, "skip.jpg"), "skip");

    const files = await collectFiles(config(ignoredRoot));

    assert.deepEqual(files, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectFiles uses configured ignore folder names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-photo-sorter-"));
  try {
    await fs.writeFile(path.join(root, "keep.jpg"), "keep");
    await fs.mkdir(path.join(root, "Previews"));
    await fs.writeFile(path.join(root, "Previews", "skip.jpg"), "skip");

    const files = await collectFiles(config(root, ["Previews"]));

    assert.deepEqual(
      files.map((file) => file.fileName),
      ["keep.jpg"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
