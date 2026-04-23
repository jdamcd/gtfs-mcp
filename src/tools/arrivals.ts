import { z } from "zod";
import { getScheduledArrivals, getStopName, resolveStopIds } from "../gtfs/queries.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { currentGtfsTime, extractRtTime, formatLocalTime } from "../time.js";
import type { Arrival } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  getReadyDb,
} from "./helpers.js";

export function registerArrivalTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_arrivals",
    "Get upcoming arrivals at a stop. Returns minutes_away for realtime arrivals. Uses realtime data when available, otherwise falls back to scheduled times.",
    {
      system: z.string().describe("System ID"),
      stop_id: z.string().describe("Stop ID"),
      route_id: z.string().optional().describe("Filter by route ID"),
      limit: z
        .number()
        .default(10)
        .describe("Maximum number of arrivals to return"),
    },
    async ({ system, stop_id, route_id, limit }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);

      // Resolve parent stations to child stop IDs
      const stopIds = resolveStopIds(db, stop_id);
      const stopIdSet = new Set(stopIds);

      // Try realtime first
      const entities = await fetchAllFeeds(
        config.realtime.trip_updates,
        config.auth
      );

      const realtimeArrivals: Array<Arrival & { _sortTime: number }> = [];
      const headsignCache = new Map<string, string | null>();
      const resolveHeadsign = (stopId: string): string | null => {
        if (!headsignCache.has(stopId)) {
          headsignCache.set(stopId, getStopName(db, stopId));
        }
        return headsignCache.get(stopId)!;
      };

      for (const entity of entities) {
        const tu = entity.tripUpdate;
        if (!tu?.trip?.tripId) continue;

        const tripId = tu.trip.tripId;
        const tripRouteId = tu.trip.routeId ?? null;

        if (route_id && tripRouteId !== route_id) continue;

        const stopTimeUpdates = tu.stopTimeUpdate ?? [];
        const lastStopId = stopTimeUpdates.at(-1)?.stopId ?? null;

        for (const stu of stopTimeUpdates) {
          if (!stu.stopId || !stopIdSet.has(stu.stopId)) continue;

          const arrivalTime = extractRtTime(stu.arrival?.time);
          if (!arrivalTime) continue;

          const arrivalDate = new Date(arrivalTime);
          const arrivalLocal = formatLocalTime(arrivalDate, config.timezone);
          const minutesAway = Math.round((arrivalTime - Date.now()) / 60_000);

          realtimeArrivals.push({
            trip_id: tripId,
            route_id: tripRouteId ?? "unknown",
            stop_id: stu.stopId,
            arrival_time: arrivalLocal,
            minutes_away: minutesAway,
            headsign: lastStopId ? resolveHeadsign(lastStopId) : null,
            is_realtime: true,
            _sortTime: arrivalTime,
          });
        }
      }

      if (realtimeArrivals.length > 0) {
        realtimeArrivals.sort((a, b) => a._sortTime - b._sortTime);
        return jsonResponse(
          realtimeArrivals.slice(0, limit).map(({ _sortTime, ...rest }) => rest)
        );
      }

      // Fall back to scheduled arrivals
      const scheduled = getScheduledArrivals(
        db,
        stopIds,
        route_id,
        limit,
        currentGtfsTime(config.timezone)
      );

      const arrivals: Arrival[] = scheduled.map((s) => ({
        trip_id: s.trip_id,
        route_id: s.route_id,
        stop_id: s.stop_id,
        arrival_time: s.arrival_time,
        minutes_away: null,
        headsign: s.trip_headsign ?? s.stop_headsign ?? null,
        is_realtime: false,
      }));

      return jsonResponse(arrivals);
    }
  );
}
