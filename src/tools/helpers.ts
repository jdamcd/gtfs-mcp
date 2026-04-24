import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SystemConfig } from "../config.js";
import { ensureGtfsLoaded, getDb } from "../gtfs/static.js";

export interface ToolContext {
  server: McpServer;
  systems: Map<string, SystemConfig>;
  dataDir: string;
  refreshHours: number;
}

export function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function textResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

export function errorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function resolveSystem(
  systems: Map<string, SystemConfig>,
  id: string
): SystemConfig | null {
  return systems.get(id) ?? null;
}

export function unknownSystemResponse(
  id: string,
  systems: Map<string, SystemConfig>
) {
  const available = Array.from(systems.keys()).sort().join(", ") || "none";
  return errorResponse(`Unknown system: ${id}. Available: ${available}.`);
}

export async function getReadyDb(
  system: SystemConfig,
  dataDir: string,
  refreshHours: number
) {
  await ensureGtfsLoaded(system, dataDir, refreshHours);
  return getDb(system, dataDir);
}
