import {
  fromJsonSchema,
  type JsonSchemaType,
  type McpServer,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
import type { RealtimeConfig, SystemConfig } from "../config.js";
import { fetchAllFeeds } from "../gtfs/realtime.js";
import { ensureGtfsLoaded, getDb } from "../gtfs/static.js";
import type { GtfsDb } from "../gtfs/queries.js";

export interface ToolContext {
  server: McpServer;
  systems: Map<string, SystemConfig>;
  dataDir: string;
  refreshHours: number;
}

// Zod renders nullable primitives as `type: ["string", "null"]`. Clients that
// map tool schemas onto a single-type dialect (Gemini's function declarations)
// may reject that, so split it into anyOf branches.
//
// Memoised because fromJsonSchema compiles a validator the SDK caches by object
// identity for the life of the process, and createServer runs per HTTP request.
const portableSchemas = new WeakMap<z.ZodType, StandardSchemaWithJSON>();

export function portableOutputSchema<T extends z.ZodType>(schema: T) {
  let portable = portableSchemas.get(schema);
  if (!portable) {
    portable = fromJsonSchema(splitTypeArrays(z.toJSONSchema(schema)) as JsonSchemaType);
    portableSchemas.set(schema, portable);
  }
  return portable as StandardSchemaWithJSON<z.infer<T>, z.infer<T>>;
}

function splitTypeArrays(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(splitTypeArrays);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = splitTypeArrays(value);
  if (Array.isArray(out.type)) {
    out.anyOf = out.type.map((type) => ({ type }));
    delete out.type;
  }
  return out;
}

export function jsonResponse<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function textResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
  };
}

export function errorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

export function resolveSystem(
  systems: Map<string, SystemConfig>,
  id: string
): SystemConfig | null {
  return systems.get(id) ?? null;
}

export function unknownSystemResponse(
  id: string,
  systems: Map<string, SystemConfig>
) {
  const available = Array.from(systems.keys()).sort().join(", ") || "none";
  return errorResponse(
    `Unknown system: ${id}. Use list_systems to discover valid system IDs. Available: ${available}.`
  );
}

// Tools that take a stop_id error on an unknown one rather than returning an
// empty result, so the model can tell a mistyped ID from a quiet stop.
export function unknownStopResponse(stopId: string) {
  return errorResponse(
    `Stop not found: ${stopId}. Use search_stops by name or find_nearby_stops by coordinates to discover valid stop_ids.`
  );
}

const FEED_LABELS: Record<keyof RealtimeConfig, string> = {
  trip_updates: "trip updates",
  vehicle_positions: "vehicle positions",
  alerts: "alerts",
};
const MAX_REPORTED_FEED_ERRORS = 3;

// An empty `entities` only means "nothing to report" when status is "ok".
// Tools must surface the other states, or the model reads a dead feed as
// good news ("no alerts").
export type RealtimeFetch = { entities: TransitRealtime.IFeedEntity[] } & (
  | { status: "ok"; message: null }
  | { status: "partial" | "failed" | "not_configured"; message: string }
);

export async function fetchRealtime(
  system: SystemConfig,
  feedType: keyof RealtimeConfig
): Promise<RealtimeFetch> {
  const urls = system.realtime[feedType];
  const label = FEED_LABELS[feedType];
  if (urls.length === 0) {
    return {
      entities: [],
      status: "not_configured",
      message: `No ${label} feed is configured for ${system.id}.`,
    };
  }

  const results = await fetchAllFeeds(urls, system.auth);
  const entities = results.flatMap((r) => r.entities);
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return { entities, status: "ok", message: null };

  const errors = Array.from(new Set(failed.map((r) => r.error ?? "unknown error")));
  const shown = errors.slice(0, MAX_REPORTED_FEED_ERRORS).join("; ");
  const more =
    errors.length > MAX_REPORTED_FEED_ERRORS
      ? `; +${errors.length - MAX_REPORTED_FEED_ERRORS} more`
      : "";

  if (failed.length === urls.length) {
    return {
      entities,
      status: "failed",
      message: `The ${label} feed for ${system.id} could not be fetched (${shown}${more}).`,
    };
  }
  return {
    entities,
    status: "partial",
    message: `${failed.length} of ${urls.length} ${label} feeds for ${system.id} could not be fetched (${shown}${more}); results may be incomplete.`,
  };
}

export async function getReadyDb(
  system: SystemConfig,
  dataDir: string,
  refreshHours: number
): Promise<GtfsDb> {
  await ensureGtfsLoaded(system, dataDir, refreshHours);
  return getDb(system, dataDir);
}
