import { exiftool } from "exiftool-vendored";
import { zodTextFormat } from "openai/helpers/zod";
import OpenAI from "openai";
import { z } from "zod";
import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

type SortMode = "copy" | "hardlink" | "move";

type Coordinates = {
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

type AliasRule = {
  label: string;
  coordinates?: Coordinates;
  addressContains?: string[];
};

type Config = {
  sourceRoots: string[];
  outputRoot: string;
  mode: SortMode;
  inferenceWindowMinutes: number;
  supportedExtensions: string[];
  openai: {
    enabled: boolean;
    model: string;
  };
  geocoding: {
    provider: "nominatim";
    userAgent: string;
    language: string;
    rateLimitMs: number;
    nearbyRadiusMeters: number;
    nearbyLimit: number;
  };
  aliases: AliasRule[];
};

type MetadataRecord = {
  sourceRoot: string;
  filePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  capturedAt: Date;
  capturedAtSource: string;
  timestampMs: number;
  latitude?: number;
  longitude?: number;
  locationSource: "embedded" | "inferred" | "missing";
};

type SourceFileRecord = {
  sourceRoot: string;
  filePath: string;
  fileName: string;
  extension: string;
  sizeBytes: number;
  mtimeMs: number;
};

type DuplicateFileRecord = SourceFileRecord & {
  duplicateOf: string;
  contentHash: string;
};

type ReverseGeocodeResult = {
  displayName?: string;
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
  nearbyFeatures: string[];
};

type PlaceContext = {
  aliasLabel?: string;
  latitude?: number;
  longitude?: number;
  reverse?: ReverseGeocodeResult;
};

type SortGroup = {
  key: string;
  dateKey: string;
  year: string;
  monthDay: string;
  context: PlaceContext;
  files: MetadataRecord[];
};

type CacheFile = {
  reverseGeocode: Record<string, ReverseGeocodeResult>;
  aiPlaceLabels: Record<string, string | PlaceLabelDecision>;
  fileHashes: Record<string, string>;
};

type LocationConfigFile = {
  aliases?: AliasRule[];
};

type PlaceLabelDecision = {
  label: string;
  strategy: "alias" | "openai" | "cache" | "fallback";
  reason: string;
};

type LabeledGroup = SortGroup & {
  placeLabel: string;
  folderName: string;
  decision: PlaceLabelDecision;
};

const placeLabelSchema = z.object({
  placeLabel: z
    .string()
    .min(1)
    .max(48)
    .describe("Human-friendly place label like Bear Valley, Home, or Golden Gate Park."),
});

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "photo-sorter.config.json");
const LEGACY_CACHE_PATH = path.resolve(process.cwd(), ".cache", "photo-sorter-cache.json");
const DEFAULT_PHOTO_ROOT = "/photo";
const LOCATION_CONFIG_FILE_NAME = "photo-sorter-location.config.json";
const FOLDER_METADATA_FILE_NAME = ".ai-sorted";
const DESTINATION_CACHE_FILE_NAME = ".photo-sorter-cache.json";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(process.cwd(), args.configPath ?? DEFAULT_CONFIG_PATH);
  const execute = args.execute;
  const config = await loadConfig(configPath, execute);
  const cachePath = getDestinationCachePath(config);
  const openaiClient = buildOpenAIClient(config);
  const cache = await loadCache(cachePath, LEGACY_CACHE_PATH);

  const files = await collectFiles(config, args.limit);
  console.log(`Found ${files.length} media files.`);
  const dedupedFiles = await dedupeFiles(files, cache);
  console.log(
    `Deduplicated to ${dedupedFiles.uniqueFiles.length} unique media files; skipped ${dedupedFiles.duplicates.length} duplicates.`,
  );

  const metadata = await readMetadata(dedupedFiles.uniqueFiles, config);
  console.log(`Resolved metadata for ${metadata.length} files.`);

  const enriched = await enrichLocations(metadata, config, cache);
  const groups = buildGroups(enriched);
  console.log(`Built ${groups.length} date/place groups.`);

  const labeledGroups = await labelGroups(groups, config, cache, openaiClient);
  await saveCache(cachePath, cache);

  if (!execute) {
    printPlan(labeledGroups, dedupedFiles.duplicates, config);
    console.log("");
    console.log("Dry run only. Re-run with --execute to create folders and organize files.");
    return;
  }

  await materializeGroups(labeledGroups, config);
  console.log(
    `Completed. Organized ${metadata.length} unique files into ${config.outputRoot}. Skipped ${dedupedFiles.duplicates.length} duplicates.`,
  );
}

