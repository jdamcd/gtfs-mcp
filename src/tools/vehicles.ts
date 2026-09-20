import { z } from "zod";
import {
  congestionLevelName,
  occupancyStatusName,
  vehicleStopStatusName,
} from "../gtfs/enumNames.js";
import { extractRtTime, formatLocalTime } from "../time.js";
import { VehiclesResponseSchema, type VehiclePosition } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  errorResponse,
  fetchRealtime,
} from "./helpers.js";

export function registerVehicleTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    "get_vehicles",
    {
      title: "Get vehicle positions",
      description:
        "Get current vehicle positions (lat/lon, bearing, speed, current_status like 'in_transit_to' / 'stopped_at'). Filter by route_id to avoid large responses on busy systems.",
      inputSchema: {
        system: z.string().describe("System ID, from list_systems"),
        route_id: z.string().optional().describe("Filter by route ID"),
      },
      outputSchema: VehiclesResponseSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ system, route_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const rt = await fetchRealtime(config, "vehicle_positions");
      if (rt.status === "not_configured") {
        return errorResponse(
          `${rt.message} Vehicle positions are unavailable for this system.`
        );
      }
      if (rt.status === "failed") {
        return errorResponse(
          `${rt.message} Vehicle positions are unknown right now. get_feed_health has details.`
        );
      }
      const entities = rt.entities;

      // Filter before transforming
      const filtered = entities.filter((e) => {
        if (!e.vehicle?.position) return false;
        if (route_id && e.vehicle.trip?.routeId !== route_id) return false;
        return true;
      });

      const vehicles: VehiclePosition[] = filtered.map((e) => {
        const v = e.vehicle!;
        const pos = v.position!;
        const timestampMs = extractRtTime(v.timestamp);
        return {
          vehicle_id: v.vehicle?.id ?? null,
          trip_id: v.trip?.tripId ?? null,
          route_id: v.trip?.routeId ?? null,
          latitude: pos.latitude ?? 0,
          longitude: pos.longitude ?? 0,
          bearing: pos.bearing ?? null,
          speed: pos.speed ?? null,
          timestamp: timestampMs
            ? formatLocalTime(new Date(timestampMs), config.timezone)
            : null,
          stop_id: v.stopId ?? null,
          current_status: vehicleStopStatusName(v.currentStatus),
          occupancy_status: occupancyStatusName(v.occupancyStatus),
          congestion_level: congestionLevelName(v.congestionLevel),
        };
      });

      return jsonResponse({
        vehicles,
        ...(rt.message ? { warnings: [rt.message] } : {}),
      });
    }
  );
}
