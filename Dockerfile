FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY ai-photo-sorter.config.example.json ./
COPY ai-photo-sorter.config.json ./
RUN npx tsc -p tsconfig.json

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends perl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/ai-photo-sorter.config.example.json ./ai-photo-sorter.config.example.json
COPY --from=build /app/ai-photo-sorter.config.json ./ai-photo-sorter.config.json

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "ai-photo-sorter.config.json", "--dry-run"]
