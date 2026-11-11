# CLAUDE.md

## Build and test

```bash
npm run build                                           # tsc → dist/
npm test                                                # vitest, all tests
npx vitest run test/integration.test.ts                 # one file
GTFS_MCP_CONFIG=./config.mta.json npm start             # stdio
GTFS_MCP_CONFIG=./config.mta.json npm run start:http    # Streamable HTTP on 127.0.0.1:3000
```

CI runs build + test on Node 22 and 24.

## Architecture

An MCP server exposing GTFS transit data as tools, over stdio or Streamable HTTP (`--http` or `GTFS_MCP_TRANSPORT=http`). It uses the SDK 2.x packages (`@modelcontextprotocol/server` and `/node`; `/client` in tests only), which serve the 2026-07-28 protocol revision and 2025-era clients from one server factory.

`createServer(config)` in `src/server.ts` is that factory: `serveStdio` (`src/index.ts`) calls it once per connection, `createMcpHandler` (`src/http.ts`) once per request. HTTP serving is stateless, and `src/http.ts` does its own Origin/Host checks and body cap because the SDK handler does neither. Anything that must outlive a request (schedule DB, import lock, feed cache) lives at module scope in `src/gtfs/`, not on the server instance.

- **Static GTFS** (`src/gtfs/static.ts`): the `gtfs` package imports each system's schedule into `data_dir/{system_id}/gtfs.db`, at startup per `pre_warm_database`. A stale DB keeps serving while a background refresh imports into a scratch file and renames it over.
- **GTFS-RT** (`src/gtfs/realtime.ts`): feeds fetched on demand, in parallel across a type's URLs, with a 30-second cache.
- **Tools** (`src/tools/`; `src/resources/` and `src/prompts/` work the same way): each file exports a `register*` function taking the shared `ToolContext`. Tools get the DB through `getReadyDb()` and query it with the raw SQL in `src/gtfs/queries.ts`. Each declares `outputSchema: portableOutputSchema(ZodSchema)` and returns `jsonResponse(data)`. The SDK validates `structuredContent` against a JSON Schema with `additionalProperties: false`, so a field added to a response but not to its schema fails the call.
- **Config** (`src/config.ts`): Zod-validated JSON at `GTFS_MCP_CONFIG`. `GTFS_MCP_DATA_DIR` overrides `data_dir`.

## Docker image

- `.dockerignore` excludes most of the repo and the build stage copies only `package*.json`, `tsconfig.json` and `src/`, so a new file the server needs at runtime has to be added to both. `package.json` stays in the runtime stage because `src/server.ts` reads the version from it.
- The image sets `HOST=0.0.0.0` (the code defaults to `127.0.0.1`), `GTFS_MCP_DATA_DIR=/data` and `GTFS_MCP_CONFIG=/config/config.json`.
- `docker-publish.yml` builds on every PR and push to `main`, and publishes only on a `v*` tag or a manual dispatch. arm64 builds on a native runner. No QEMU: `npm ci` under emulation hung, which is also why there's no `linux/arm/v7` build.
- To release: bump `version` in `package.json` and push a matching `vX.Y.Z` tag. That publishes `X.Y.Z`, `X.Y` and `latest`, then creates the GitHub Release with generated notes. A manual dispatch publishes only a `sha-…` tag, for trying an unreleased build.
- Nothing tests the image. After a Dockerfile change, `docker build -t gtfs-mcp .` and check a stdio session and an HTTP `initialize` against it.

## Testing

`test/integration.test.ts` is the main test. It imports a fixture GTFS ZIP (built by `test/fixtures/create-gtfs-zip.ts`), mocks `src/gtfs/static.ts` and `fetch` (protobuf fixtures from `test/helpers.ts`), and runs every tool through `InMemoryTransport`. `vi.mock("../src/gtfs/static.js")` must come before importing `createServer` because of mock hoisting.

`InMemoryTransport` only connects 2025-era instances, so `test/http.test.ts` is the only coverage of the 2026-07-28 path: it runs every tool test with a default client and with `versionNegotiation: { mode: "auto" }`.

## Evals

promptfoo checks that models pick the right tools for transit questions (`promptfooconfig.yaml`). Needs `ANTHROPIC_API_KEY` and `GTFS_MCP_CONFIG` in `.env`.

```bash
npm run build && npm run eval:smoke   # evals run against dist/; one pass on Haiku
npm run eval                          # Haiku/Sonnet/Opus 5.5 × 3 repeats, then a summary
npm run eval:summary                  # re-print the summary of evals/results/latest.json
```

- promptfoo runs the full tool loop against the real server with `config.mta.json`, so tools hit live MTA data: assert on the calls, not on what they return.
- `evals/tool-calls.js` grades the calls in `response.metadata.toolCalls` against each case's `metadata.expect`. Don't grade the output text: it can name a tool the model never called. A required call only counts if it uses the system in `defaultTest.metadata.system`.
- `evals/run.js` prints the summary even when cases fail, and exits with promptfoo's status (100 when any case fails).
- promptfoo isn't a devDependency: `run.js` and the `eval:view` script pin its `npx` version, so bump both together.
- `evals/summarize.js` has its own price table, since promptfoo has none for the 5.5 models. It and `tool-calls.js` are unit-tested in `test/eval-assertions.test.ts`.
- The eval system prompt doesn't name the system, and promptfoo doesn't pass the server's `instructions` to the model, so evals only test what the tool descriptions get across.
