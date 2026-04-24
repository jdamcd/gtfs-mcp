// Invariants cover MCP contract correctness — shapes, ids that round-trip
// across tools, internal consistency. NOT GTFS data quality.

import { GTFS_TIME_PATTERN } from "../src/time.js";

export type CallRecord = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  result?: unknown;
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
  observedRouteIds: Set<string>;
  observedStopIds: Set<string>;
  observedTripIds: Set<string>;
  /** trip_ids reported as realtime by get_arrivals — get_trip must resolve these */
  arrivalsTripIds: Set<string>;
  /** Most recent search_stops result set, for the parent/child cross-check */
  lastSearchStopIds: Set<string> | null;
  /** Unfiltered list_routes length, for CFG-01 */
  listRoutesCount: number | null;
};

export function createRunContext(
  systemId: string,
  configuredSystems: Array<{ id: string; name: string }>
): RunContext {
  return {
    systemId,
    configuredSystems,
    observedRouteIds: new Set(),
    observedStopIds: new Set(),
    observedTripIds: new Set(),
    arrivalsTripIds: new Set(),
    lastSearchStopIds: null,
    listRoutesCount: null,
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

type InvariantFn = (record: CallRecord, ctx: RunContext) => Violation[];

const checks: Record<string, InvariantFn> = {
  list_systems: checkListSystems,
  list_routes: checkListRoutes,
  get_route: checkGetRoute,
  search_stops: trackSearchStops,
  get_stop: checkGetStop,
  get_arrivals: checkGetArrivals,
  get_trip: checkGetTrip,
  get_alerts: checkGetAlerts,
  get_vehicles: checkGetVehicles,
  get_system_status: checkGetSystemStatus,
};

export function runInvariants(record: CallRecord, ctx: RunContext): Violation[] {
  const fn = checks[record.tool];
  return fn ? fn(record, ctx) : [];
}

function checkListSystems(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || !Array.isArray(record.result)) return [];
  const got = new Set((record.result as any[]).map((s) => s?.id));
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
  if (!record.ok || !Array.isArray(record.result)) return [];
  const routes = record.result as any[];
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

  for (const id of ids) ctx.observedRouteIds.add(id);
  if (record.args.route_type === undefined) {
    ctx.listRoutesCount = routes.length;
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

  const stops: any[] = Array.isArray(data.stops) ? data.stops : [];
  const stopIds = stops.map((s) => s?.stop_id).filter((id): id is string => typeof id === "string");
  const dupes = findDuplicates(stopIds);
  if (dupes.length > 0) {
    violations.push({
      rule: "RT-02",
      severity: "error",
      message: "get_route.stops contains duplicate stop_ids",
      context: { duplicates: dupes },
    });
  }

  if (typeof data.route?.route_id === "string") ctx.observedRouteIds.add(data.route.route_id);
  for (const id of stopIds) ctx.observedStopIds.add(id);

  return violations;
}

function trackSearchStops(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || !Array.isArray(record.result)) return [];
  const ids = (record.result as any[])
    .map((s) => s?.stop_id)
    .filter((id): id is string => typeof id === "string");
  ctx.lastSearchStopIds = new Set(ids);
  return [];
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
  if (Array.isArray(data.routes)) {
    for (const r of data.routes) {
      if (typeof r?.route_id === "string") ctx.observedRouteIds.add(r.route_id);
    }
  }

  return violations;
}

function checkGetArrivals(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || !Array.isArray(record.result)) return [];
  const arrivals = record.result as any[];
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

  for (let i = 1; i < arrivals.length; i++) {
    const prev = arrivals[i - 1].arrival_time;
    const curr = arrivals[i].arrival_time;
    if (
      typeof prev === "string" &&
      typeof curr === "string" &&
      GTFS_TIME_PATTERN.test(prev) &&
      GTFS_TIME_PATTERN.test(curr) &&
      curr < prev
    ) {
      violations.push({
        rule: "AR-04",
        severity: "warn",
        message: "get_arrivals not sorted ascending by arrival_time",
        context: { index: i, prev, curr },
      });
      break;
    }
  }

  const seen = new Set<string>();
  for (const a of arrivals) {
    const key = `${a.trip_id}|${a.stop_id}`;
    if (seen.has(key)) {
      violations.push({
        rule: "AR-03",
        severity: "error",
        message: "get_arrivals contains duplicate (trip_id, stop_id)",
        context: { trip_id: a.trip_id, stop_id: a.stop_id },
      });
      break;
    }
    seen.add(key);
  }

  for (const a of arrivals) {
    if (typeof a.trip_id === "string" && a.is_realtime) ctx.arrivalsTripIds.add(a.trip_id);
    if (typeof a.route_id === "string" && a.route_id !== "unknown") {
      ctx.observedRouteIds.add(a.route_id);
    }
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
  if (
    typeof routeId === "string" &&
    ctx.observedRouteIds.size > 0 &&
    !ctx.observedRouteIds.has(routeId)
  ) {
    violations.push({
      rule: "X-TRIP-ROUTE",
      severity: "warn",
      message: "get_trip.route_id not in observed routes from list_routes",
      context: { route_id: routeId },
    });
  }

  if (typeof tripId === "string") ctx.observedTripIds.add(tripId);

  return violations;
}

function checkGetAlerts(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || !Array.isArray(record.result)) return [];
  const alerts = record.result as any[];
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

  if (ctx.observedRouteIds.size > 0) {
    const unknown = new Set<string>();
    for (const a of alerts) {
      for (const ie of a.informed_entities ?? []) {
        if (typeof ie?.route_id === "string" && !ctx.observedRouteIds.has(ie.route_id)) {
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
  if (!record.ok || !Array.isArray(record.result)) return [];
  const vehicles = record.result as any[];
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

function checkGetSystemStatus(record: CallRecord, ctx: RunContext): Violation[] {
  if (!record.ok || typeof record.result !== "object" || record.result == null) return [];
  const data = record.result as any;
  if (ctx.listRoutesCount != null && data.route_count !== ctx.listRoutesCount) {
    return [
      {
        rule: "CFG-01",
        severity: "error",
        message: "get_system_status.route_count does not match list_routes length",
        context: { system_status: data.route_count, list_routes: ctx.listRoutesCount },
      },
    ];
  }
  return [];
}