function parseArgs(args: string[]) {
  let execute = false;
  let dryRun = false;
  let configPath: string | undefined;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      execute = true;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      execute = false;
      continue;
    }

    if (arg === "--config") {
      configPath = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      limit = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
    }
  }

  return { execute: execute && !dryRun, dryRun, configPath, limit };
}

async function loadConfig(configPath: string, execute: boolean): Promise<Config> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = applyEnvironmentOverrides(JSON.parse(raw) as Config);
  return prepareDestinationLocationConfig(parsed, execute);
}

function applyEnvironmentOverrides(config: Config): Config {
  const photoRoot = process.env.PHOTO_ROOT || DEFAULT_PHOTO_ROOT;
  const sourceRootsOverride = process.env.SOURCE_ROOTS;
  const destinationOverride = process.env.DESTINATION;

  const sourceRoots = sourceRootsOverride
    ? sourceRootsOverride
        .split(":")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => resolveConfiguredPath(value, photoRoot))
    : config.sourceRoots;

  const outputRoot = destinationOverride
    ? resolveConfiguredPath(destinationOverride, photoRoot)
    : config.outputRoot;

  return {
    ...config,
    sourceRoots,
    outputRoot,
  };
}

async function prepareDestinationLocationConfig(config: Config, execute: boolean): Promise<Config> {
  const locationConfigPath = path.join(config.outputRoot, LOCATION_CONFIG_FILE_NAME);
  const destinationLocationConfig = await readLocationConfig(locationConfigPath);

  if (execute) {
    await fs.mkdir(config.outputRoot, { recursive: true });

    if (!destinationLocationConfig) {
      await writeLocationConfig(locationConfigPath, {
        aliases: config.aliases,
      });
    }
  }

  const mergedAliases = mergeAliases(destinationLocationConfig?.aliases ?? [], config.aliases);
  return {
    ...config,
    aliases: mergedAliases,
  };
}

