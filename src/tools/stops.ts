import { z } from "zod";
import { searchStops, getStopDetails } from "../gtfs/queries.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  textResponse,
  getReadyDb,
} from "./helpers.js";

export function registerStopTools(ctx: ToolContext): void {
  ctx.server.tool(
    "search_stops",
    "Search for transit stops by name",
    {
      system: z.string().describe("System ID (e.g. 'mta-subway', 'bart')"),
      query: z.string().describe("Search query for stop name"),
      limit: z.number().default(10).describe("Maximum number of results"),
    },
    async ({ system, query, limit }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

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

  ctx.server.tool(
    "get_stop",
    "Get details about a specific stop and the routes serving it",
    {
      system: z.string().describe("System ID"),
      stop_id: z.string().describe("Stop ID"),
    },
    async ({ system, stop_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const details = getStopDetails(db, stop_id);

      if (!details.stop) {
        return textResponse(`Stop not found: ${stop_id}`);
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
