import { z } from "zod";
import { alertCauseName, alertEffectName } from "../gtfs/enumNames.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { isAlertActiveAt } from "../gtfs/rtHelpers.js";
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

// proto3 decodes unset string fields as "" rather than undefined, so a
// stop-only informed_entity arrives as { routeId: "", stopId: "D15" }.
// Collapse empty strings to null so consumers can treat "unset" uniformly.
function nullIfEmpty(s: string | null | undefined): string | null {
  return s == null || s === "" ? null : s;
}

export function registerAlertTools(ctx: ToolContext): void {
  ctx.server.tool(
    "get_alerts",
    "Get service alerts for a transit system. By default returns only alerts active right now (per GTFS-RT active_period semantics); set include_inactive=true to include planned/future/expired alerts.",
    {
      system: z.string().describe("System ID"),
      route_id: z.string().optional().describe("Filter by route ID"),
      stop_id: z.string().optional().describe("Filter by stop ID"),
      include_inactive: z
        .boolean()
        .default(false)
        .describe("Include alerts whose active_period does not cover the current time"),
    },
    async ({ system, route_id, stop_id, include_inactive }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const entities = await fetchAllFeeds(
        config.realtime.alerts,
        config.auth
      );

      const nowSecs = Math.floor(Date.now() / 1000);

      const filtered = entities.filter((e) => {
        if (!e.alert) return false;

        if (!include_inactive && !isAlertActiveAt(e.alert, nowSecs)) {
          return false;
        }

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
          route_id: nullIfEmpty(ie.routeId),
          stop_id: nullIfEmpty(ie.stopId),
          trip_id: nullIfEmpty(ie.trip?.tripId),
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
          cause: alertCauseName(a.cause),
          effect: alertEffectName(a.effect),
          active_periods: activePeriods,
          informed_entities: informedEntities,
        };
      });

      return jsonResponse(alerts);
    }
  );
}
