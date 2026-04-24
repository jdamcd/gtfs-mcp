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
  const server = new McpServer({
    name: "gtfs-mcp",
    version: "1.0.0",
  });

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
  server.tool(
    "list_systems",
    "List configured transit systems and their IDs. Call this first when the user hasn't specified a system, or to discover valid `system` values for other tools.",
    {},
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
