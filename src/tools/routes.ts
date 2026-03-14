import { z } from "zod";
import { listRoutes, getRouteDetails } from "../gtfs/queries.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  textResponse,
  getReadyDb,
} from "./helpers.js";

export function registerRouteTools(ctx: ToolContext): void {
  ctx.server.tool(
    "list_routes",
    "List all routes in a transit system",
    {
      system: z.string().describe("System ID"),
      route_type: z
        .number()
        .optional()
        .describe(
          "Filter by route type (0=tram, 1=subway, 2=rail, 3=bus, etc.)"
        ),
    },
    async ({ system, route_type }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const routes = listRoutes(db, route_type);

      return jsonResponse(
        routes.map((r) => ({
          route_id: r.route_id,
          short_name: r.route_short_name,
          long_name: r.route_long_name,
          type: r.route_type,
        }))
      );
    }
  );

  ctx.server.tool(
    "get_route",
    "Get details about a specific route including its ordered stop list",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().describe("Route ID"),
      direction_id: z
        .number()
        .optional()
        .describe("Direction ID (0 or 1)"),
    },
    async ({ system, route_id, direction_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const details = getRouteDetails(db, route_id, direction_id);

      if (!details.route) {
        return textResponse(`Route not found: ${route_id}`);
      }

      return jsonResponse({
        route: {
          route_id: details.route.route_id,
          short_name: details.route.route_short_name,
          long_name: details.route.route_long_name,
          type: details.route.route_type,
          color: details.route.route_color,
        },
        stops: details.stops.map((s) => ({
          stop_id: s.stop_id,
          name: s.stop_name,
          lat: s.stop_lat,
          lon: s.stop_lon,
        })),
      });
    }
  );
}
