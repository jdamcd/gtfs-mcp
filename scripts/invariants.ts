// Invariants cover MCP contract correctness — shapes, ids that round-trip
// across tools, internal consistency. NOT GTFS data quality.

import { GTFS_TIME_PATTERN } from "../src/time.js";

export type CallRecord = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  result?: unknown;
  // Set when the tool answered with an error result instead of data.
  isError?: boolean;
  error?: string;
};

export type Severity = "error" | "warn";

export type Violation = {
  rule: string;
  severity: Severity;
  message: string;
  context?: Record<string, unknown>;
};

export type RunContext = {
  systemId: string;
  configuredSystems: Array<{ id: string; name: string }>;
  // Routes from unfiltered list_routes pages, and the total those pages report.
  listedRouteIds: Set<string>;
  listedRouteTotal: number | null;
  // Stop IDs handed out by search_stops, get_route and get_stop, all of which
  // read the schedule, so the other stop tools must accept them.
  observedStopIds: Set<string>;
  observedTripIds: Set<string>;
  /** trip_ids reported as realtime by get_arrivals — get_trip must resolve these */
  arrivalsTripIds: Set<string>;
  /** Most recent search_stops result set, for the parent/child cross-check */
  lastSearchStopIds: Set<string> | null;
};

export function createRunContext(
  systemId: string,
  configuredSystems: Array<{ id: string; name: string }>
): RunContext {
  return {
    systemId,
    configuredSystems,
    listedRouteIds: new Set(),
    listedRouteTotal: null,
    observedStopIds: new Set(),
    observedTripIds: new Set(),
    arrivalsTripIds: new Set(),
    lastSearchStopIds: null,
  };
}

function findDuplicates<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) dupes.add(item);
    else seen.add(item);
  }
  return [...dupes];
}

// Route cross-checks wait for a full listing: list_routes pages, and a partial
// listing would flag every route on the pages not seen yet.
function fullRouteList(ctx: RunContext): Set<string> | null {
  const { listedRouteIds, listedRouteTotal } = ctx;
  return listedRouteTotal !== null && listedRouteIds.size >= listedRouteTotal
    ? listedRouteIds
    : null;
}

type InvariantFn = (record: CallRecord, ctx: RunContext) => Violation[];

const checks: Record<string, InvariantFn> = {
  list_systems: checkListSystems,
  list_routes: checkListRoutes,
  get_route: checkGetRoute,
  search_stops: checkSearchStops,
  get_stop: checkGetStop,
  get_arrivals: checkGetArrivals,
  get_trip: checkGetTrip,
  get_alerts: checkGetAlerts,
  get_vehicles: checkGetVehicles,
};

export function runInvariants(record: CallRecord, ctx: RunContext): Violation[] {
  const fn = checks[record.tool];
  return [
    ...checkErrorResult(record),
    ...checkStopRoundTrip(record, ctx),
    ...(fn ? fn(record, ctx) : []),
  ];
}

const STOP_TOOLS = new Set(["get_stop", "get_arrivals", "get_alerts"]);

function checkStopRoundTrip(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.isError || !STOP_TOOLS.has(record.tool)) return [];
  if (typeof record.result !== "string" || !record.result.startsWith("Stop not found")) return [];
  const stopId = record.args.stop_id;
  if (typeof stopId !== "string" || !ctx.observedStopIds.has(stopId)) return [];
  return [
    {
      rule: "X-STOP",
      severity: "error",
      message: `${record.tool} rejected a stop_id that another tool returned`,
      context: { stop_id: stopId },
    },
  ];
}

// The SDK turns output that fails the tool's own outputSchema into an error
// result, so a shape bug on live data only shows up as this text.
function checkErrorResult(record: CallRecord): Violation[] {
  if (!record.isError || typeof record.result !== "string") return [];
  if (!record.result.startsWith("Output validation error")) return [];
  return [
    {
      rule: "MCP-01",
      severity: "error",
      message: "tool output failed its own outputSchema",
      context: { error: record.result.slice(0, 300) },
    },
  ];
}

