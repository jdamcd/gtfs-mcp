import { describe, it, expect } from "vitest";
import {
  createRunContext,
  runInvariants,
  type CallRecord,
  type RunContext,
} from "./invariants.js";

function ctx(overrides: Partial<RunContext> = {}): RunContext {
  const base = createRunContext("test-sys", [{ id: "test-sys", name: "Test System" }]);
  return { ...base, ...overrides };
}

// A context in which list_routes has listed exactly these routes.
function listed(routeIds: string[]): RunContext {
  return ctx({ listedRouteIds: new Set(routeIds), listedRouteTotal: routeIds.length });
}

function ok(tool: string, args: Record<string, unknown>, result: unknown): CallRecord {
  return { tool, args, ok: true, ms: 0, result };
}

function errorResult(tool: string, args: Record<string, unknown>, text: string): CallRecord {
  return { tool, args, ok: true, ms: 0, result: text, isError: true };
}

function ruleIds(record: CallRecord, context: RunContext): string[] {
  return runInvariants(record, context).map((v) => v.rule);
}

describe("MCP-01 error results", () => {
  it("flags output that failed the tool's outputSchema", () => {
    const rec = errorResult(
      "get_vehicles",
      {},
      "Output validation error: Invalid structured content for tool get_vehicles: speed: expected number"
    );
    expect(ruleIds(rec, ctx())).toEqual(["MCP-01"]);
  });

  it("leaves other error results to the per-tool rules", () => {
    const rec = errorResult("get_alerts", {}, "The alerts feed for test-sys could not be fetched (HTTP 503).");
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("X-STOP stop_id round trip", () => {
  it("flags a stop tool rejecting a stop that get_route returned", () => {
    const c = ctx();
    runInvariants(
      ok("get_route", { route_id: "R1" }, {
        route: { route_id: "R1" },
        directions: [{ direction_id: 0, stops: [{ stop_id: "S1N" }] }],
      }),
      c
    );
    for (const tool of ["get_stop", "get_arrivals", "get_alerts"]) {
      const rec = errorResult(tool, { stop_id: "S1N" }, "Stop not found: S1N. Use search_stops by name.");
      expect(ruleIds(rec, c)).toEqual(["X-STOP"]);
    }
  });

  it("counts a stop's parent station as handed out", () => {
    const c = ctx();
    runInvariants(
      ok("get_stop", { stop_id: "S1N" }, { stop: { stop_id: "S1N", parent_station: "S1" }, routes: [] }),
      c
    );
    const rec = errorResult("get_alerts", { stop_id: "S1" }, "Stop not found: S1.");
    expect(ruleIds(rec, c)).toEqual(["X-STOP"]);
  });

  it("allows not-found for a stop no tool returned", () => {
    const rec = errorResult("get_arrivals", { stop_id: "TYPO" }, "Stop not found: TYPO.");
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("SYS-01 list_systems", () => {
  it("passes when ids match configured", () => {
    const rec = ok("list_systems", {}, { systems: [{ id: "test-sys", name: "Test System" }] });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });

  it("flags missing or extra systems", () => {
    const rec = ok("list_systems", {}, { systems: [{ id: "wrong", name: "Wrong" }] });
    expect(ruleIds(rec, ctx())).toEqual(["SYS-01"]);
  });
});

describe("RT-01 list_routes duplicates", () => {
  it("passes on unique route_ids and records observed routes", () => {
    const c = ctx();
    const rec = ok("list_routes", {}, {
      total: 2,
      routes: [{ route_id: "R1" }, { route_id: "R2" }],
    });
    expect(ruleIds(rec, c)).toEqual([]);
    expect(c.listedRouteIds.has("R1")).toBe(true);
    expect(c.listedRouteTotal).toBe(2);
  });

  it("only counts unfiltered calls toward the full listing", () => {
    const c = ctx();
    runInvariants(ok("list_routes", { route_type: 3 }, { total: 1, routes: [{ route_id: "R1" }] }), c);
    expect(c.listedRouteIds.size).toBe(0);
    expect(c.listedRouteTotal).toBeNull();
  });

  it("flags duplicates", () => {
    const rec = ok("list_routes", {}, {
      total: 2,
      routes: [{ route_id: "R1" }, { route_id: "R1" }],
    });
    expect(ruleIds(rec, ctx())).toEqual(["RT-01"]);
  });
});

describe("RT-02 / RT-03 get_route", () => {
  it("flags mismatched route_id", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R2" },
      directions: [],
    });
    expect(ruleIds(rec, ctx())).toContain("RT-03");
  });

  it("flags duplicate stops within a direction", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R1" },
      directions: [
        { direction_id: 0, stops: [{ stop_id: "S1" }, { stop_id: "S2" }, { stop_id: "S1" }] },
      ],
    });
    expect(ruleIds(rec, ctx())).toContain("RT-02");
  });

  it("flags RT-04 when a direction other than the requested one comes back", () => {
    const rec = ok("get_route", { route_id: "R1", direction_id: 0 }, {
      route: { route_id: "R1" },
      directions: [
        { direction_id: 0, stops: [] },
        { direction_id: 1, stops: [] },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual(["RT-04"]);
  });

  it("flags RT-04 when a direction_id repeats", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R1" },
      directions: [
        { direction_id: 0, stops: [] },
        { direction_id: 0, stops: [] },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual(["RT-04"]);
  });

  it("passes on clean response, including a stop shared by both directions", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R1" },
      directions: [
        { direction_id: 0, stops: [{ stop_id: "S1" }, { stop_id: "S2" }] },
        { direction_id: 1, stops: [{ stop_id: "S2" }, { stop_id: "S1" }] },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("ST-04 / ST-05 search_stops matching and order", () => {
  const search = (query: string, names: string[]) =>
    ok("search_stops", { query }, {
      stops: names.map((name, i) => ({ stop_id: `S${i}`, name })),
    });

  it("passes when prefix matches come first, ignoring ASCII case", () => {
    expect(ruleIds(search("park", ["Park Pl", "PARK ST", "15 St-Prospect Park"]), ctx())).toEqual([]);
  });

  it("flags ST-04 when a prefix match comes after a non-prefix one", () => {
    expect(ruleIds(search("Park", ["15 St-Prospect Park", "Park Pl"]), ctx())).toEqual(["ST-04"]);
  });

  it("flags ST-05 when a name doesn't contain the query", () => {
    expect(ruleIds(search("%", ["Central"]), ctx())).toEqual(["ST-05"]);
  });
});

describe("ST-01 / ST-03 search_stops + get_stop", () => {
  it("flags parent+child appearing together in search_stops", () => {
    const c = ctx();
    runInvariants(
      ok("search_stops", { query: "Central" }, {
        stops: [
          { stop_id: "631" },
          { stop_id: "631N" },
          { stop_id: "631S" },
        ],
      }),
      c
    );
    const rec = ok("get_stop", { stop_id: "631N" }, {
      stop: { stop_id: "631N", parent_station: "631" },
      routes: [],
    });
    expect(ruleIds(rec, c)).toContain("ST-01");
  });

  it("does not flag standalone stops with no parent", () => {
    const c = ctx();
    runInvariants(
      ok("search_stops", { query: "Central" }, { stops: [{ stop_id: "S1" }] }),
      c
    );
    const rec = ok("get_stop", { stop_id: "S1" }, {
      stop: { stop_id: "S1", parent_station: null },
      routes: [],
    });
    expect(ruleIds(rec, c)).toEqual([]);
  });

  it("flags get_stop id mismatch", () => {
    const rec = ok("get_stop", { stop_id: "S1" }, {
      stop: { stop_id: "S2", parent_station: null },
      routes: [],
    });
    expect(ruleIds(rec, ctx())).toContain("ST-03");
  });
});

describe("AR-01 / AR-03 / AR-04 get_arrivals", () => {
  const arrivalsResp = (arrivals: unknown[]) => ({ data_source: "realtime", arrivals });

  it("flags non-HH:MM:SS arrival_time", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00", is_realtime: true },
    ]));
    expect(ruleIds(rec, ctx())).toContain("AR-01");
  });

  it("flags unsorted arrivals", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:10:00", minutes_away: 20, is_realtime: true },
      { trip_id: "T2", stop_id: "S1", arrival_time: "08:05:00", minutes_away: 15, is_realtime: true },
    ]));
    expect(ruleIds(rec, ctx())).toContain("AR-04");
  });

  it("does not flag midnight-crossing arrivals with monotonic minutes_away", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "23:59:00", minutes_away: 29, is_realtime: true },
      { trip_id: "T2", stop_id: "S1", arrival_time: "00:05:00", minutes_away: 35, is_realtime: false },
    ]));
    expect(ruleIds(rec, ctx())).not.toContain("AR-04");
  });

  it("flags duplicate (trip_id, stop_id, arrival_time)", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00:00", is_realtime: true },
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00:00", is_realtime: true },
    ]));
    expect(ruleIds(rec, ctx())).toContain("AR-03");
  });

  it("allows loop trips that visit the same stop at different times", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "00:05:00", minutes_away: 5, is_realtime: false },
      { trip_id: "T1", stop_id: "S1", arrival_time: "00:29:00", minutes_away: 29, is_realtime: false },
    ]));
    expect(ruleIds(rec, ctx())).not.toContain("AR-03");
  });

  it("flags AR-05 when any arrival is in the past", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "07:40:00", minutes_away: -20, is_realtime: true },
      { trip_id: "T2", stop_id: "S1", arrival_time: "08:05:00", minutes_away: 5, is_realtime: true },
    ]));
    expect(ruleIds(rec, ctx())).toContain("AR-05");
  });

  it("accepts minutes_away of 0 as 'arriving now'", () => {
    const rec = ok("get_arrivals", {}, arrivalsResp([
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00:00", minutes_away: 0, is_realtime: true },
    ]));
    expect(ruleIds(rec, ctx())).not.toContain("AR-05");
  });

  it("records realtime trip_ids for X-ARR-TRIP cross-check", () => {
    const c = ctx();
    runInvariants(
      ok("get_arrivals", {}, arrivalsResp([
        { trip_id: "RT-1", stop_id: "S1", arrival_time: "08:00:00", is_realtime: true },
        { trip_id: "SCH-1", stop_id: "S1", arrival_time: "08:05:00", is_realtime: false },
      ])),
      c
    );
    expect(c.arrivalsTripIds.has("RT-1")).toBe(true);
    expect(c.arrivalsTripIds.has("SCH-1")).toBe(false);
  });
});

