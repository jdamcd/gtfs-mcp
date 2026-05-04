import { z } from "zod";
import { searchStops, getStopDetails, findStopsNearby } from "../gtfs/queries.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  errorResponse,
  getReadyDb,
} from "./helpers.js";

export function registerStopTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    "search_stops",
    {
      title: "Search stops by name",
      description:
        "Find stops by name (case-insensitive substring on stop_name). Returns parent stations and standalone stops, not child platforms. Use this when the user names a stop; use find_nearby_stops when they give coordinates or 'near me'.",
      inputSchema: {
        system: z.string().describe("System ID"),
        query: z.string().min(1).describe("Case-insensitive substring of stop_name"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Maximum number of results"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ system, query, limit }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const stops = searchStops(db, query, limit);

      return jsonResponse(
        stops.map((s) => ({
          stop_id: s.stop_id,
          name: s.stop_name,
          lat: s.stop_lat,
          lon: s.stop_lon,
        }))
      );
    }
  );

  ctx.server.registerTool(
    "find_nearby_stops",
    {
      title: "Find nearby stops",
      description:
        "Find stops near a latitude/longitude, ordered by distance. Returns parent stations and standalone stops (not child platforms). Requires coordinates — if the user gave a place name, search_stops with that name first to get coordinates.",
      inputSchema: {
        system: z.string().describe("System ID"),
        lat: z
          .number()
          .min(-90)
          .max(90)
          .describe("Latitude in decimal degrees"),
        lon: z
          .number()
          .min(-180)
          .max(180)
          .describe("Longitude in decimal degrees"),
        radius_m: z
          .number()
          .positive()
          .max(50000)
          .default(500)
          .describe("Search radius in meters (max 50000)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Maximum number of results"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ system, lat, lon, radius_m, limit }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const stops = findStopsNearby(db, lat, lon, radius_m, limit);

      return jsonResponse(
        stops.map((s) => ({
          stop_id: s.stop_id,
          name: s.stop_name,
          lat: s.stop_lat,
          lon: s.stop_lon,
          distance_m: s.distance_m,
        }))
      );
    }
  );

  ctx.server.registerTool(
    "get_stop",
    {
      title: "Get stop details",
      description:
        "Get a stop's details and the routes serving it. Accepts any stop_id (parent station, standalone, or child platform). Use search_stops or find_nearby_stops first if only a name is known.",
      inputSchema: {
        system: z.string().describe("System ID"),
        stop_id: z
          .string()
          .describe("Stop ID from search_stops / find_nearby_stops / get_route"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ system, stop_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const details = getStopDetails(db, stop_id);

      if (!details.stop) {
        return errorResponse(
          `Stop not found: ${stop_id}. Use search_stops by name or find_nearby_stops by coordinates to discover valid stop_ids.`
        );
      }

      return jsonResponse({
        stop: {
          stop_id: details.stop.stop_id,
          name: details.stop.stop_name,
          lat: details.stop.stop_lat,
          lon: details.stop.stop_lon,
          parent_station: details.stop.parent_station,
        },
        routes: details.routes.map((r) => ({
          route_id: r.route_id,
          short_name: r.route_short_name,
          long_name: r.route_long_name,
          type: r.route_type,
        })),
      });
    }
  );
}