function checkListSystems(record: CallRecord, ctx: RunContext): Violation[] {
  const systems = (record.result as any)?.systems;
  if (!record.ok || !Array.isArray(systems)) return [];
  const got = new Set(systems.map((s: any) => s?.id));
  const expected = new Set(ctx.configuredSystems.map((s) => s.id));
  const missing = [...expected].filter((id) => !got.has(id));
  const extra = [...got].filter((id) => typeof id === "string" && !expected.has(id));
  if (missing.length === 0 && extra.length === 0) return [];
  return [
    {
      rule: "SYS-01",
      severity: "error",
      message: "list_systems does not match configured systems",
      context: { missing, extra },
    },
  ];
}

function checkListRoutes(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || typeof record.result !== "object" || record.result == null) return [];
  const routes = (record.result as any).routes;
  if (!Array.isArray(routes)) return [];
  const violations: Violation[] = [];

  const ids = routes.map((r) => r?.route_id).filter((id): id is string => typeof id === "string");
  const dupes = findDuplicates(ids);
  if (dupes.length > 0) {
    violations.push({
      rule: "RT-01",
      severity: "error",
      message: "list_routes contains duplicate route_ids",
      context: { duplicates: dupes.slice(0, 10) },
    });
  }

  if (record.args.query === undefined && record.args.route_type === undefined) {
    for (const id of ids) ctx.listedRouteIds.add(id);
    const total = (record.result as any).total;
    if (typeof total === "number") ctx.listedRouteTotal = total;
  }

  return violations;
}

function checkGetRoute(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || typeof record.result !== "object" || record.result == null) return [];
  const data = record.result as any;
  const violations: Violation[] = [];
  const requested = record.args.route_id;

  if (data.route?.route_id !== requested) {
    violations.push({
      rule: "RT-03",
      severity: "error",
      message: "get_route.route.route_id does not match requested id",
      context: { requested, got: data.route?.route_id },
    });
  }

  const directions: any[] = Array.isArray(data.directions) ? data.directions : [];
  const directionIds = directions.map((d) => d?.direction_id ?? null);
  const requestedDirection = record.args.direction_id;
  if (typeof requestedDirection === "number") {
    if (directionIds.some((id) => id !== requestedDirection)) {
      violations.push({
        rule: "RT-04",
        severity: "error",
        message: "get_route returned a direction other than the requested direction_id",
        context: { requested: requestedDirection, got: directionIds },
      });
    }
  } else if (findDuplicates(directionIds).length > 0) {
    violations.push({
      rule: "RT-04",
      severity: "error",
      message: "get_route returned the same direction_id more than once",
      context: { direction_ids: directionIds },
    });
  }

  // A stop can appear in both directions, so duplicates only count within one.
  for (const direction of directions) {
    const stops: any[] = Array.isArray(direction?.stops) ? direction.stops : [];
    const stopIds = stops.map((s) => s?.stop_id).filter((id): id is string => typeof id === "string");
    const dupes = findDuplicates(stopIds);
    if (dupes.length > 0) {
      violations.push({
        rule: "RT-02",
        severity: "error",
        message: "a get_route direction contains duplicate stop_ids",
        context: { direction_id: direction?.direction_id ?? null, duplicates: dupes },
      });
    }
    for (const id of stopIds) ctx.observedStopIds.add(id);
  }

  return violations;
}

// SQLite's LIKE and lower() only fold ASCII letters, so the search checks fold
// the same way.
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function checkSearchStops(record: CallRecord, ctx: RunContext): Violation[] {
  const stops = (record.result as any)?.stops;
  if (!record.ok || !Array.isArray(stops)) return [];
  const violations: Violation[] = [];
  const ids = stops
    .map((s: any) => s?.stop_id)
    .filter((id): id is string => typeof id === "string");
  ctx.lastSearchStopIds = new Set(ids);
  for (const id of ids) ctx.observedStopIds.add(id);

  const query = record.args.query;
  if (typeof query !== "string" || query === "") return violations;
  const q = asciiLower(query);
  const names = stops.map((s: any) => (typeof s?.name === "string" ? asciiLower(s.name) : ""));

  const missing = names.findIndex((n) => !n.includes(q));
  if (missing >= 0) {
    violations.push({
      rule: "ST-05",
      severity: "error",
      message: "search_stops returned a stop whose name doesn't contain the query",
      context: { query, stop_id: stops[missing]?.stop_id, name: stops[missing]?.name },
    });
  }

  const firstNonPrefix = names.findIndex((n) => !n.startsWith(q));
  const latePrefix =
    firstNonPrefix < 0 ? -1 : names.findIndex((n, i) => i > firstNonPrefix && n.startsWith(q));
  if (latePrefix >= 0) {
    violations.push({
      rule: "ST-04",
      severity: "error",
      message: "search_stops ranked a name starting with the query below one that doesn't",
      context: { query, before: stops[firstNonPrefix]?.name, after: stops[latePrefix]?.name },
    });
  }

  return violations;
}

