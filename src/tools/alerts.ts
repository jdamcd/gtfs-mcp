import { z } from "zod";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { formatLocalDateTime } from "../time.js";
import type { Alert, ActivePeriod, InformedEntity } from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
} from "./helpers.js";

function getTranslatedText(translatedString: any): string {
  if (!translatedString?.translation?.length) return "";
  const en = translatedString.translation.find(
    (t: any) => t.language === "en" || !t.language
  );
  return en?.text ?? translatedString.translation[0]?.text ?? "";
}

export function registerAlertTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_alerts",
    "Get active service alerts for a transit system",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().optional().describe("Filter by route ID"),
      stop_id: z.string().optional().describe("Filter by stop ID"),
    },
    async ({ system, route_id, stop_id }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system);

      const entities = await fetchAllFeeds(
        config.realtime.alerts,
        config.auth
      );

      // Filter entities before transforming
      const filtered = entities.filter((e) => {
        if (!e.alert) return false;
        const informed = e.alert.informedEntity ?? [];
        if (route_id && !informed.some((ie: any) => ie.routeId === route_id)) {
          return false;
        }
        if (stop_id && !informed.some((ie: any) => ie.stopId === stop_id)) {
          return false;
        }
        return true;
      });

      const alerts: Alert[] = filtered.map((e) => {
        const a = e.alert!;
        const informedEntities: InformedEntity[] = (
          a.informedEntity ?? []
        ).map((ie: any) => ({
          route_id: ie.routeId ?? null,
          stop_id: ie.stopId ?? null,
          trip_id: ie.trip?.tripId ?? null,
        }));

        const activePeriods: ActivePeriod[] = (a.activePeriod ?? []).map(
          (ap: any) => ({
            start: ap.start
              ? formatLocalDateTime(new Date(Number(ap.start) * 1000), config.timezone)
              : null,
            end: ap.end
              ? formatLocalDateTime(new Date(Number(ap.end) * 1000), config.timezone)
              : null,
          })
        );

        return {
          id: e.id ?? "unknown",
          header: getTranslatedText(a.headerText),
          description: getTranslatedText(a.descriptionText),
          cause: a.cause != null ? String(a.cause) : null,
          effect: a.effect != null ? String(a.effect) : null,
          active_periods: activePeriods,
          informed_entities: informedEntities,
        };
      });

      return jsonResponse(alerts);
    }
  );
}
