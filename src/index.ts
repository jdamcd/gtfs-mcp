#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
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
