# Photo Sorter

`photo-sorter` scans unsorted photo and video folders, groups media by capture date and place, and writes the result into a date-and-location hierarchy such as:

```text
AI-sorted/2025/01_12_Bear_Valley
```

It uses local metadata first, then location lookup, then configurable aliases, and optionally OpenAI to produce short human-friendly place labels.

## Features

- Reads capture timestamps from photo and video metadata
- Uses GPS metadata when present
- Infers missing GPS from nearby same-day media within a configurable time window
- Reverse-geocodes coordinates and looks up nearby named places
- Supports configurable aliases such as `Home`, `Cabin`, `Office`, or `School`
- Uses OpenAI to choose concise folder labels when enabled
- Deduplicates exact duplicate files across multiple source roots
- Writes folder-level provenance into hidden `.ai-sorted` files
- Stores reusable caches in the destination root so repeated runs avoid repeated location work
- Supports local execution, Docker, and Docker Compose

## How It Works

For each run, the sorter:

1. Collects supported media files from `sourceRoots`
2. Deduplicates exact duplicates using file size and SHA-256
3. Reads EXIF / media metadata for timestamps and GPS
4. Infers missing GPS from nearby same-day files when possible
5. Reverse-geocodes locations and checks configured aliases
6. Groups files by day and location context
7. Chooses a folder label from:
   - alias match
   - cached label
   - OpenAI
   - deterministic fallback
8. Either prints a dry-run plan or writes files into the destination tree

## Requirements

- Node.js 20+
- `OPENAI_API_KEY` if you want AI-generated place labels
- Network access for reverse geocoding and OpenAI
- Docker Desktop if running in Docker on macOS

## Project Files

- [src/index.ts](/Users/andrew.kozhokaru/Documents/photo-sorter/src/index.ts:1): main CLI and sorting logic
- [photo-sorter.config.example.json](/Users/andrew.kozhokaru/Documents/photo-sorter/photo-sorter.config.example.json:1): sample config
- [photo-sorter.config.json](/Users/andrew.kozhokaru/Documents/photo-sorter/photo-sorter.config.json:1): local runtime config
- [Dockerfile](/Users/andrew.kozhokaru/Documents/photo-sorter/Dockerfile:1): container image
- [compose.yaml](/Users/andrew.kozhokaru/Documents/photo-sorter/compose.yaml:1): Docker Compose service

## Configuration

Create your local config:

```bash
cp photo-sorter.config.example.json photo-sorter.config.json
```

Main config fields:

- `sourceRoots`: absolute source directories when running locally
- `outputRoot`: absolute destination directory when running locally
- `mode`: `hardlink`, `copy`, or `move`
- `inferenceWindowMinutes`: how far to look for nearby media when inferring missing GPS
- `supportedExtensions`: file types to scan
- `openai.enabled`: enable or disable AI place naming
- `openai.model`: OpenAI model name
- `geocoding.*`: reverse-geocoding and nearby-place lookup settings
- `aliases`: named location rules

Example:

```json
{
  "sourceRoots": [
    "/path/to/photo-root/Unsorted/SourceA",
    "/path/to/photo-root/Unsorted/SourceB"
  ],
  "outputRoot": "/path/to/photo-root/AI-sorted",
  "mode": "hardlink",
  "inferenceWindowMinutes": 90,
  "supportedExtensions": [".heic", ".jpg", ".jpeg", ".png", ".mov", ".mp4"],
  "openai": {
    "enabled": true,
    "model": "gpt-5-mini"
  },
  "geocoding": {
    "provider": "nominatim",
    "userAgent": "photo-sorter/1.0",
    "language": "en",
    "rateLimitMs": 1100,
    "nearbyRadiusMeters": 800,
    "nearbyLimit": 8
  },
  "aliases": [
    {
      "label": "Home",
      "coordinates": {
        "latitude": 37.000001,
        "longitude": -122.000001,
        "radiusMeters": 300
      },
      "addressContains": ["123 Example Street", "Example City"]
    }
  ]
}
```

## Alias Resolution

Aliases can match by:

- coordinate radius
- address text fragments
- both

When both the destination-local alias file and the main config define the same alias label, the main config wins.

## Output Structure

The sorter creates output like:

```text
<DESTINATION>/2025/01_12_Bear_Valley/
```

Each created folder also contains:

```text
.ai-sorted
```

This hidden JSON file stores:

- selected folder label
- naming strategy and reason
- geolocation context
- sample filenames

## Destination Metadata and Caches

The destination root contains two hidden helper files:

```text
<DESTINATION>/photo-sorter-location.config.json
<DESTINATION>/.photo-sorter-cache.json
```

`photo-sorter-location.config.json`:

- is bootstrapped automatically on execute runs if missing
- starts with the `aliases` from your main config
- can be edited with extra destination-specific aliases

`.photo-sorter-cache.json` stores:

- reverse geocode results
- cached place-label decisions
- cached file hashes for deduplication

This lets repeated runs avoid re-resolving the same places and re-hashing unchanged files.

## Deduplication

If multiple source roots contain the same file, the sorter keeps the first file it encounters and skips later exact duplicates.

Duplicates are detected by:

- matching file size
- matching SHA-256 content hash

Dry-run output includes the duplicate source file and the canonical file it matched.

## OpenAI API Key

The sorter reads the OpenAI key from:

```bash
OPENAI_API_KEY
```

Local example:

```bash
export OPENAI_API_KEY="your_api_key_here"
```

If `OPENAI_API_KEY` is not set, the sorter still works and falls back to deterministic place labels.

## Local Usage

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Dry run:

```bash
npx tsx src/index.ts --config photo-sorter.config.json --dry-run
```

Sample only part of the library:

```bash
npx tsx src/index.ts --config photo-sorter.config.json --dry-run --limit 100
```

Execute:

```bash
npx tsx src/index.ts --config photo-sorter.config.json --execute
```

By default, `mode: "hardlink"` keeps the original files in place and creates hard links in the destination tree.

## Dry Run Output

Dry run prints:

- each destination folder that would be created
- each file’s source path and target path
- the capture timestamp used
- which metadata field supplied the timestamp
- whether GPS was embedded, inferred, or missing
- the file-specific reasoning for the chosen folder
- duplicates that were skipped

## Docker

Build the image:

```bash
docker build -t photo-sorter .
```

Run a dry run with runtime-mounted config:

```bash
docker run --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e PHOTO_ROOT="/photo" \
  -e SOURCE_ROOTS="Unsorted/SourceA:Unsorted/SourceB" \
  -e DESTINATION="AI-sorted" \
  -v /absolute/path/to/photo-root:/photo \
  -v "$(pwd)/photo-sorter.config.json:/app/photo-sorter.config.json:ro" \
  photo-sorter --config /app/photo-sorter.config.json --dry-run
```

Execute:

```bash
docker run --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e PHOTO_ROOT="/photo" \
  -e SOURCE_ROOTS="Unsorted/SourceA:Unsorted/SourceB" \
  -e DESTINATION="AI-sorted" \
  -v /absolute/path/to/photo-root:/photo \
  -v "$(pwd)/photo-sorter.config.json:/app/photo-sorter.config.json:ro" \
  photo-sorter --config /app/photo-sorter.config.json --execute
```

Notes:

- `PHOTO_ROOT` defaults to `/photo`
- `SOURCE_ROOTS` is colon-separated
- relative source and destination paths are resolved under `PHOTO_ROOT`
- `photo-sorter.config.json` is not baked into the image

## Docker Compose

The repo includes [compose.yaml](/Users/andrew.kozhokaru/Documents/photo-sorter/compose.yaml:1).

Set environment variables before running Compose:

```bash
export HOST_PHOTO_ROOT="/absolute/path/to/photo-root"
export SOURCE_ROOTS="Unsorted/SourceA:Unsorted/SourceB"
export DESTINATION="AI-sorted"
export OPENAI_API_KEY="your_api_key_here"
```

Dry run:

```bash
docker compose run --rm photo-sorter
```

Execute:

```bash
docker compose run --rm photo-sorter --config /app/photo-sorter.config.json --execute
```

Sample only part of the library:

```bash
docker compose run --rm photo-sorter --config /app/photo-sorter.config.json --dry-run --limit 100
```

Compose mounts:

- your host photo root at `/photo`
- your local `photo-sorter.config.json` into the container at `/app/photo-sorter.config.json`

## Troubleshooting

If Docker on macOS cannot mount your photo root, add that path in Docker Desktop:

```text
Settings -> Resources -> File Sharing
```

If dry run shows fallback labels too often:

- verify media actually contains GPS
- expand `inferenceWindowMinutes`
- add aliases for recurring locations
- confirm `OPENAI_API_KEY` is set if you want AI labels

If too many duplicates are skipped unexpectedly:

- remember dedup is exact-byte based
- dry-run output prints which canonical file each duplicate matched

## Notes

- The sorter prefers metadata timestamps over filesystem timestamps, but will fall back to `FileModifyDate`
- The current location lookup provider is OpenStreetMap Nominatim plus Overpass nearby-place lookup
- The default OpenAI model in the sample config is `gpt-5-mini`

## License

This project is licensed under the MIT License. See [LICENSE](/Users/andrew.kozhokaru/Documents/photo-sorter/LICENSE:1).