function checkGetStop(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || typeof record.result !== "object" || record.result == null) return [];
  const data = record.result as any;
  const violations: Violation[] = [];
  const requested = record.args.stop_id;
  const stopId = data.stop?.stop_id;
  const parent = data.stop?.parent_station;

  if (stopId !== requested) {
    violations.push({
      rule: "ST-03",
      severity: "error",
      message: "get_stop.stop.stop_id does not match requested id",
      context: { requested, got: stopId },
    });
  }

  if (
    ctx.lastSearchStopIds &&
    typeof stopId === "string" &&
    typeof parent === "string" &&
    parent !== "" &&
    ctx.lastSearchStopIds.has(stopId) &&
    ctx.lastSearchStopIds.has(parent)
  ) {
    violations.push({
      rule: "ST-01",
      severity: "error",
      message: "search_stops returned both a parent station and its child platform",
      context: { child: stopId, parent },
    });
  }

  if (typeof stopId === "string") ctx.observedStopIds.add(stopId);
  if (typeof parent === "string" && parent !== "") ctx.observedStopIds.add(parent);

  return violations;
}

function checkGetArrivals(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || typeof record.result !== "object" || record.result == null) return [];
  const arrivals = (record.result as any).arrivals;
  if (!Array.isArray(arrivals)) return [];
  const violations: Violation[] = [];

  const badFormat = arrivals.find(
    (a) => typeof a.arrival_time !== "string" || !GTFS_TIME_PATTERN.test(a.arrival_time)
  );
  if (badFormat) {
    violations.push({
      rule: "AR-01",
      severity: "error",
      message: "get_arrivals returned non-HH:MM:SS arrival_time",
      context: { trip_id: badFormat.trip_id, arrival_time: badFormat.arrival_time },
    });
  }

  // Compare by minutes_away when available — arrival_time is a wall-clock
  // HH:MM:SS that wraps at midnight, so a response spanning a service-day
  // rollover will appear out of order by string comparison but is correctly
  // sorted by absolute time.
  for (let i = 1; i < arrivals.length; i++) {
    const prev = arrivals[i - 1];
    const curr = arrivals[i];
    const prevT = typeof prev.minutes_away === "number" ? prev.minutes_away : null;
    const currT = typeof curr.minutes_away === "number" ? curr.minutes_away : null;
    if (prevT !== null && currT !== null) {
      if (currT < prevT) {
        violations.push({
          rule: "AR-04",
          severity: "warn",
          message: "get_arrivals not sorted ascending by minutes_away",
          context: { index: i, prev: prev.arrival_time, curr: curr.arrival_time },
        });
        break;
      }
      continue;
    }
    // Fallback to string compare only when minutes_away isn't present on both.
    if (
      typeof prev.arrival_time === "string" &&
      typeof curr.arrival_time === "string" &&
      GTFS_TIME_PATTERN.test(prev.arrival_time) &&
      GTFS_TIME_PATTERN.test(curr.arrival_time) &&
      curr.arrival_time < prev.arrival_time
    ) {
      violations.push({
        rule: "AR-04",
        severity: "warn",
        message: "get_arrivals not sorted ascending by arrival_time",
        context: { index: i, prev: prev.arrival_time, curr: curr.arrival_time },
      });
      break;
    }
  }

  const past = arrivals.find(
    (a) => typeof a.minutes_away === "number" && a.minutes_away < 0
  );
  if (past) {
    violations.push({
      rule: "AR-05",
      severity: "error",
      message: "get_arrivals contains arrivals in the past",
      context: { trip_id: past.trip_id, stop_id: past.stop_id, minutes_away: past.minutes_away },
    });
  }

  // Loop routes legitimately visit the same stop twice on the same trip at
  // different times. Only flag as duplication when arrival_time also matches.
  const seen = new Set<string>();
  for (const a of arrivals) {
    const key = `${a.trip_id}|${a.stop_id}|${a.arrival_time}`;
    if (seen.has(key)) {
      violations.push({
        rule: "AR-03",
        severity: "error",
        message: "get_arrivals contains duplicate (trip_id, stop_id, arrival_time)",
        context: { trip_id: a.trip_id, stop_id: a.stop_id, arrival_time: a.arrival_time },
      });
      break;
    }
    seen.add(key);
  }

  for (const a of arrivals) {
    if (typeof a.trip_id === "string" && a.is_realtime) ctx.arrivalsTripIds.add(a.trip_id);
  }

  return violations;
}

