# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run

```bash
npm install
npm run build          # tsc → dist/
npm test               # vitest run (all tests)
npm run test:watch     # vitest in watch mode
npx vitest run test/integration.test.ts  # single test file
```

Run the server locally:
```bash
GTFS_MCP_CONFIG=./config.mta.json npm start
```

Test with MCP inspector:
```bash
GTFS_MCP_CONFIG=./config.mta.json npx @modelcontextprotocol/inspector node dist/index.js
```

CI runs build + test on Node 18, 20, 22.

## Architecture

This is an MCP (Model Context Protocol) server that exposes GTFS transit data as tools. It uses stdio transport and is designed to run inside Claude Desktop or similar MCP clients.

**Entry flow:** `src/index.ts` loads config → `src/server.ts` creates an `McpServer` and registers tool groups via a shared `ToolContext`.

**Two data sources:**
- **Static GTFS** (`src/gtfs/static.ts`): Downloads GTFS ZIP on first use, imports into a per-system SQLite DB at `data_dir/{system_id}/` using the `gtfs` npm package. Auto-refreshes when DB age exceeds `schedule_refresh_hours`. Deduplicates concurrent imports with a lock map.
- **GTFS-RT** (`src/gtfs/realtime.ts`): Fetches protobuf feeds on demand via `gtfs-realtime-bindings`. 30-second in-memory cache. Multiple feed URLs per type are fetched in parallel and merged.

**Tool registration pattern:** Each file in `src/tools/` exports a `register*Tools(ctx: ToolContext)` function that registers one or more tools on the MCP server. Tools use `getReadyDb()` from `src/tools/helpers.ts` to ensure static data is loaded before querying. Queries live in `src/gtfs/queries.ts` as raw SQL against the SQLite DB.

**Config** (`src/config.ts`): Validated with Zod. Loaded from the JSON file at `GTFS_MCP_CONFIG` env var. Supports multiple transit systems, each with optional auth (header or query param, key read from env var at runtime).

**Auth** (`src/auth.ts`): Applied to both static download and realtime feed URLs.

## Testing

Tests use vitest with `fileParallelism: false`. The integration test (`test/integration.test.ts`) is the main test — it:
- Imports a fixture GTFS ZIP into a temp SQLite DB
- Mocks `src/gtfs/static.ts` so no real download occurs
- Mocks `fetch` to return encoded protobuf test data
- Connects an MCP client to the server via `InMemoryTransport`
- Tests all tools end-to-end

Test helpers in `test/helpers.ts` encode protobuf feed fixtures. The GTFS ZIP fixture is built by `test/fixtures/create-gtfs-zip.ts`.

**Important:** `vi.mock("../src/gtfs/static.js")` must appear before importing `createServer` due to module mock hoisting.
