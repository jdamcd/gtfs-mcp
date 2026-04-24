import { z } from "zod";
import { listRoutes, getRouteDetails } from "../gtfs/queries.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  errorResponse,
  getReadyDb,
} from "./helpers.js";

export function registerRouteTools(ctx: ToolContext): void {
  ctx.server.tool(
    "list_routes",
    "List routes in a transit system. For large feeds (1000+ routes), filter with `query` (substring match on short/long name or route_id) or `route_type`. Returns `total` so the caller can tell when results are truncated.",
    {
      system: z.string().describe("System ID"),
      query: z
        .string()
        .optional()
        .describe("Substring match (case-insensitive) on short_name, long_name, or route_id"),
      route_type: z
        .number()
        .optional()
        .describe(
          "Filter by GTFS route_type: 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, 5=cable, 6=gondola, 7=funicular, or extended types 100-1700"
        ),
      limit: z
        .number()
        .default(100)
        .describe("Maximum number of routes to return (default 100)"),
      offset: z
        .number()
        .default(0)
        .describe("Pagination offset"),
    },
    async ({ system, query, route_type, limit, offset }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const { routes, total } = listRoutes(db, {
        routeType: route_type,
        query,
        limit,
        offset,
      });

      return jsonResponse({
        total,
        routes: routes.map((r) => ({
          route_id: r.route_id,
          short_name: r.route_short_name,
          long_name: r.route_long_name,
          type: r.route_type,
        })),
      });
    }
  );

  ctx.server.tool(
    "get_route",
    "Get a route and an ordered stop list. The stop list is drawn from the route's longest trip variant in the given direction; routes with branches may have service patterns that skip some stops — use get_trip for a specific trip's actual sequence. Pass route_id from list_routes; if only a human name is known, search with list_routes first.",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().describe("Route ID, from list_routes"),
      direction_id: z
        .number()
        .optional()
        .describe("Agency-defined direction 0 or 1 (semantics vary — call without this to see both)"),
    },
    async ({ system, route_id, direction_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const details = getRouteDetails(db, route_id, direction_id);

      if (!details.route) {
        return errorResponse(
          `Route not found: ${route_id}. Use list_routes to discover valid route_ids.`
        );
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
