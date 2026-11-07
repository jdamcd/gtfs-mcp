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
  serveStdio(() => createServer(config));

  console.error("[gtfs-mcp] Server started on stdio transport");
  void preWarmDatabases(config);
}

main().catch((error) => {
  console.error("[gtfs-mcp] Fatal error:", error);
  process.exit(1);
});
