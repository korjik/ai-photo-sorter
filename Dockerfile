FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY ai-photo-sorter.config.example.json ./
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

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--dry-run"]
