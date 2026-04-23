FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY photo-sorter.config.example.json ./
RUN npx tsc -p tsconfig.json

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends perl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/photo-sorter.config.example.json ./photo-sorter.config.example.json

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "photo-sorter.config.example.json", "--dry-run"]
