# Synology NAS Setup

This guide installs `ai-photo-sorter` on a Synology NAS using the published Docker image:

```text
andrewkozhokaru/ai-photo-sorter
```

The container requires two mounts:

- your photo library mounted at `/photo`
- a config folder mounted at `/config`, containing `ai-photo-sorter.config.json`

The image does not include your private config.

## Prerequisites

- Synology DSM with Container Manager installed
- A shared photo folder, usually `/volume1/photo`
- Network access from the NAS for reverse geocoding and optional OpenAI labeling
- An OpenAI API key if `openai.enabled` is `true`

## Folder Layout

Create a config folder on the NAS:

```text
/volume1/docker/ai-photo-sorter/
```

Place this file inside it:

```text
/volume1/docker/ai-photo-sorter/ai-photo-sorter.config.json
```

Use `/photo` paths inside the config because the container sees your photo share at `/photo`:

```json
{
  "sourceRoots": [
    "/photo/Unsorted/Andrew",
    "/photo/Unsorted/Nina"
  ],
  "outputRoot": "/photo/AI-sorted",
  "mode": "hardlink",
  "inferenceWindowMinutes": 90,
  "supportedExtensions": [".heic", ".jpg", ".jpeg", ".png", ".mov", ".mp4"],
  "ignoreFolders": ["@eaDir"],
  "labelRewrites": [],
  "openai": {
    "enabled": true,
    "model": "gpt-5-mini"
  },
  "geocoding": {
    "provider": "nominatim",
    "userAgent": "ai-photo-sorter/1.0",
    "language": "en",
    "rateLimitMs": 1100,
    "nearbyRadiusMeters": 800,
    "nearbyLimit": 8
  },
  "aliases": []
}
```

## Install with Container Manager

1. Open **Container Manager**.
2. Go to **Registry**.
3. Search for:

   ```text
   andrewkozhokaru/ai-photo-sorter
   ```

4. Download the `latest` tag.
5. Go to **Image**, select `andrewkozhokaru/ai-photo-sorter:latest`, then choose **Run**.
6. Name the container, for example:

   ```text
   ai-photo-sorter
   ```

7. Configure volume mappings:

   ```text
   /volume1/photo                    -> /photo
   /volume1/docker/ai-photo-sorter   -> /config
   ```

8. Configure environment variables:

   ```text
   PHOTO_ROOT=/photo
   SOURCE_ROOTS=Unsorted/Andrew:Unsorted/Nina
   DESTINATION=AI-sorted
   OPENAI_API_KEY=your_api_key_here
   ```

   `OPENAI_API_KEY` is optional if OpenAI labeling is disabled in the config.

9. Configure the command for a dry run:

   ```text
   --dry-run
   ```

10. Start the container and inspect the logs.

The logs should include:

```text
Loaded config: /config/ai-photo-sorter.config.json
```

## Run a Dry Run over SSH

Enable SSH in DSM if needed, then connect to the NAS and run:

```bash
docker run --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e PHOTO_ROOT="/photo" \
  -e SOURCE_ROOTS="Unsorted/Andrew:Unsorted/Nina" \
  -e DESTINATION="AI-sorted" \
  -v /volume1/photo:/photo \
  -v /volume1/docker/ai-photo-sorter:/config:ro \
  andrewkozhokaru/ai-photo-sorter:latest --dry-run
```

Process only a sample:

```bash
docker run --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e PHOTO_ROOT="/photo" \
  -e SOURCE_ROOTS="Unsorted/Andrew:Unsorted/Nina" \
  -e DESTINATION="AI-sorted" \
  -v /volume1/photo:/photo \
  -v /volume1/docker/ai-photo-sorter:/config:ro \
  andrewkozhokaru/ai-photo-sorter:latest --dry-run --limit 100
```

## Execute Sorting

After reviewing dry-run output, run with `--execute`:

```bash
docker run --rm \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e PHOTO_ROOT="/photo" \
  -e SOURCE_ROOTS="Unsorted/Andrew:Unsorted/Nina" \
  -e DESTINATION="AI-sorted" \
  -v /volume1/photo:/photo \
  -v /volume1/docker/ai-photo-sorter:/config:ro \
  andrewkozhokaru/ai-photo-sorter:latest --execute
```

With `mode: "hardlink"`, original files stay in place and hard links are created under:

```text
/volume1/photo/AI-sorted/
```

## Updating

Pull the latest image:

```bash
docker pull andrewkozhokaru/ai-photo-sorter:latest
```

Then recreate the container with the same mounts, environment variables, and command.

## Troubleshooting

If the container exits with:

```text
Config file not found at /config/ai-photo-sorter.config.json
```

check that:

- `/volume1/docker/ai-photo-sorter/ai-photo-sorter.config.json` exists
- `/volume1/docker/ai-photo-sorter` is mounted to `/config`
- the config filename is exactly `ai-photo-sorter.config.json`

If no media is found:

- confirm `SOURCE_ROOTS` paths are relative to `/photo`
- confirm the folders exist under `/volume1/photo`
- confirm your file extensions are listed in `supportedExtensions`

If Synology thumbnail files are included:

- keep `@eaDir` in `ignoreFolders`

If output folders are not created:

- confirm you used `--execute`
- confirm the container has write permission to `/volume1/photo`
- try `mode: "copy"` if hard links are not supported for your volume setup