describe("TP-01 / TP-03 / X-ARR-TRIP / X-TRIP-ROUTE get_trip", () => {
  it("flags X-ARR-TRIP when get_trip not-found on an arrivals trip_id", () => {
    const c = ctx({ arrivalsTripIds: new Set(["RT-1"]) });
    const rec = ok("get_trip", { trip_id: "RT-1" }, "Trip not found: RT-1");
    expect(ruleIds(rec, c)).toEqual(["X-ARR-TRIP"]);
  });

  it("does not flag not-found for arbitrary trip_ids never seen in arrivals", () => {
    const rec = ok("get_trip", { trip_id: "INVALID" }, "Trip not found: INVALID");
    expect(ruleIds(rec, ctx())).toEqual([]);
  });

  it("flags TP-03 on id mismatch", () => {
    const rec = ok("get_trip", { trip_id: "T1" }, {
      trip: { trip_id: "T2", route_id: "R1" },
      stop_times: [],
    });
    expect(ruleIds(rec, listed(["R1"]))).toContain("TP-03");
  });

  it("flags TP-01 when stop_sequence regresses", () => {
    const rec = ok("get_trip", { trip_id: "T1" }, {
      trip: { trip_id: "T1", route_id: "R1" },
      stop_times: [
        { stop_id: "S1", stop_sequence: 1 },
        { stop_id: "S2", stop_sequence: 3 },
        { stop_id: "S3", stop_sequence: 2 },
      ],
    });
    expect(ruleIds(rec, listed(["R1"]))).toContain("TP-01");
  });

  it("flags X-TRIP-ROUTE when route_id is unknown to list_routes", () => {
    const rec = ok("get_trip", { trip_id: "T1" }, {
      trip: { trip_id: "T1", route_id: "R9" },
      stop_times: [],
    });
    expect(ruleIds(rec, listed(["R1", "R2"]))).toContain("X-TRIP-ROUTE");
  });

  it("skips X-TRIP-ROUTE until list_routes has listed every route", () => {
    const rec = ok("get_trip", { trip_id: "T1" }, {
      trip: { trip_id: "T1", route_id: "R9" },
      stop_times: [],
    });
    const c = ctx({ listedRouteIds: new Set(["R1"]), listedRouteTotal: 404 });
    expect(ruleIds(rec, c)).not.toContain("X-TRIP-ROUTE");
  });

  it("allows null route_id (synthesised RT-only trips)", () => {
    const rec = ok("get_trip", { trip_id: "SYN" }, {
      trip: { trip_id: "SYN", route_id: null },
      stop_times: [],
    });
    expect(ruleIds(rec, listed(["R1"]))).toEqual([]);
  });
});

