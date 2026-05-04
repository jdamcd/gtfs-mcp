import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, SystemConfig } from "./config.js";
import { registerStopTools } from "./tools/stops.js";
import { registerRouteTools } from "./tools/routes.js";
import { registerArrivalTools } from "./tools/arrivals.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerVehicleTools } from "./tools/vehicles.js";
import { registerTripTools } from "./tools/trips.js";
import { registerStatusTools } from "./tools/status.js";
import { jsonResponse } from "./tools/helpers.js";
import type { ToolContext } from "./tools/helpers.js";

export function createServer(config: AppConfig): McpServer {
  const server = new McpServer(
    {
      name: "gtfs-mcp",
      version: "1.0.0",
    },
    {
      instructions:
        "Resolve identifiers via the discovery tools before calling tools that take them: list_systems for system, search_stops or find_nearby_stops for stop_id, list_routes for route_id. Do not guess these IDs — guessed values will fail. Use the tools to answer transit queries; do not rely on prior knowledge of specific networks.",
    }
  );

  const systems = new Map<string, SystemConfig>();
  for (const system of config.systems) {
    systems.set(system.id, system);
  }

  const ctx: ToolContext = {
    server,
    systems,
    dataDir: config.data_dir,
    refreshHours: config.schedule_refresh_hours,
  };

  // Register list_systems tool
  server.registerTool(
    "list_systems",
    {
      title: "List transit systems",
      description:
        "List configured transit systems and their IDs. Call this first when the user hasn't specified a system, or to discover valid `system` values for other tools.",
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      jsonResponse(config.systems.map((s) => ({ id: s.id, name: s.name })))
  );

  // Register all tool groups
  registerStopTools(ctx);
  registerRouteTools(ctx);
  registerArrivalTools(ctx);
  registerAlertTools(ctx);
  registerVehicleTools(ctx);
  registerTripTools(ctx);
  registerStatusTools(ctx);

  return server;
}
