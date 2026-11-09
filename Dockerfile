# Build stage
FROM node:22-alpine3.21 AS builder

RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache git

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev

# Production stage
FROM node:22-alpine3.21

RUN apk update && apk upgrade --no-cache && \
    mkdir -p /data /app && \
    chown -R node:node /data /app

WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

ENV NODE_ENV=production
ENV GTFS_MCP_CONFIG=/config/config.json
ENV PORT=3000
ENV HOST=0.0.0.0

USER node

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
