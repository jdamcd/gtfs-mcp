import { z } from "zod";
import { fetchAllFeedsDetailed } from "../gtfs/realtime.js";
import { isAlertActiveAt } from "../gtfs/rtHelpers.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  getReadyDb,
} from "./helpers.js";

interface FeedStatus {
  configured: boolean;
  urls: number;
  urls_ok: number;
  urls_failed: number;
  entities: number;
  oldest_feed_age_seconds: number | null;
  errors: string[];
}

export function registerStatusTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_system_status",
    "Structured health overview for a transit system: static data counts, per-feed-type health (ok/failed URL counts, entity counts, oldest feed-header age, error messages), and a count of currently-active alerts.",
    {
      system: z.string().describe("System ID"),
    },
    async ({ system }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const db = await getReadyDb(config, ctx.dataDir, ctx.refreshHours);

      const routeCount =
        db.prepare("SELECT COUNT(*) as count FROM routes").get() as {
          count: number;
        };
      const stopCount =
        db.prepare("SELECT COUNT(*) as count FROM stops").get() as {
          count: number;
        };

      const nowSecs = Math.floor(Date.now() / 1000);
      const feedTypes = ["trip_updates", "vehicle_positions", "alerts"] as const;

      const feedStatusByType = {} as Record<(typeof feedTypes)[number], FeedStatus>;
      let activeAlertCount = 0;

      await Promise.all(
        feedTypes.map(async (feedType) => {
          const urls = config.realtime[feedType];
          if (urls.length === 0) {
            feedStatusByType[feedType] = {
              configured: false,
              urls: 0,
              urls_ok: 0,
              urls_failed: 0,
              entities: 0,
              oldest_feed_age_seconds: null,
              errors: [],
            };
            return;
          }

          const results = await fetchAllFeedsDetailed(urls, config.auth);
          const ok = results.filter((r) => r.ok);
          const failed = results.filter((r) => !r.ok);
          const timestamps = ok
            .map((r) => r.headerTimestamp)
            .filter((t): t is number => t !== null);
          const oldestTs = timestamps.length ? Math.min(...timestamps) : null;

          feedStatusByType[feedType] = {
            configured: true,
            urls: urls.length,
            urls_ok: ok.length,
            urls_failed: failed.length,
            entities: results.reduce((n, r) => n + r.entities.length, 0),
            oldest_feed_age_seconds:
              oldestTs !== null ? nowSecs - oldestTs : null,
            errors: failed.map((r) => r.error!).filter(Boolean),
          };

          if (feedType === "alerts") {
            activeAlertCount = results
              .flatMap((r) => r.entities)
              .filter((e) => e.alert && isAlertActiveAt(e.alert, nowSecs))
              .length;
          }
        })
      );

      return jsonResponse({
        system_id: config.id,
        system_name: config.name,
        route_count: routeCount.count,
        stop_count: stopCount.count,
        active_alerts: activeAlertCount,
        feeds: feedStatusByType,
      });
    }
  );
}