function checkGetTrip(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok) return [];
  const violations: Violation[] = [];
  const requested = String(record.args.trip_id ?? "");

  if (typeof record.result === "string") {
    if (record.result.toLowerCase().includes("not found")) {
      if (ctx.arrivalsTripIds.has(requested)) {
        violations.push({
          rule: "X-ARR-TRIP",
          severity: "error",
          message: "get_trip not-found for a trip_id returned by get_arrivals",
          context: { trip_id: requested },
        });
      }
    }
    return violations;
  }

  if (typeof record.result !== "object" || record.result == null) return violations;
  const data = record.result as any;
  const tripId = data.trip?.trip_id;

  if (tripId !== requested) {
    violations.push({
      rule: "TP-03",
      severity: "error",
      message: "get_trip.trip.trip_id does not match requested id",
      context: { requested, got: tripId },
    });
  }

  const stopTimes: any[] = Array.isArray(data.stop_times) ? data.stop_times : [];
  for (let i = 1; i < stopTimes.length; i++) {
    const prev = stopTimes[i - 1]?.stop_sequence;
    const curr = stopTimes[i]?.stop_sequence;
    if (typeof prev === "number" && typeof curr === "number" && curr < prev) {
      violations.push({
        rule: "TP-01",
        severity: "error",
        message: "get_trip.stop_times not ordered by stop_sequence",
        context: { index: i, prev, curr },
      });
      break;
    }
  }

  const routeId = data.trip?.route_id;
  const listed = fullRouteList(ctx);
  if (typeof routeId === "string" && listed && !listed.has(routeId)) {
    violations.push({
      rule: "X-TRIP-ROUTE",
      severity: "warn",
      message: "get_trip.route_id not in list_routes",
      context: { route_id: routeId },
    });
  }

  if (typeof tripId === "string") ctx.observedTripIds.add(tripId);

  return violations;
}

function checkGetAlerts(record: CallRecord, ctx: RunContext): Violation[] {
  const alerts = (record.result as any)?.alerts;
  if (!record.ok || !Array.isArray(alerts)) return [];
  const violations: Violation[] = [];

  const blank = alerts.find((a) => {
    const h = typeof a.header === "string" ? a.header.trim() : "";
    const d = typeof a.description === "string" ? a.description.trim() : "";
    return h === "" && d === "";
  });
  if (blank) {
    violations.push({
      rule: "AL-01",
      severity: "error",
      message: "get_alerts returned an alert with both header and description empty",
      context: { id: blank.id },
    });
  }

  const listed = fullRouteList(ctx);
  if (listed) {
    const unknown = new Set<string>();
    for (const a of alerts) {
      for (const ie of a.informed_entities ?? []) {
        if (typeof ie?.route_id === "string" && !listed.has(ie.route_id)) {
          unknown.add(ie.route_id);
        }
      }
    }
    if (unknown.size > 0) {
      violations.push({
        rule: "X-ALERT-ROUTE",
        severity: "warn",
        message: "get_alerts informed_entities reference route_ids not in list_routes",
        context: { unknown_route_ids: [...unknown].slice(0, 10) },
      });
    }
  }

  return violations;
}

function checkGetVehicles(record: CallRecord, _ctx: RunContext): Violation[] {
  const vehicles = (record.result as any)?.vehicles;
  if (!record.ok || !Array.isArray(vehicles)) return [];
  if (vehicles.length === 0) return [];

  const zeroCount = vehicles.filter((v) => v.latitude === 0 && v.longitude === 0).length;
  if (zeroCount === 0) return [];

  if (zeroCount === vehicles.length && vehicles.length > 1) {
    return [
      {
        rule: "VP-01",
        severity: "error",
        message: "get_vehicles returned all vehicles at (0, 0)",
        context: { count: zeroCount },
      },
    ];
  }

  return [
    {
      rule: "VP-01",
      severity: "warn",
      message: "get_vehicles returned some vehicles at (0, 0)",
      context: { count: zeroCount, total: vehicles.length },
    },
  ];
}
