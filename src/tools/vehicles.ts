import { z } from "zod";
import {
  congestionLevelName,
  occupancyStatusName,
  vehicleStopStatusName,
} from "../gtfs/enumNames.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { formatLocalTime } from "../time.js";
import type { VehiclePosition } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
} from "./helpers.js";

export function registerVehicleTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_vehicles",
    "Get current vehicle positions (lat/lon, bearing, speed, current_status like 'in_transit_to' / 'stopped_at'). Filter by route_id to avoid large responses on busy systems.",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().optional().describe("Filter by route ID"),
    },
    async ({ system, route_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const entities = await fetchAllFeeds(
        config.realtime.vehicle_positions,
        config.auth
      );

      // Filter before transforming
      const filtered = entities.filter((e) => {
        if (!e.vehicle?.position) return false;
        if (route_id && e.vehicle.trip?.routeId !== route_id) return false;
        return true;
      });

      const vehicles: VehiclePosition[] = filtered.map((e) => {
        const v = e.vehicle!;
        const pos = v.position!;
        return {
          vehicle_id: v.vehicle?.id ?? null,
          trip_id: v.trip?.tripId ?? null,
          route_id: v.trip?.routeId ?? null,
          latitude: pos.latitude ?? 0,
          longitude: pos.longitude ?? 0,
          bearing: pos.bearing ?? null,
          speed: pos.speed ?? null,
          timestamp: v.timestamp
            ? formatLocalTime(new Date(Number(v.timestamp) * 1000), config.timezone)
            : null,
          stop_id: v.stopId ?? null,
          current_status: vehicleStopStatusName(v.currentStatus),
          occupancy_status: occupancyStatusName(v.occupancyStatus),
          congestion_level: congestionLevelName(v.congestionLevel),
        };
      });

      return jsonResponse(vehicles);
    }
  );
}
