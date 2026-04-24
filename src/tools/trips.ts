import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
import { z } from "zod";
import {
  getTripDetails,
  makeStopNameResolver,
  type GtfsDb,
} from "../gtfs/queries.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import {
  stopStatusFromRelationship,
  tripStatusFromRelationship,
} from "../gtfs/rtHelpers.js";
import { extractRtTime, formatLocalTime } from "../time.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  errorResponse,
  getReadyDb,
} from "./helpers.js";

export function registerTripTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_trip",
    "Get a trip's stop sequence with realtime delay/status per stop. Returns top-level `trip.status` (scheduled/canceled/added) and per-stop `status` (scheduled/skipped/no_data). For agencies like MTA whose realtime trip_ids are synthetic, returns a realtime-only synthesis when the trip_id isn't in the static schedule. Use trip_ids returned by get_arrivals; they are short-lived.",
    {
      system: z.string().describe("System ID"),
      trip_id: z.string().describe("Trip ID, from get_arrivals"),
    },
    async ({ system, trip_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

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
          return errorResponse(
            `Trip not found: ${trip_id}. trip_ids come from get_arrivals and are only meaningful shortly after they are returned — realtime trips are short-lived.`
          );
        }
        return jsonResponse(synthesiseTripFromRt(db, config.timezone, trip_id, tripUpdate));
      }

      const realtimeByStop = new Map<
        string,
        {
          arrivalDelay: number | null;
          departureDelay: number | null;
          scheduleRelationship: number | null | undefined;
        }
      >();
      if (tripUpdate?.stopTimeUpdate) {
        for (const stu of tripUpdate.stopTimeUpdate) {
          if (stu.stopId) {
            realtimeByStop.set(stu.stopId, {
              arrivalDelay: stu.arrival?.delay ?? null,
              departureDelay: stu.departure?.delay ?? null,
              scheduleRelationship: stu.scheduleRelationship,
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
          status: rt
            ? stopStatusFromRelationship(rt.scheduleRelationship)
            : "scheduled",
        };
      });

      return jsonResponse({
        trip: {
          trip_id: details.trip.trip_id,
          route_id: details.trip.route_id,
          service_id: details.trip.service_id,
          trip_headsign: details.trip.trip_headsign,
          direction_id: details.trip.direction_id,
          status: tripStatusFromRelationship(
            tripUpdate?.trip?.scheduleRelationship
          ),
        },
        stop_times: stopTimes,
      });
    }
  );
}

function synthesiseTripFromRt(
  db: GtfsDb,
  timezone: string,
  tripId: string,
  tripUpdate: TransitRealtime.ITripUpdate
) {
  const stopTimeUpdates = tripUpdate.stopTimeUpdate ?? [];
  const lastStopId = stopTimeUpdates.at(-1)?.stopId ?? null;
  const resolveName = makeStopNameResolver(db);

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
      status: stopStatusFromRelationship(stu.scheduleRelationship),
    };
  });

  return {
    trip: {
      trip_id: tripId,
      route_id: tripUpdate.trip?.routeId ?? null,
      service_id: null,
      trip_headsign: lastStopId ? resolveName(lastStopId) : null,
      direction_id: tripUpdate.trip?.directionId ?? null,
      status: tripStatusFromRelationship(tripUpdate.trip?.scheduleRelationship),
    },
    stop_times: stopTimes,
  };
}
