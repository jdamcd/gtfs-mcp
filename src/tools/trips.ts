import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
import { z } from "zod";
import { getStopName, getTripDetails } from "../gtfs/queries.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { extractRtTime, formatLocalTime } from "../time.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  textResponse,
  getReadyDb,
} from "./helpers.js";

export function registerTripTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_trip",
    "Get details about a specific trip including stop sequence and realtime updates",
    {
      system: z.string().describe("System ID"),
      trip_id: z.string().describe("Trip ID"),
    },
    async ({ system, trip_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);
      const details = getTripDetails(db, trip_id);

      const entities = await fetchAllFeeds(
        config.realtime.trip_updates,
        config.auth
      );
      const tripUpdate = entities.find(
        (e) => e.tripUpdate?.trip?.tripId === trip_id
      )?.tripUpdate;

      if (!details.trip) {
        // Synthesise from RT when the trip_id is only in the realtime feed
        // (e.g. MTA's `069300_A..S58R` synthetic trip_ids that don't exist in
        // the static schedule).
        if (!tripUpdate) {
          return textResponse(`Trip not found: ${trip_id}`);
        }
        return jsonResponse(synthesiseTripFromRt(db, config.timezone, trip_id, tripUpdate));
      }

      const realtimeByStop = new Map<
        string,
        { arrivalDelay: number | null; departureDelay: number | null }
      >();
      if (tripUpdate?.stopTimeUpdate) {
        for (const stu of tripUpdate.stopTimeUpdate) {
          if (stu.stopId) {
            realtimeByStop.set(stu.stopId, {
              arrivalDelay: stu.arrival?.delay ?? null,
              departureDelay: stu.departure?.delay ?? null,
            });
          }
        }
      }

      const stopTimes = details.stop_times.map((st) => {
        const rt = realtimeByStop.get(st.stop_id);
        return {
          stop_id: st.stop_id,
          stop_name: st.stop_name,
          stop_sequence: st.stop_sequence,
          arrival_time: st.arrival_time,
          departure_time: st.departure_time,
          arrival_delay_seconds: rt?.arrivalDelay ?? null,
          departure_delay_seconds: rt?.departureDelay ?? null,
          is_realtime: !!rt,
        };
      });

      return jsonResponse({
        trip: {
          trip_id: details.trip.trip_id,
          route_id: details.trip.route_id,
          service_id: details.trip.service_id,
          trip_headsign: details.trip.trip_headsign,
          direction_id: details.trip.direction_id,
        },
        stop_times: stopTimes,
      });
    }
  );
}

function synthesiseTripFromRt(
  db: any,
  timezone: string,
  tripId: string,
  tripUpdate: TransitRealtime.ITripUpdate
) {
  const stopTimeUpdates = tripUpdate.stopTimeUpdate ?? [];
  const lastStopId = stopTimeUpdates.at(-1)?.stopId ?? null;

  const nameCache = new Map<string, string | null>();
  const resolveName = (stopId: string): string | null => {
    if (!nameCache.has(stopId)) {
      nameCache.set(stopId, getStopName(db, stopId));
    }
    return nameCache.get(stopId)!;
  };

  const stopTimes = stopTimeUpdates.map((stu, idx) => {
    const arrivalMs = extractRtTime(stu.arrival?.time);
    const departureMs = extractRtTime(stu.departure?.time);
    return {
      stop_id: stu.stopId ?? null,
      stop_name: stu.stopId ? resolveName(stu.stopId) : null,
      stop_sequence: stu.stopSequence ?? idx,
      arrival_time: arrivalMs ? formatLocalTime(new Date(arrivalMs), timezone) : null,
      departure_time: departureMs ? formatLocalTime(new Date(departureMs), timezone) : null,
      arrival_delay_seconds: stu.arrival?.delay ?? null,
      departure_delay_seconds: stu.departure?.delay ?? null,
      is_realtime: true,
    };
  });

  return {
    trip: {
      trip_id: tripId,
      route_id: tripUpdate.trip?.routeId ?? null,
      service_id: null,
      trip_headsign: lastStopId ? resolveName(lastStopId) : null,
      direction_id: tripUpdate.trip?.directionId ?? null,
    },
    stop_times: stopTimes,
  };
}
