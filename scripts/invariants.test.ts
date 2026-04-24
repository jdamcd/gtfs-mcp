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

function ok(tool: string, args: Record<string, unknown>, result: unknown): CallRecord {
  return { tool, args, ok: true, ms: 0, result };
}

function ruleIds(record: CallRecord, context: RunContext): string[] {
  return runInvariants(record, context).map((v) => v.rule);
}

describe("SYS-01 list_systems", () => {
  it("passes when ids match configured", () => {
    const rec = ok("list_systems", {}, [{ id: "test-sys", name: "Test System" }]);
    expect(ruleIds(rec, ctx())).toEqual([]);
  });

  it("flags missing or extra systems", () => {
    const rec = ok("list_systems", {}, [{ id: "wrong", name: "Wrong" }]);
    expect(ruleIds(rec, ctx())).toEqual(["SYS-01"]);
  });
});

describe("RT-01 list_routes duplicates", () => {
  it("passes on unique route_ids and records observed routes", () => {
    const c = ctx();
    const rec = ok("list_routes", {}, [
      { route_id: "R1" },
      { route_id: "R2" },
    ]);
    expect(ruleIds(rec, c)).toEqual([]);
    expect(c.observedRouteIds.has("R1")).toBe(true);
    expect(c.listRoutesCount).toBe(2);
  });

  it("flags duplicates", () => {
    const rec = ok("list_routes", {}, [
      { route_id: "R1" },
      { route_id: "R1" },
    ]);
    expect(ruleIds(rec, ctx())).toEqual(["RT-01"]);
  });

  it("does not set listRoutesCount when filtered by route_type", () => {
    const c = ctx();
    runInvariants(ok("list_routes", { route_type: 1 }, [{ route_id: "R1" }]), c);
    expect(c.listRoutesCount).toBeNull();
  });
});

