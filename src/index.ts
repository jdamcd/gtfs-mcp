#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

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

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[gtfs-mcp] Server started on stdio transport");
}

main().catch((error) => {
  console.error("[gtfs-mcp] Fatal error:", error);
  process.exit(1);
});
