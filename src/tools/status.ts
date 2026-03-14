import { z } from "zod";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  getReadyDb,
} from "./helpers.js";

export function registerStatusTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_system_status",
    "Get status overview for a transit system including route/stop counts and alert count",
    {
      system: z.string().describe("System ID"),
    },
    async ({ system }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);

      const routeCount =
        db.prepare("SELECT COUNT(*) as count FROM routes").get() as {
          count: number;
        };
      const stopCount =
        db.prepare("SELECT COUNT(*) as count FROM stops").get() as {
          count: number;
        };

      // Fetch all three feed types concurrently
      const feedTypes = ["trip_updates", "vehicle_positions", "alerts"] as const;
      const feedResults = await Promise.allSettled(
        feedTypes.map(async (feedType) => {
          const urls = config.realtime[feedType];
          if (urls.length === 0) return { feedType, status: "not configured" as const, entities: [] };
          const entities = await fetchAllFeeds(urls, config.auth);
          return {
            feedType,
            status: `${urls.length} feed(s), ${entities.length} entities` as const,
            entities,
          };
        })
      );

      const feedStatus: Record<string, string> = {};
      let alertCount = 0;

      for (const result of feedResults) {
        if (result.status === "fulfilled") {
          const { feedType, status, entities } = result.value;
          feedStatus[feedType] = status;
          if (feedType === "alerts") {
            alertCount = entities.filter((e) => e.alert).length;
          }
        } else {
          // Find which feed type failed based on order
          const idx = feedResults.indexOf(result);
          feedStatus[feedTypes[idx]] = "error fetching";
        }
      }

      return jsonResponse({
        system_id: config.id,
        system_name: config.name,
        route_count: routeCount.count,
        stop_count: stopCount.count,
        active_alerts: alertCount,
        feeds: feedStatus,
      });
    }
  );
}
