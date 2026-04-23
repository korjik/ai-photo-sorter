import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGroups,
  collectFiles,
  fallbackPlaceLabel,
  limitFilesToProcess,
  normalizeCachedDecision,
  parseArgs,
  parsePositiveIntegerFlag,
  resolveAlias,
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
      configPath: "ai-photo-sorter.config.json",
      limit: 100,
    },
  );
});

test("parseArgs lets --dry-run override --execute", () => {
  assert.deepEqual(parseArgs(["--execute", "--dry-run", "--limit", "2"]), {
    execute: false,
    dryRun: true,
    configPath: undefined,
    limit: 2,
  });
});

test("parseArgs enables execute mode without dry-run", () => {
  assert.deepEqual(parseArgs(["--execute"]), {
    execute: true,
    dryRun: false,
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
