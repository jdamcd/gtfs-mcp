# Build stage
FROM node:22-alpine AS builder

RUN apk upgrade --no-cache

WORKDIR /app

COPY package*.json tsconfig.json ./
# No install scripts: npm would run node-gyp for better-sqlite3, which needs
# Python, though its prebuilt binary already ships in the package.
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev

# better-sqlite3 ships a binary for every platform and the SQLite source.
# Keep the one binary this image loads; the last line fails the build if
# that went wrong.
RUN cd node_modules/better-sqlite3 && \
    keep="$(basename "$(node -p "require('./lib/binding.js').getPrebuildPath()")")" && \
    find prebuilds -type f ! -name "$keep" -delete && \
    rm -rf deps src && \
    node -e "new (require('better-sqlite3'))(':memory:')"

# Production stage
FROM node:22-alpine

RUN apk upgrade --no-cache && \
    mkdir -p /data /app && \
    chown -R node:node /data /app

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

ENV NODE_ENV=production
ENV GTFS_MCP_CONFIG=/config/config.json
ENV GTFS_MCP_DATA_DIR=/data
ENV PORT=3000
ENV HOST=0.0.0.0

USER node

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
