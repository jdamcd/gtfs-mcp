import { z } from "zod";
import { fetchAllFeeds } from "../gtfs/realtime.js";
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
    "Get current vehicle positions for a transit system",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().optional().describe("Filter by route ID"),
    },
    async ({ system, route_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

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
            ? new Date(Number(v.timestamp) * 1000).toLocaleTimeString("en-GB", { hour12: false })
            : null,
          stop_id: v.stopId ?? null,
          current_status:
            v.currentStatus != null ? String(v.currentStatus) : null,
        };
      });

      return jsonResponse(vehicles);
    }
  );
}
