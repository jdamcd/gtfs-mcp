#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { preWarmDatabases } from "./gtfs/static.js";

const useHttp =
  process.argv.includes("--http") ||
  process.env.GTFS_MCP_TRANSPORT === "http";

async function main(): Promise<void> {
  if (useHttp) {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer();
    return;
  }

  const config = loadConfig();

  console.error(
    `[gtfs-mcp] Loaded config with ${config.systems.length} system(s): ${config.systems.map((s) => s.id).join(", ")}`
  );

  // One factory answers both the 2025-era initialize and the 2026-07-28 discover.
  const handle = serveStdio(() => createServer(config));

  console.error("[gtfs-mcp] Server started on stdio transport");
  void preWarmDatabases(config);

  // As PID 1 in a container, node ignores signals it has no handler for, so
  // without these `docker stop` waits out its grace period and kills the process.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[gtfs-mcp] Received ${signal}, shutting down...`);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[gtfs-mcp] Fatal error:", error);
  process.exit(1);
});
