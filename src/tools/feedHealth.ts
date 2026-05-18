import { z } from "zod";
import { fetchAllFeedsDetailed } from "../gtfs/realtime.js";
import { FeedHealthResponseSchema } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
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

export function registerFeedHealthTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    "get_feed_health",
    {
      title: "Get realtime feed health",
      description:
        "Diagnostics for a transit system's GTFS-RT feeds: per-feed-type URL counts (ok/failed), entity counts, oldest feed-header age, and fetch error messages. Use this to check whether realtime data is reachable and fresh.",
      inputSchema: {
        system: z.string().describe("System ID, from list_systems"),
      },
      outputSchema: FeedHealthResponseSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ system }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const nowSecs = Math.floor(Date.now() / 1000);
      const feedTypes = ["trip_updates", "vehicle_positions", "alerts"] as const;

      const feedStatusByType = {} as Record<(typeof feedTypes)[number], FeedStatus>;

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
        })
      );

      return jsonResponse({
        feeds: feedStatusByType,
      });
    }
  );
}