describe("AL-01 / X-ALERT-ROUTE get_alerts", () => {
  it("flags AL-01 on empty header+description", () => {
    const rec = ok("get_alerts", {}, { alerts: [{ id: "a1", header: "", description: "" }] });
    expect(ruleIds(rec, ctx())).toContain("AL-01");
  });

  it("passes when one of header/description is populated", () => {
    const rec = ok("get_alerts", {}, {
      alerts: [
        { id: "a1", header: "Delay", description: "" },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });

  it("warns on unknown route_id in informed_entities", () => {
    const rec = ok("get_alerts", {}, {
      alerts: [
        {
          id: "a1",
          header: "h",
          description: "d",
          informed_entities: [{ route_id: "R9" }],
        },
      ],
    });
    expect(ruleIds(rec, listed(["R1"]))).toContain("X-ALERT-ROUTE");
  });

  it("does not fire X-ALERT-ROUTE on a partial list_routes listing", () => {
    const rec = ok("get_alerts", {}, {
      alerts: [
        {
          id: "a1",
          header: "h",
          description: "d",
          informed_entities: [{ route_id: "R9" }],
        },
      ],
    });
    const c = ctx({ listedRouteIds: new Set(["R1"]), listedRouteTotal: 404 });
    expect(ruleIds(rec, c)).toEqual([]);
  });

  it("does not fire X-ALERT-ROUTE when list_routes hasn't been seen yet", () => {
    const rec = ok("get_alerts", {}, {
      alerts: [
        {
          id: "a1",
          header: "h",
          description: "d",
          informed_entities: [{ route_id: "R9" }],
        },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("VP-01 get_vehicles", () => {
  it("flags as error when every vehicle is at (0, 0)", () => {
    const rec = ok("get_vehicles", {}, {
      vehicles: [
        { vehicle_id: "V1", latitude: 0, longitude: 0 },
        { vehicle_id: "V2", latitude: 0, longitude: 0 },
      ],
    });
    const violations = runInvariants(rec, ctx());
    expect(violations[0]?.rule).toBe("VP-01");
    expect(violations[0]?.severity).toBe("error");
  });

  it("warns when only some vehicles are at (0, 0)", () => {
    const rec = ok("get_vehicles", {}, {
      vehicles: [
        { vehicle_id: "V1", latitude: 0, longitude: 0 },
        { vehicle_id: "V2", latitude: 40.7, longitude: -74.0 },
      ],
    });
    const violations = runInvariants(rec, ctx());
    expect(violations[0]?.rule).toBe("VP-01");
    expect(violations[0]?.severity).toBe("warn");
  });

  it("passes when all vehicles have real coordinates", () => {
    const rec = ok("get_vehicles", {}, {
      vehicles: [
        { vehicle_id: "V1", latitude: 40.7, longitude: -74.0 },
      ],
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});
