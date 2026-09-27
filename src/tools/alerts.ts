import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
import { z } from "zod";
import { alertCauseName, alertEffectName } from "../gtfs/enumNames.js";
import { alertSeverity, alertStartMs, isAlertActiveAt } from "../gtfs/rtHelpers.js";
import { extractRtTime, formatLocalDateTime } from "../time.js";
import {
  AlertsResponseSchema,
  type Alert,
  type ActivePeriod,
  type InformedEntity,
} from "../types.js";
import {
  type ToolContext,
  resolveSystem,
  unknownSystemResponse,
  jsonResponse,
  errorResponse,
  fetchRealtime,
} from "./helpers.js";

function getTranslatedText(
  translatedString: TransitRealtime.ITranslatedString | null | undefined
): string {
  const translations = translatedString?.translation ?? [];
  if (translations.length === 0) return "";
  const en = translations.find((t) => t.language === "en" || !t.language);
  return en?.text ?? translations[0]?.text ?? "";
}

// proto3 decodes unset string fields as "" rather than undefined, so a
// stop-only informed_entity arrives as { routeId: "", stopId: "D15" }.
// Collapse empty strings to null so consumers can treat "unset" uniformly.
function nullIfEmpty(s: string | null | undefined): string | null {
  return s == null || s === "" ? null : s;
}

export function registerAlertTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    "get_alerts",
    {
      title: "Get service alerts",
      description:
        "Get service alerts for a transit system, most disruptive first. By default returns only alerts active right now (per GTFS-RT active_period semantics); set include_inactive=true to include planned/future/expired alerts.",
      inputSchema: {
        system: z.string().describe("System ID, from list_systems"),
        route_id: z.string().optional().describe("Filter by route ID"),
        stop_id: z.string().optional().describe("Filter by stop ID"),
        include_inactive: z
          .boolean()
          .default(false)
          .describe(
            "Include alerts whose active_period does not cover the current time"
          ),
      },
      outputSchema: AlertsResponseSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ system, route_id, stop_id, include_inactive }) => {
      const config = resolveSystem(ctx.systems, system);
      if (!config) return unknownSystemResponse(system, ctx.systems);

      const rt = await fetchRealtime(config, "alerts");
      if (rt.status === "not_configured") {
        return errorResponse(
          `${rt.message} Alerts are unavailable for this system — that is not the same as there being no alerts.`
        );
      }
      if (rt.status === "failed") {
        return errorResponse(
          `${rt.message} Alert status is unknown — do not report this as no alerts. get_feed_health has details.`
        );
      }
      const entities = rt.entities;

      const nowSecs = Math.floor(Date.now() / 1000);

      const filtered = entities.filter((e) => {
        if (!e.alert) return false;

        if (!include_inactive && !isAlertActiveAt(e.alert, nowSecs)) {
          return false;
        }

        const informed = e.alert.informedEntity ?? [];
        if (route_id && !informed.some((ie) => ie.routeId === route_id)) {
          return false;
        }
        if (stop_id && !informed.some((ie) => ie.stopId === stop_id)) {
          return false;
        }
        return true;
      });

      // Severity, then newest first, then id so the order is stable.
      const ordered = filtered
        .map((e) => ({
          e,
          severity: alertSeverity(e.alert!.effect),
          startMs: alertStartMs(e.alert!),
        }))
        .sort(
          (a, b) =>
            a.severity - b.severity ||
            b.startMs - a.startMs ||
            (a.e.id ?? "").localeCompare(b.e.id ?? "")
        )
        .map((x) => x.e);

      const formatBound = (bound: unknown) => {
        const ms = extractRtTime(bound);
        return ms ? formatLocalDateTime(new Date(ms), config.timezone) : null;
      };

      const alerts: Alert[] = ordered.map((e) => {
        const a = e.alert!;
        const informedEntities: InformedEntity[] = (
          a.informedEntity ?? []
        ).map((ie) => ({
          route_id: nullIfEmpty(ie.routeId),
          stop_id: nullIfEmpty(ie.stopId),
          trip_id: nullIfEmpty(ie.trip?.tripId),
        }));

        const activePeriods: ActivePeriod[] = (a.activePeriod ?? []).map(
          (ap) => ({ start: formatBound(ap.start), end: formatBound(ap.end) })
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

      return jsonResponse({
        alerts,
        ...(rt.message ? { warnings: [rt.message] } : {}),
      });
    }
  );
}