async function readLocationConfig(locationConfigPath: string): Promise<LocationConfigFile | undefined> {
  try {
    const raw = await fs.readFile(locationConfigPath, "utf8");
    return JSON.parse(raw) as LocationConfigFile;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function writeLocationConfig(locationConfigPath: string, payload: LocationConfigFile) {
  await fs.writeFile(locationConfigPath, JSON.stringify(payload, null, 2));
}

function mergeAliases(destinationAliases: AliasRule[], configAliases: AliasRule[]) {
  const merged = new Map<string, AliasRule>();

  for (const alias of destinationAliases) {
    merged.set(normalizeAliasKey(alias.label), alias);
  }

  for (const alias of configAliases) {
    merged.set(normalizeAliasKey(alias.label), alias);
  }

  return Array.from(merged.values());
}

function normalizeAliasKey(value: string) {
  return value.trim().toLowerCase();
}

function resolveConfiguredPath(value: string, photoRoot: string) {
  return path.isAbsolute(value) ? value : path.join(photoRoot, value);
}

function getDestinationCachePath(config: Config) {
  return path.join(config.outputRoot, DESTINATION_CACHE_FILE_NAME);
}

async function collectFiles(config: Config, limit?: number) {
  const supportedExtensions = new Set(config.supportedExtensions.map((value) => value.toLowerCase()));
  const files: SourceFileRecord[] = [];
  const maxFiles = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;

  for (const sourceRoot of config.sourceRoots) {
    await walk(sourceRoot, async (filePath) => {
      if (files.length >= maxFiles) {
        return true;
      }

      const extension = path.extname(filePath).toLowerCase();
      if (supportedExtensions.has(extension)) {
        const stat = await fs.stat(filePath);
        files.push({
          sourceRoot,
          filePath,
          fileName: path.basename(filePath),
          extension,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }

      return files.length >= maxFiles;
    });

    if (files.length >= maxFiles) {
      break;
    }
  }

  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return files;
}

async function dedupeFiles(files: SourceFileRecord[], cache: CacheFile) {
  const bySize = new Map<number, SourceFileRecord[]>();
  for (const file of files) {
    const bucket = bySize.get(file.sizeBytes);
    if (bucket) {
      bucket.push(file);
    } else {
      bySize.set(file.sizeBytes, [file]);
    }
  }

  const uniqueFiles: SourceFileRecord[] = [];
  const duplicates: DuplicateFileRecord[] = [];

  for (const bucket of bySize.values()) {
    if (bucket.length === 1) {
      uniqueFiles.push(bucket[0]);
      continue;
    }

    const canonicalByHash = new Map<string, SourceFileRecord>();
    for (const file of bucket) {
      const contentHash = await getContentHash(file, cache);
      const canonical = canonicalByHash.get(contentHash);

      if (canonical) {
        duplicates.push({
          ...file,
          duplicateOf: canonical.filePath,
          contentHash,
        });
        continue;
      }

      canonicalByHash.set(contentHash, file);
      uniqueFiles.push(file);
    }
  }

  uniqueFiles.sort((left, right) => left.filePath.localeCompare(right.filePath));
  duplicates.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return { uniqueFiles, duplicates };
}

async function getContentHash(file: SourceFileRecord, cache: CacheFile) {
  const cacheKey = buildFileHashCacheKey(file);
  const cachedHash = cache.fileHashes[cacheKey];
  if (cachedHash) {
    return cachedHash;
  }

  const contentHash = await hashFile(file.filePath);
  cache.fileHashes[cacheKey] = contentHash;
  return contentHash;
}

function buildFileHashCacheKey(file: SourceFileRecord) {
  return `${file.filePath}|${file.sizeBytes}|${Math.trunc(file.mtimeMs)}`;
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  return hash.digest("hex");
}

async function walk(root: string, onFile: (filePath: string) => Promise<boolean | void>): Promise<boolean> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const shouldStop = await walk(fullPath, onFile);
      if (shouldStop) {
        return true;
      }
      continue;
    }

    if (entry.isFile()) {
      const shouldStop = await onFile(fullPath);
      if (shouldStop) {
        return true;
      }
    }
  }

  return false;
}

async function readMetadata(
  files: SourceFileRecord[],
  config: Config,
): Promise<MetadataRecord[]> {
  const records = await mapWithConcurrency<
    SourceFileRecord,
    MetadataRecord | undefined
  >(files, 6, async (file, index) => {
    try {
      const tags = await exiftool.read(file.filePath);
      const captureInfo = extractDate(tags as unknown as { [key: string]: unknown });
      if (!captureInfo) {
        console.warn(`Skipping ${file.filePath}: no usable capture date.`);
        return undefined;
      }

      if ((index + 1) % 250 === 0 || index === files.length - 1) {
        console.log(`Metadata ${index + 1}/${files.length}`);
      }

      const latitude = numberOrUndefined(tags.GPSLatitude);
      const longitude = numberOrUndefined(tags.GPSLongitude);

      return {
        sourceRoot: file.sourceRoot,
        filePath: file.filePath,
        relativePath: path.relative(file.sourceRoot, file.filePath),
        fileName: file.fileName,
        extension: file.extension,
        capturedAt: captureInfo.value,
        capturedAtSource: captureInfo.source,
        timestampMs: captureInfo.value.getTime(),
        latitude,
        longitude,
        locationSource:
          latitude !== undefined && longitude !== undefined ? "embedded" : "missing",
      } satisfies MetadataRecord;
    } catch (error) {
      console.warn(`Skipping ${file.filePath}: ${String(error)}`);
      return undefined;
    }
  });

  const presentRecords = records.filter((record): record is MetadataRecord => record !== undefined);
  presentRecords.sort((left, right) => left.timestampMs - right.timestampMs);
  inferMissingCoordinates(presentRecords, config.inferenceWindowMinutes);
  return presentRecords;
}

function extractDate(tags: { [key: string]: unknown }) {
  const candidates = [
    "DateTimeOriginal",
    "CreationDate",
    "CreateDate",
    "MediaCreateDate",
    "TrackCreateDate",
    "ContentCreateDate",
    "SubSecDateTimeOriginal",
    "FileModifyDate",
  ];

  for (const key of candidates) {
    const value = tags[key];
    const parsed = parseExifDate(value);
    if (parsed) {
      return {
        value: parsed,
        source: key,
      };
    }
  }

  return undefined;
}

function parseExifDate(value: unknown) {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value === "object" && value !== null && "toDate" in value && typeof value.toDate === "function") {
    const converted = value.toDate();
    if (converted instanceof Date && !Number.isNaN(converted.getTime())) {
      return converted;
    }
  }

  if (typeof value === "string") {
    const normalized = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return undefined;
}

function numberOrUndefined(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function inferMissingCoordinates(records: MetadataRecord[], inferenceWindowMinutes: number) {
  const maxDistanceMs = inferenceWindowMinutes * 60 * 1000;

  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    if (current.latitude !== undefined && current.longitude !== undefined) {
      continue;
    }

    const sameDayCandidates = [
      findNearestCoordinateRecord(records, index, -1, current.timestampMs, maxDistanceMs),
      findNearestCoordinateRecord(records, index, 1, current.timestampMs, maxDistanceMs),
    ].filter((candidate): candidate is MetadataRecord => candidate !== undefined);

    sameDayCandidates.sort(
      (left, right) =>
        Math.abs(left.timestampMs - current.timestampMs) - Math.abs(right.timestampMs - current.timestampMs),
    );

    const inferredFrom = sameDayCandidates[0];
    if (!inferredFrom) {
      continue;
    }

    if (sameLocalDate(inferredFrom.capturedAt, current.capturedAt)) {
      current.latitude = inferredFrom.latitude;
      current.longitude = inferredFrom.longitude;
      current.locationSource = "inferred";
    }
  }
}

function findNearestCoordinateRecord(
  records: MetadataRecord[],
  startIndex: number,
  direction: -1 | 1,
  currentTimestampMs: number,
  maxDistanceMs: number,
) {
  for (let index = startIndex + direction; index >= 0 && index < records.length; index += direction) {
    const candidate = records[index];
    const distance = Math.abs(candidate.timestampMs - currentTimestampMs);
    if (distance > maxDistanceMs) {
      return undefined;
    }

    if (candidate.latitude !== undefined && candidate.longitude !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

async function enrichLocations(records: MetadataRecord[], config: Config, cache: CacheFile) {
  const contexts = new Map<string, PlaceContext>();

  for (const record of records) {
    const key = coordinateKey(record.latitude, record.longitude);
    if (!key) {
      continue;
    }

    if (!contexts.has(key)) {
      let reverse: ReverseGeocodeResult | undefined;

      try {
        reverse = await reverseGeocode(record.latitude!, record.longitude!, config, cache);
      } catch (error) {
        console.warn(
          `Location lookup failed for ${record.filePath}: ${String(error)}`,
        );
      }

      const aliasLabel = resolveAlias(record.latitude!, record.longitude!, reverse ?? {}, config.aliases);
      contexts.set(key, {
        aliasLabel,
        latitude: record.latitude,
        longitude: record.longitude,
        reverse,
      });
    }
  }

  return records.map((record) => {
    const key = coordinateKey(record.latitude, record.longitude);
    const context = key ? contexts.get(key) : undefined;
    return { record, context: context ?? {} };
  });
}

function coordinateKey(latitude?: number, longitude?: number) {
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }

  return `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
}

async function reverseGeocode(
  latitude: number,
  longitude: number,
  config: Config,
  cache: CacheFile,
): Promise<ReverseGeocodeResult> {
  const key = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const cached = cache.reverseGeocode[key];
  if (cached) {
    return cached;
  }

  await sleep(config.geocoding.rateLimitMs);

  const reverseUrl = new URL("https://nominatim.openstreetmap.org/reverse");
  reverseUrl.searchParams.set("lat", String(latitude));
  reverseUrl.searchParams.set("lon", String(longitude));
  reverseUrl.searchParams.set("format", "jsonv2");
  reverseUrl.searchParams.set("addressdetails", "1");
  reverseUrl.searchParams.set("namedetails", "1");
  reverseUrl.searchParams.set("zoom", "18");
  reverseUrl.searchParams.set("accept-language", config.geocoding.language);

  const reverseResponse = await fetch(reverseUrl, {
    headers: {
      "User-Agent": config.geocoding.userAgent,
    },
  });

  if (!reverseResponse.ok) {
    throw new Error(`Reverse geocode failed with status ${reverseResponse.status}.`);
  }

  const reverseJson = (await reverseResponse.json()) as {
    display_name?: string;
    address?: Record<string, string>;
    namedetails?: Record<string, string>;
  };

  const nearbyFeatures = await fetchNearbyFeatures(latitude, longitude, config);
  const result: ReverseGeocodeResult = {
    displayName: reverseJson.display_name,
    address: reverseJson.address,
    namedetails: reverseJson.namedetails,
    nearbyFeatures,
  };

  cache.reverseGeocode[key] = result;
  return result;
}

async function fetchNearbyFeatures(latitude: number, longitude: number, config: Config) {
  const query = `
[out:json][timeout:25];
(
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["leisure"="park"];
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["boundary"="national_park"];
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["tourism"];
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["historic"];
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["natural"];
  nwr(around:${config.geocoding.nearbyRadiusMeters},${latitude},${longitude})["name"]["amenity"];
);
out center tags;
`.trim();

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": config.geocoding.userAgent,
    },
    body: query,
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    elements?: Array<{ tags?: Record<string, string> }>;
  };

  const values = new Set<string>();
  for (const element of payload.elements ?? []) {
    const name = element.tags?.name;
    if (name) {
      values.add(name);
    }
  }

  return Array.from(values).slice(0, config.geocoding.nearbyLimit);
}

function resolveAlias(
  latitude: number,
  longitude: number,
  reverse: Partial<ReverseGeocodeResult>,
  aliases: AliasRule[],
) {
  const haystack = [
    reverse.displayName,
    ...Object.values(reverse.address ?? {}),
    ...Object.values(reverse.namedetails ?? {}),
    ...(reverse.nearbyFeatures ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  for (const alias of aliases) {
    const coordinateMatch = alias.coordinates
      ? distanceMeters(latitude, longitude, alias.coordinates.latitude, alias.coordinates.longitude) <=
        alias.coordinates.radiusMeters
      : false;

    const addressMatch =
      alias.addressContains?.some((fragment) => haystack.includes(fragment.toLowerCase())) ?? false;

    if (coordinateMatch || addressMatch) {
      return alias.label;
    }
  }

  return undefined;
}

function buildGroups(enriched: Array<{ record: MetadataRecord; context: PlaceContext }>) {
  const groups = new Map<string, SortGroup>();

  for (const item of enriched) {
    const dateKey = localDateKey(item.record.capturedAt);
    const year = dateKey.slice(0, 4);
    const monthDay = `${dateKey.slice(5, 7)}-${dateKey.slice(8, 10)}`;
    const locationKey = buildLocationKey(item.context);
    const key = `${dateKey}__${locationKey}`;
    const existing = groups.get(key);

    if (existing) {
      existing.files.push(item.record);
      continue;
    }

    groups.set(key, {
      key,
      dateKey,
      year,
      monthDay,
      context: item.context,
      files: [item.record],
    });
  }

  return Array.from(groups.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function buildLocationKey(context: PlaceContext) {
  if (context.aliasLabel) {
    return `alias:${context.aliasLabel}`;
  }

  if (context.latitude !== undefined && context.longitude !== undefined) {
    return `coord:${context.latitude.toFixed(3)},${context.longitude.toFixed(3)}`;
  }

  return "unknown";
}

async function labelGroups(
  groups: SortGroup[],
  config: Config,
  cache: CacheFile,
  openaiClient: OpenAI | undefined,
) {
  const labeled: LabeledGroup[] = [];

  for (const group of groups) {
    const decision = await choosePlaceLabel(group, config, cache, openaiClient);
    labeled.push({
      ...group,
      placeLabel: decision.label,
      folderName: `${group.monthDay}_${slugifyPlace(decision.label)}`,
      decision,
    });
  }

  return labeled;
}

async function choosePlaceLabel(
  group: SortGroup,
  config: Config,
  cache: CacheFile,
  openaiClient: OpenAI | undefined,
): Promise<PlaceLabelDecision> {
  if (group.context.aliasLabel) {
    return {
      label: group.context.aliasLabel,
      strategy: "alias",
      reason: `Matched alias "${group.context.aliasLabel}" from configured location rules.`,
    };
  }

  const cacheKey = JSON.stringify({
    reverse: group.context.reverse,
    day: group.dateKey,
  });
  const cachedDecision = normalizeCachedDecision(cache.aiPlaceLabels[cacheKey]);
  if (cachedDecision) {
    return {
      ...cachedDecision,
      strategy: "cache",
      reason: `Reused cached label "${cachedDecision.label}" from a previous run.`,
    };
  }

  const reverse = group.context.reverse;
  const deterministicFallback = fallbackPlaceLabel(group.context);
  if (!config.openai.enabled || !openaiClient || !reverse) {
    const decision = {
      label: deterministicFallback,
      strategy: "fallback" as const,
      reason: buildFallbackReason(group.context, !config.openai.enabled || !openaiClient),
    };
    cache.aiPlaceLabels[cacheKey] = decision;
    return decision;
  }

  try {
    const response = await openaiClient.responses.parse({
      model: config.openai.model,
      input: [
        {
          role: "system",
          content:
            "You name family photo folders. Return a short place label only. Prefer a park, venue, neighborhood, alias-like home label, or well-known place. Avoid street numbers unless nothing else is meaningful. Use 1 to 4 words.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              date: group.dateKey,
              reverseDisplayName: reverse.displayName,
              address: reverse.address,
              nearbyFeatures: reverse.nearbyFeatures,
              nameDetails: reverse.namedetails,
              sampleFiles: group.files.slice(0, 6).map((file) => file.fileName),
            },
            null,
            2,
          ),
        },
      ],
      text: {
        format: zodTextFormat(placeLabelSchema, "photo_place_label"),
      },
    });

    const parsed = response.output_parsed;
    const label = parsed?.placeLabel?.trim() || deterministicFallback;
    const decision = {
      label,
      strategy: "openai" as const,
      reason: buildOpenAIReason(group.context, label),
    };
    cache.aiPlaceLabels[cacheKey] = decision;
    return decision;
  } catch (error) {
    console.warn(`OpenAI labeling failed for ${group.key}: ${String(error)}`);
    const decision = {
      label: deterministicFallback,
      strategy: "fallback" as const,
      reason: `${buildFallbackReason(group.context, false)} OpenAI labeling failed, so the fallback label was used.`,
    };
    cache.aiPlaceLabels[cacheKey] = decision;
    return decision;
  }
}

function normalizeCachedDecision(value: string | PlaceLabelDecision | undefined): PlaceLabelDecision | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return {
      label: value,
      strategy: "cache",
      reason: `Reused cached label "${value}" from a previous run.`,
    };
  }

  return value;
}

function fallbackPlaceLabel(context: PlaceContext) {
  const address = context.reverse?.address ?? {};
  return (
    address.park ||
    address.attraction ||
    address.neighbourhood ||
    address.suburb ||
    address.city ||
    address.town ||
    address.village ||
    context.reverse?.nearbyFeatures[0] ||
    "Unknown_Place"
  );
}

function slugifyPlace(value: string) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1));

  return (parts.join("_") || "Unknown_Place").replace(/_+/g, "_");
}

function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sameLocalDate(left: Date, right: Date) {
  return localDateKey(left) === localDateKey(right);
}

function buildOpenAIClient(config: Config) {
  if (!config.openai.enabled) {
    return undefined;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Falling back to deterministic place labels.");
    return undefined;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function materializeGroups(
  groups: LabeledGroup[],
  config: Config,
) {
  for (const group of groups) {
    const directory = path.join(config.outputRoot, group.year, group.folderName);
    await fs.mkdir(directory, { recursive: true });
    await writeFolderMetadata(directory, group);

    for (const file of group.files) {
      const targetPath = await uniqueTargetPath(directory, file.fileName);
      await placeFile(file.filePath, targetPath, config.mode);
    }
  }
}

async function uniqueTargetPath(directory: string, fileName: string) {
  const parsed = path.parse(fileName);
  let attempt = 0;

  while (true) {
    const candidateName =
      attempt === 0 ? fileName : `${parsed.name}__${attempt}${parsed.ext}`;
    const candidatePath = path.join(directory, candidateName);

    try {
      await fs.access(candidatePath);
      attempt += 1;
    } catch {
      return candidatePath;
    }
  }
}

async function placeFile(sourcePath: string, targetPath: string, mode: SortMode) {
  if (mode === "copy") {
    await fs.copyFile(sourcePath, targetPath);
    return;
  }

  if (mode === "move") {
    await fs.rename(sourcePath, targetPath);
    return;
  }

  await fs.link(sourcePath, targetPath);
}

function printPlan(groups: LabeledGroup[], duplicates: DuplicateFileRecord[], config: Config) {
  console.log(`Target root: ${config.outputRoot}`);
  console.log(`Dry run plan for ${groups.length} folder groups:`);

  for (const group of groups) {
    const directory = path.join(config.outputRoot, group.year, group.folderName);
    console.log("");
    console.log(`${directory}`);
    console.log(`Folder label: ${group.placeLabel}`);
    console.log(`Reason: ${group.decision.reason}`);

    for (const file of group.files) {
      const targetPath = path.join(directory, file.fileName);
      const coordinateSummary =
        file.latitude !== undefined && file.longitude !== undefined
          ? `${file.latitude.toFixed(5)}, ${file.longitude.toFixed(5)}`
          : "none";
      const fileReasoning = buildFileReasoning(file, group);

      console.log(`- source: ${file.filePath}`);
      console.log(`  target: ${targetPath}`);
      console.log(`  capturedAt: ${file.capturedAt.toISOString()}`);
      console.log(`  captureSource: ${file.capturedAtSource}`);
      console.log(`  coordinates: ${coordinateSummary}`);
      console.log(`  locationSource: ${file.locationSource}`);
      console.log(`  reasoning: ${fileReasoning}`);
    }
  }

  if (duplicates.length > 0) {
    console.log("");
    console.log(`Skipped duplicates: ${duplicates.length}`);
    for (const duplicate of duplicates) {
      console.log(`- source: ${duplicate.filePath}`);
      console.log(`  duplicateOf: ${duplicate.duplicateOf}`);
      console.log(`  sizeBytes: ${duplicate.sizeBytes}`);
      console.log(`  reasoning: Skipped as an exact duplicate based on identical file size and SHA-256 hash ${duplicate.contentHash.slice(0, 12)}.`);
    }
  }
}

async function writeFolderMetadata(directory: string, group: LabeledGroup) {
  const metadataPath = path.join(directory, FOLDER_METADATA_FILE_NAME);
  const payload = {
    generatedAt: new Date().toISOString(),
    folderName: group.folderName,
    placeLabel: group.placeLabel,
    date: group.dateKey,
    fileCount: group.files.length,
    namingDecision: group.decision,
    geolocation: {
      aliasLabel: group.context.aliasLabel,
      latitude: group.context.latitude,
      longitude: group.context.longitude,
      reverseGeocode: group.context.reverse,
    },
    sampleFiles: group.files.slice(0, 10).map((file) => file.fileName),
  };

  await fs.writeFile(metadataPath, JSON.stringify(payload, null, 2));
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>,
) {
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function loadCache(cachePath: string, fallbackCachePath?: string): Promise<CacheFile> {
  const primary = await readCacheFile(cachePath);
  if (primary) {
    return primary;
  }

  if (fallbackCachePath && fallbackCachePath !== cachePath) {
    const fallback = await readCacheFile(fallbackCachePath);
    if (fallback) {
      return fallback;
    }
  }

  return {
    reverseGeocode: {},
    aiPlaceLabels: {},
    fileHashes: {},
  };
}

async function saveCache(cachePath: string, cache: CacheFile) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
}

async function readCacheFile(cachePath: string): Promise<CacheFile | undefined> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return normalizeCache(JSON.parse(raw) as Partial<CacheFile>);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function normalizeCache(cache: Partial<CacheFile>): CacheFile {
  return {
    reverseGeocode: cache.reverseGeocode ?? {},
    aiPlaceLabels: cache.aiPlaceLabels ?? {},
    fileHashes: cache.fileHashes ?? {},
  };
}

function buildFileReasoning(file: MetadataRecord, group: LabeledGroup) {
  const locationReason =
    file.locationSource === "embedded"
      ? "used GPS embedded in this file"
      : file.locationSource === "inferred"
        ? `used GPS inferred from nearby media taken on the same day within ${group.files.length > 1 ? "the grouped event window" : "the inference window"}`
        : "had no usable GPS, so the folder location came from the group-level fallback";

  return `Used ${file.capturedAtSource} as the capture timestamp; ${locationReason}; folder named "${group.placeLabel}" because ${group.decision.reason}`;
}

function buildFallbackReason(context: PlaceContext, missingOpenAI: boolean) {
  const fallback = fallbackPlaceLabel(context);
  const prefix = missingOpenAI
    ? "OpenAI labeling was unavailable."
    : "No alias matched, so a deterministic location fallback was used.";
  return `${prefix} The folder was named from nearby reverse-geocode data as "${fallback}".`;
}

function buildOpenAIReason(context: PlaceContext, label: string) {
  const nearby = context.reverse?.nearbyFeatures?.slice(0, 3).join(", ");
  const displayName = context.reverse?.displayName;
  const supportingContext = [displayName, nearby].filter(Boolean).join(" | ");
  return supportingContext
    ? `OpenAI selected "${label}" using reverse-geocode context: ${supportingContext}.`
    : `OpenAI selected "${label}" using the available reverse-geocode context.`;
}

function isMissingFileError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthRadiusMeters = 6371000;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degreesToRadians(lat1)) *
      Math.cos(degreesToRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await exiftool.end();
  });
