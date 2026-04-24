import { z } from "zod";
import {
  getScheduledArrivals,
  makeStopNameResolver,
  resolveStopIds,
} from "../gtfs/queries.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import {
  STOP_NO_DATA,
  STOP_SKIPPED,
  TRIP_ADDED,
  TRIP_CANCELED,
} from "../gtfs/rtHelpers.js";
import { getActiveServiceIds } from "../gtfs/serviceDay.js";
import {
  currentGtfsDate,
  currentGtfsTime,
  dayColumnFromDate,
  extractRtTime,
  formatLocalTime,
  gtfsTimeToSeconds,
  localMidnightMs,
  previousGtfsDate,
  shiftGtfsTimeByDays,
} from "../time.js";
import type { Arrival, ArrivalsResponse } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  getReadyDb,
} from "./helpers.js";

type Sortable = { arrival: Arrival; absMs: number };

export function registerArrivalTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_arrivals",
    "Get upcoming arrivals at a stop. Accepts a parent station ID and resolves to all child platforms. Merges realtime data (authoritative within its horizon) with scheduled times (fills beyond). Cancelled trips and skipped stops are excluded; includes services that roll past midnight via yesterday's 24h+ stop_times. Returns data_source indicating which inputs contributed.",
    {
      system: z.string().describe("System ID"),
      stop_id: z.string().describe("Stop ID (parent station IDs are resolved to child platforms)"),
      route_id: z.string().optional().describe("Filter by route ID"),
      limit: z
        .number()
        .default(10)
        .describe("Maximum number of arrivals to return"),
    },
    async ({ system, stop_id, route_id, limit }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const stopIds = resolveStopIds(db, stop_id);
      const stopIdSet = new Set(stopIds);
      const resolveHeadsign = makeStopNameResolver(db);
      const nowMs = Date.now();
      const tz = config.timezone;

      const entities = await fetchAllFeeds(
        config.realtime.trip_updates,
        config.auth
      );

      const realtime: Sortable[] = [];

      // Per-(stop, route) RT coverage window in absolute unix ms. Scheduled
      // arrivals at or before this time are suppressed — RT is authoritative
      // within its horizon. Cancelled trips also contribute to the window so
      // a cancelled slot doesn't silently backfill from schedule.
      const rtWindowByKey = new Map<string, number>();
      // Trip ids observed in RT per stop. Stable-id agencies match RT to
      // static trip_ids, so a single trip can appear in both sources — and
      // RT may predict *earlier* than schedule (not caught by the time
      // window) or report a different route_id than static (MARTA does
      // this; public-facing id in RT vs internal id in schedule). Keying
      // by stop alone dedupes across both anomalies.
      const rtTripsByStop = new Map<string, Set<string>>();
      const windowKey = (stopId: string, routeId: string | null) =>
        `${stopId}\x00${routeId ?? ""}`;

      for (const entity of entities) {
        const tu = entity.tripUpdate;
        if (!tu?.trip?.tripId) continue;

        const tripId = tu.trip.tripId;
        const tripRouteId = tu.trip.routeId ?? null;
        if (route_id && tripRouteId !== route_id) continue;

        const tripSr = tu.trip.scheduleRelationship;
        const isCanceled = tripSr === TRIP_CANCELED;
        const isAdded = tripSr === TRIP_ADDED;

        const stopTimeUpdates = tu.stopTimeUpdate ?? [];
        const lastStopId = stopTimeUpdates.at(-1)?.stopId ?? null;

        for (const stu of stopTimeUpdates) {
          if (!stu.stopId || !stopIdSet.has(stu.stopId)) continue;

          const absMs = extractRtTime(stu.arrival?.time);
          if (!absMs) continue;

          const k = windowKey(stu.stopId, tripRouteId);
          const existing = rtWindowByKey.get(k);
          if (existing === undefined || absMs > existing) {
            rtWindowByKey.set(k, absMs);
          }
          let trips = rtTripsByStop.get(stu.stopId);
          if (!trips) {
            trips = new Set();
            rtTripsByStop.set(stu.stopId, trips);
          }
          trips.add(tripId);

          if (isCanceled) continue;
          if (stu.scheduleRelationship === STOP_SKIPPED) continue;
          if (stu.scheduleRelationship === STOP_NO_DATA) continue;

          realtime.push({
            absMs,
            arrival: {
              trip_id: tripId,
              route_id: tripRouteId ?? "unknown",
              stop_id: stu.stopId,
              arrival_time: formatLocalTime(new Date(absMs), tz),
              minutes_away: Math.round((absMs - nowMs) / 60_000),
              headsign: lastStopId ? resolveHeadsign(lastStopId) : null,
              is_realtime: true,
              ...(isAdded ? { is_added: true } : {}),
            },
          });
        }
      }

      // Scheduled arrivals: today's active services + yesterday's services
      // for stop_times >= 24:00:00 (GTFS allows 25:30:00 to mean 1:30 AM of
      // the next calendar day). Both are mapped to absolute unix ms so the
      // RT window comparison and final sort handle midnight crossover.
      const todayDate = currentGtfsDate(tz);
      const prevDate = previousGtfsDate(todayDate);
      const todayServices = getActiveServiceIds(db, todayDate, dayColumnFromDate(todayDate));
      const prevServices = getActiveServiceIds(db, prevDate, dayColumnFromDate(prevDate));
      const todayMidnight = localMidnightMs(todayDate, tz);
      const prevMidnight = localMidnightMs(prevDate, tz);
      const currentHHMMSS = currentGtfsTime(tz);
      const prevCutoff = shiftGtfsTimeByDays(currentHHMMSS, 1);

      const scheduled: Sortable[] = [];
      const pushScheduled = (
        services: string[],
        fromTime: string,
        midnight: number
      ) => {
        if (services.length === 0 || stopIds.length === 0) return;
        const rows = getScheduledArrivals(
          db,
          stopIds,
          services,
          route_id,
          // Over-fetch so RT-window filtering still leaves enough to fill `limit`.
          limit * 3,
          fromTime
        );
        for (const row of rows) {
          const absMs = midnight + gtfsTimeToSeconds(row.arrival_time) * 1000;
          const rtMax = rtWindowByKey.get(windowKey(row.stop_id, row.route_id));
          if (rtMax !== undefined && absMs <= rtMax) continue;
          if (rtTripsByStop.get(row.stop_id)?.has(row.trip_id)) continue;
          scheduled.push({
            absMs,
            arrival: {
              trip_id: row.trip_id,
              route_id: row.route_id,
              stop_id: row.stop_id,
              arrival_time: formatLocalTime(new Date(absMs), tz),
              minutes_away: Math.round((absMs - nowMs) / 60_000),
              // Per GTFS spec, stop_headsign overrides trip_headsign when present.
              headsign: row.stop_headsign ?? row.trip_headsign ?? null,
              is_realtime: false,
            },
          });
        }
      };
      pushScheduled(todayServices, currentHHMMSS, todayMidnight);
      pushScheduled(prevServices, prevCutoff, prevMidnight);

      const combined = [...realtime, ...scheduled]
        .sort((a, b) => a.absMs - b.absMs)
        .slice(0, limit)
        .map((s) => s.arrival);

      const hasRt = combined.some((a) => a.is_realtime);
      const hasSched = combined.some((a) => !a.is_realtime);
      let data_source: ArrivalsResponse["data_source"];
      if (hasRt && hasSched) data_source = "mixed";
      else if (hasRt) data_source = "realtime";
      else if (hasSched) data_source = "scheduled";
      else data_source = "none";

      const response: ArrivalsResponse = { data_source, arrivals: combined };
      return jsonResponse(response);
    }
  );
}
