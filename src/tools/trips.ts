import { z } from "zod";
import { getTripDetails } from "../gtfs/queries.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
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

      if (!details.trip) {
        return textResponse(`Trip not found: ${trip_id}`);
      }

      // Fetch realtime updates for this trip
      const entities = await fetchAllFeeds(
        config.realtime.trip_updates,
        config.auth
      );

      // Find matching trip update
      const tripUpdate = entities.find(
        (e) => e.tripUpdate?.trip?.tripId === trip_id
      )?.tripUpdate;

      // Build stop time update map
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

      // Merge stop times with realtime
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