describe("RT-02 / RT-03 get_route", () => {
  it("flags mismatched route_id", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R2" },
      stops: [],
    });
    expect(ruleIds(rec, ctx())).toContain("RT-03");
  });

  it("flags duplicate stops", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R1" },
      stops: [{ stop_id: "S1" }, { stop_id: "S2" }, { stop_id: "S1" }],
    });
    expect(ruleIds(rec, ctx())).toContain("RT-02");
  });

  it("passes on clean response", () => {
    const rec = ok("get_route", { route_id: "R1" }, {
      route: { route_id: "R1" },
      stops: [{ stop_id: "S1" }, { stop_id: "S2" }],
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("ST-01 / ST-03 search_stops + get_stop", () => {
  it("flags parent+child appearing together in search_stops", () => {
    const c = ctx();
    runInvariants(
      ok("search_stops", { query: "Central" }, [
        { stop_id: "631" },
        { stop_id: "631N" },
        { stop_id: "631S" },
      ]),
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
      ok("search_stops", { query: "Central" }, [{ stop_id: "S1" }]),
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
  it("flags non-HH:MM:SS arrival_time", () => {
    const rec = ok("get_arrivals", {}, [
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00", is_realtime: true },
    ]);
    expect(ruleIds(rec, ctx())).toContain("AR-01");
  });

  it("flags unsorted arrivals", () => {
    const rec = ok("get_arrivals", {}, [
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:10:00", is_realtime: true },
      { trip_id: "T2", stop_id: "S1", arrival_time: "08:05:00", is_realtime: true },
    ]);
    expect(ruleIds(rec, ctx())).toContain("AR-04");
  });

  it("flags duplicate (trip_id, stop_id)", () => {
    const rec = ok("get_arrivals", {}, [
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:00:00", is_realtime: true },
      { trip_id: "T1", stop_id: "S1", arrival_time: "08:01:00", is_realtime: true },
    ]);
    expect(ruleIds(rec, ctx())).toContain("AR-03");
  });

  it("records realtime trip_ids for X-ARR-TRIP cross-check", () => {
    const c = ctx();
    runInvariants(
      ok("get_arrivals", {}, [
        { trip_id: "RT-1", stop_id: "S1", arrival_time: "08:00:00", is_realtime: true },
        { trip_id: "SCH-1", stop_id: "S1", arrival_time: "08:05:00", is_realtime: false },
      ]),
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
    const c = ctx({ observedRouteIds: new Set(["R1"]) });
    expect(ruleIds(rec, c)).toContain("TP-03");
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
    const c = ctx({ observedRouteIds: new Set(["R1"]) });
    expect(ruleIds(rec, c)).toContain("TP-01");
  });

  it("flags X-TRIP-ROUTE when route_id is unknown to list_routes", () => {
    const rec = ok("get_trip", { trip_id: "T1" }, {
      trip: { trip_id: "T1", route_id: "R9" },
      stop_times: [],
    });
    const c = ctx({ observedRouteIds: new Set(["R1", "R2"]) });
    expect(ruleIds(rec, c)).toContain("X-TRIP-ROUTE");
  });

  it("allows null route_id (synthesised RT-only trips)", () => {
    const rec = ok("get_trip", { trip_id: "SYN" }, {
      trip: { trip_id: "SYN", route_id: null },
      stop_times: [],
    });
    const c = ctx({ observedRouteIds: new Set(["R1"]) });
    expect(ruleIds(rec, c)).toEqual([]);
  });
});

describe("AL-01 / X-ALERT-ROUTE get_alerts", () => {
  it("flags AL-01 on empty header+description", () => {
    const rec = ok("get_alerts", {}, [{ id: "a1", header: "", description: "" }]);
    expect(ruleIds(rec, ctx())).toContain("AL-01");
  });

  it("passes when one of header/description is populated", () => {
    const rec = ok("get_alerts", {}, [
      { id: "a1", header: "Delay", description: "" },
    ]);
    expect(ruleIds(rec, ctx())).toEqual([]);
  });

  it("warns on unknown route_id in informed_entities", () => {
    const rec = ok("get_alerts", {}, [
      {
        id: "a1",
        header: "h",
        description: "d",
        informed_entities: [{ route_id: "R9" }],
      },
    ]);
    const c = ctx({ observedRouteIds: new Set(["R1"]) });
    expect(ruleIds(rec, c)).toContain("X-ALERT-ROUTE");
  });

  it("does not fire X-ALERT-ROUTE when list_routes hasn't been seen yet", () => {
    const rec = ok("get_alerts", {}, [
      {
        id: "a1",
        header: "h",
        description: "d",
        informed_entities: [{ route_id: "R9" }],
      },
    ]);
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("VP-01 get_vehicles", () => {
  it("flags as error when every vehicle is at (0, 0)", () => {
    const rec = ok("get_vehicles", {}, [
      { vehicle_id: "V1", latitude: 0, longitude: 0 },
      { vehicle_id: "V2", latitude: 0, longitude: 0 },
    ]);
    const violations = runInvariants(rec, ctx());
    expect(violations[0]?.rule).toBe("VP-01");
    expect(violations[0]?.severity).toBe("error");
  });

  it("warns when only some vehicles are at (0, 0)", () => {
    const rec = ok("get_vehicles", {}, [
      { vehicle_id: "V1", latitude: 0, longitude: 0 },
      { vehicle_id: "V2", latitude: 40.7, longitude: -74.0 },
    ]);
    const violations = runInvariants(rec, ctx());
    expect(violations[0]?.rule).toBe("VP-01");
    expect(violations[0]?.severity).toBe("warn");
  });

  it("passes when all vehicles have real coordinates", () => {
    const rec = ok("get_vehicles", {}, [
      { vehicle_id: "V1", latitude: 40.7, longitude: -74.0 },
    ]);
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});

describe("CFG-01 get_system_status vs list_routes", () => {
  it("flags mismatch between route_count and list_routes length", () => {
    const c = ctx({ listRoutesCount: 5 });
    const rec = ok("get_system_status", {}, {
      system_id: "test-sys",
      route_count: 7,
    });
    expect(ruleIds(rec, c)).toContain("CFG-01");
  });

  it("passes when counts match", () => {
    const c = ctx({ listRoutesCount: 5 });
    const rec = ok("get_system_status", {}, {
      system_id: "test-sys",
      route_count: 5,
    });
    expect(ruleIds(rec, c)).toEqual([]);
  });

  it("skips when list_routes has not run yet", () => {
    const rec = ok("get_system_status", {}, {
      system_id: "test-sys",
      route_count: 5,
    });
    expect(ruleIds(rec, ctx())).toEqual([]);
  });
});
