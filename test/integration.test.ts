import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setupTestDb, cleanupTestDb, createTestConfig, getTextContent, getJsonContent, encodeTripUpdateFeed, encodeAlertFeed, encodeVehiclePositionFeed } from "./helpers.js";
import { formatLocalTime, GTFS_TIME_PATTERN } from "../src/time.js";

const AGENCY_TZ = "America/New_York";

// Mock static.ts before any imports use it
let testDb: any;
vi.mock("../src/gtfs/static.js", () => ({
  ensureGtfsLoaded: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockImplementation(() => testDb),
}));

// Must import createServer AFTER vi.mock
const { createServer } = await import("../src/server.js");

const testConfig = createTestConfig();

let client: Client;
let dbDir: string;
let s1nArrivalSecs: number;
let s2ArrivalSecs: number;
let s3ArrivalSecs: number;

beforeAll(async () => {
  const result = await setupTestDb();
  testDb = result.db;
  dbDir = result.dir;

  // Mock realtime fetch to return test protobuf data
  // Store timestamps so tests can assert actual time values
  const nowSecs = Math.floor(Date.now() / 1000);
  s1nArrivalSecs = nowSecs + 300;
  s2ArrivalSecs = nowSecs + 600;
  s3ArrivalSecs = nowSecs + 1200;

  const tripUpdateData = encodeTripUpdateFeed([
    {
      tripId: "T1",
      routeId: "R1",
      stopTimeUpdates: [
        // S1N has realtime data (for parent station resolution test)
        { stopId: "S1N", arrivalTime: s1nArrivalSecs, arrivalDelay: 60 },
        { stopId: "S2", arrivalTime: s2ArrivalSecs, arrivalDelay: 120 },
        { stopId: "S3", arrivalTime: s3ArrivalSecs, arrivalDelay: 180 },
      ],
    },
    {
      // Trip with a stop time update that has departure but no arrival time.
      // Exercises the unset/zero arrival time handling — should be skipped by get_arrivals.
      tripId: "T2",
      routeId: "R1",
      stopTimeUpdates: [
        { stopId: "S2", departureTime: nowSecs + 610, departureDelay: 120 },
      ],
    },
    {
      tripId: "T_RT_ONLY",
      routeId: "R2",
      stopTimeUpdates: [
        { stopId: "S2", arrivalTime: s2ArrivalSecs, arrivalDelay: 30 },
        { stopId: "S3", arrivalTime: s3ArrivalSecs, arrivalDelay: 45 },
      ],
    },
  ]);

  const alertData = encodeAlertFeed([
    {
      id: "alert-1",
      headerText: "Delay on Route 1",
      descriptionText: "Expect 10 minute delays",
      informedEntities: [{ routeId: "R1" }],
    },
    {
      id: "alert-2",
      headerText: "Station closure",
      descriptionText: "S3 closed this weekend",
      informedEntities: [{ stopId: "S3" }],
    },
  ]);

  const vehicleData = encodeVehiclePositionFeed([
    {
      vehicleId: "V1",
      tripId: "T1",
      routeId: "R1",
      latitude: 40.72,
      longitude: -74.01,
      bearing: 180,
      timestamp: Math.floor(Date.now() / 1000),
    },
    {
      vehicleId: "V2",
      tripId: "T3",
      routeId: "R2",
      latitude: 40.71,
      longitude: -74.00,
    },
  ]);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const urlStr = String(url);
    let body: Uint8Array;
    if (urlStr.includes("trip-updates")) {
      body = tripUpdateData;
    } else if (urlStr.includes("alerts")) {
      body = alertData;
    } else if (urlStr.includes("vehicle-positions")) {
      body = vehicleData;
    } else {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(body, { status: 200 });
  });

  const server = createServer(testConfig);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
}, 30_000);

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(dbDir);
});

/** Convert UNIX seconds to HH:MM:SS in the agency's timezone (matching the server's output format). */
function toLocalTimeString(unixSecs: number): string {
  return formatLocalTime(new Date(unixSecs * 1000), AGENCY_TZ);
}

describe("list_systems", () => {
  it("returns configured systems", async () => {
    const result = await client.callTool({ name: "list_systems", arguments: {} });
    const systems = getJsonContent(result);
    expect(systems).toEqual([{ id: "test", name: "Test Transit" }]);
  });
});

describe("search_stops", () => {
  it("finds stops by name", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "test", query: "Central" },
    });
    const stops = getJsonContent(result);
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(stops[0]).toHaveProperty("stop_id");
    expect(stops[0]).toHaveProperty("name");
    expect(stops[0]).toHaveProperty("lat");
    expect(stops[0]).toHaveProperty("lon");
  });

  it("excludes child platforms when their parent station matches", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "test", query: "Central" },
    });
    const ids = getJsonContent(result).map((s: any) => s.stop_id);
    expect(ids).toContain("S1");
    expect(ids).not.toContain("S1N");
    expect(ids).not.toContain("S1S");
  });

  it("returns error for unknown system", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "nonexistent", query: "test" },
    });
    expect(getTextContent(result)).toContain("Unknown system");
  });
});

describe("find_nearby_stops", () => {
  it("returns parent stations ordered by distance, excluding child platforms", async () => {
    // Point is exactly at S1 (Central Station parent, 40.7128, -74.0060)
    const result = await client.callTool({
      name: "find_nearby_stops",
      arguments: { system: "test", lat: 40.7128, lon: -74.0060, radius_m: 2000 },
    });
    const stops = getJsonContent(result);
    const ids = stops.map((s: any) => s.stop_id);
    // S1 (parent) included; S1N and S1S (children) excluded
    expect(ids).toContain("S1");
    expect(ids).not.toContain("S1N");
    expect(ids).not.toContain("S1S");
    // S1 is closer than S2 (Park Avenue, ~1km away)
    expect(ids.indexOf("S1")).toBeLessThan(ids.indexOf("S2"));
    expect(stops[0].distance_m).toBeLessThan(10);
  });

  it("respects radius_m", async () => {
    // Tight radius around S1 excludes S2 (~1km away)
    const result = await client.callTool({
      name: "find_nearby_stops",
      arguments: { system: "test", lat: 40.7128, lon: -74.0060, radius_m: 100 },
    });
    const stops = getJsonContent(result);
    const ids = stops.map((s: any) => s.stop_id);
    expect(ids).toContain("S1");
    expect(ids).not.toContain("S2");
  });

  it("returns empty when nothing is in range", async () => {
    const result = await client.callTool({
      name: "find_nearby_stops",
      arguments: { system: "test", lat: 0, lon: 0, radius_m: 1000 },
    });
    expect(getJsonContent(result)).toEqual([]);
  });
});

describe("get_stop", () => {
  it("returns stop details with routes", async () => {
    const result = await client.callTool({
      name: "get_stop",
      arguments: { system: "test", stop_id: "S1N" },
    });
    const data = getJsonContent(result);
    expect(data.stop.name).toBe("Central Station North");
    expect(data.stop.parent_station).toBe("S1");
    expect(data.routes.length).toBeGreaterThanOrEqual(1);
  });

  it("returns not found for invalid stop", async () => {
    const result = await client.callTool({
      name: "get_stop",
      arguments: { system: "test", stop_id: "INVALID" },
    });
    expect(getTextContent(result)).toContain("not found");
  });
});

describe("list_routes", () => {
  it("returns all routes", async () => {
    const result = await client.callTool({
      name: "list_routes",
      arguments: { system: "test" },
    });
    const routes = getJsonContent(result);
    expect(routes.length).toBe(2);
    expect(routes[0]).toHaveProperty("route_id");
    expect(routes[0]).toHaveProperty("short_name");
  });

  it("filters by route_type", async () => {
    const result = await client.callTool({
      name: "list_routes",
      arguments: { system: "test", route_type: 1 },
    });
    const routes = getJsonContent(result);
    expect(routes.length).toBe(1);
    expect(routes[0].route_id).toBe("R1");
  });
});

describe("get_route", () => {
  it("returns route with ordered stops", async () => {
    const result = await client.callTool({
      name: "get_route",
      arguments: { system: "test", route_id: "R1", direction_id: 0 },
    });
    const data = getJsonContent(result);
    expect(data.route.route_id).toBe("R1");
    expect(data.stops.map((s: any) => s.stop_id)).toEqual(["S1N", "S2", "S3"]);
  });

  it("picks the longest trip variant when multiple exist for the same direction", async () => {
    const result = await client.callTool({
      name: "get_route",
      arguments: { system: "test", route_id: "R1", direction_id: 0 },
    });
    const ids = getJsonContent(result).stops.map((s: any) => s.stop_id);
    expect(ids).toEqual(["S1N", "S2", "S3"]);
  });

  it("returns not found for invalid route", async () => {
    const result = await client.callTool({
      name: "get_route",
      arguments: { system: "test", route_id: "INVALID" },
    });
    expect(getTextContent(result)).toContain("not found");
  });
});

describe("get_arrivals", () => {
  it("returns realtime arrivals with correct local times", async () => {
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S2" },
    });
    const arrivals = getJsonContent(result);
    expect(arrivals.length).toBeGreaterThanOrEqual(1);

    // Should be realtime-only (no scheduled mix)
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(true);
      expect(a.minutes_away).toBeTypeOf("number");
      // Times must be HH:MM:SS local format, not ISO/UTC
      expect(a.arrival_time).toMatch(GTFS_TIME_PATTERN);
    }

    const t1Arrival = arrivals.find((a: any) => a.trip_id === "T1");
    expect(t1Arrival).toBeDefined();
    // minutes_away should be roughly 10 (600s from now)
    expect(t1Arrival.minutes_away).toBeGreaterThanOrEqual(9);
    expect(t1Arrival.minutes_away).toBeLessThanOrEqual(11);
    // Assert actual time value matches the fixture timestamp
    expect(t1Arrival.arrival_time).toBe(toLocalTimeString(s2ArrivalSecs));
    // Headsign derived from last stop in trip update (S3 = Times Square)
    expect(t1Arrival.headsign).toBe("Times Square");
  });

  it("resolves parent station to child stops for realtime arrivals", async () => {
    // S1 is a parent station with children S1N and S1S.
    // Realtime data has an update for S1N. Querying with parent ID S1
    // should resolve to children and return the S1N arrival.
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1" },
    });
    const arrivals = getJsonContent(result);
    expect(arrivals.length).toBeGreaterThanOrEqual(1);

    const s1nArrival = arrivals.find((a: any) => a.stop_id === "S1N");
    expect(s1nArrival).toBeDefined();
    expect(s1nArrival.is_realtime).toBe(true);
    expect(s1nArrival.arrival_time).toBe(toLocalTimeString(s1nArrivalSecs));
  });

  it("ignores stop time updates with no arrival time", async () => {
    // The fixture includes T2 with a stop time update for S2 that has only
    // departure time (no arrival). It should not produce an arrival entry.
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S2" },
    });
    const arrivals = getJsonContent(result);
    // T2's departure-only update should be skipped
    const t2Arrivals = arrivals.filter((a: any) => a.trip_id === "T2");
    expect(t2Arrivals.length).toBe(0);
    // T1's arrival should still be present
    const t1Arrivals = arrivals.filter((a: any) => a.trip_id === "T1");
    expect(t1Arrivals.length).toBe(1);
  });

  it("falls back to scheduled with HH:MM:SS local times", async () => {
    // S1S has no realtime data, so should fall back to scheduled.
    // Pin clock to 07:00 America/New_York so scheduled arrivals are in range.
    vi.useFakeTimers({ now: new Date("2026-04-20T07:00:00-04:00") });

    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1S" },
    });
    const arrivals = getJsonContent(result);
    expect(arrivals.length).toBeGreaterThanOrEqual(1);

    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
      expect(a.minutes_away).toBeNull();
      // Scheduled times must also be HH:MM:SS format
      expect(a.arrival_time).toMatch(GTFS_TIME_PATTERN);
    }

    // T2 arrives at S1S at 09:20:00 in fixtures
    const t2 = arrivals.find((a: any) => a.trip_id === "T2");
    expect(t2).toBeDefined();
    expect(t2.arrival_time).toBe("09:20:00");

    vi.useRealTimers();
  });

  it("excludes past scheduled arrivals", async () => {
    // Pin clock to 09:15 America/New_York — T2 at S1S departs at 09:20, so it should appear.
    // But T3 at S1N departs at 07:30 which is in the past.
    vi.useFakeTimers({ now: new Date("2026-04-20T09:15:00-04:00") });

    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1S" },
    });
    const arrivals = getJsonContent(result);

    for (const a of arrivals) {
      // All returned arrivals should be at or after 09:15:00
      expect(a.arrival_time >= "09:15:00").toBe(true);
    }

    vi.useRealTimers();
  });

  it("filters by route_id", async () => {
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S2", route_id: "R1" },
    });
    const arrivals = getJsonContent(result);
    for (const a of arrivals) {
      expect(a.route_id).toBe("R1");
    }
  });
});

describe("get_alerts", () => {
  it("returns all alerts", async () => {
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    const alerts = getJsonContent(result);
    expect(alerts.length).toBe(2);
    expect(alerts[0]).toHaveProperty("header");
    expect(alerts[0]).toHaveProperty("description");
    expect(alerts[0]).toHaveProperty("informed_entities");
  });

  it("filters by route_id", async () => {
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test", route_id: "R1" },
    });
    const alerts = getJsonContent(result);
    expect(alerts.length).toBe(1);
    expect(alerts[0].header).toBe("Delay on Route 1");
  });

  it("filters by stop_id", async () => {
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test", stop_id: "S3" },
    });
    const alerts = getJsonContent(result);
    expect(alerts.length).toBe(1);
    expect(alerts[0].header).toBe("Station closure");
  });
});

describe("get_vehicles", () => {
  it("returns vehicle positions", async () => {
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    const vehicles = getJsonContent(result);
    expect(vehicles.length).toBe(2);
    expect(vehicles[0]).toHaveProperty("vehicle_id");
    expect(vehicles[0]).toHaveProperty("latitude");
    expect(vehicles[0]).toHaveProperty("longitude");
  });

  it("filters by route_id", async () => {
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test", route_id: "R1" },
    });
    const vehicles = getJsonContent(result);
    expect(vehicles.length).toBe(1);
    expect(vehicles[0].vehicle_id).toBe("V1");
  });
});

describe("get_trip", () => {
  it("returns trip with stop times and realtime delays", async () => {
    const result = await client.callTool({
      name: "get_trip",
      arguments: { system: "test", trip_id: "T1" },
    });
    const data = getJsonContent(result);
    expect(data.trip.trip_id).toBe("T1");
    expect(data.trip.route_id).toBe("R1");
    expect(data.stop_times.length).toBe(3);

    // S2 should have realtime delay
    const s2 = data.stop_times.find((st: any) => st.stop_id === "S2");
    expect(s2?.is_realtime).toBe(true);
    expect(s2?.arrival_delay_seconds).toBe(120);

    // S1N also has realtime update
    const s1n = data.stop_times.find((st: any) => st.stop_id === "S1N");
    expect(s1n?.is_realtime).toBe(true);
    expect(s1n?.arrival_delay_seconds).toBe(60);
  });

  it("returns not found for invalid trip", async () => {
    const result = await client.callTool({
      name: "get_trip",
      arguments: { system: "test", trip_id: "INVALID" },
    });
    expect(getTextContent(result)).toContain("not found");
  });

  it("synthesises a response for trip_ids that exist only in realtime", async () => {
    const result = await client.callTool({
      name: "get_trip",
      arguments: { system: "test", trip_id: "T_RT_ONLY" },
    });
    const data = getJsonContent(result);
    expect(data.trip.trip_id).toBe("T_RT_ONLY");
    expect(data.trip.route_id).toBe("R2");
    expect(data.trip.service_id).toBeNull();
    // Headsign synthesised from the last stop's name (S3 = Times Square)
    expect(data.trip.trip_headsign).toBe("Times Square");
    expect(data.stop_times.length).toBe(2);
    for (const st of data.stop_times) {
      expect(st.is_realtime).toBe(true);
      expect(st.arrival_time).toMatch(GTFS_TIME_PATTERN);
    }
    expect(data.stop_times.map((st: any) => st.stop_id)).toEqual(["S2", "S3"]);
    expect(data.stop_times[0].arrival_delay_seconds).toBe(30);
    expect(data.stop_times[1].arrival_delay_seconds).toBe(45);
  });
});

describe("get_system_status", () => {
  it("returns system overview", async () => {
    const result = await client.callTool({
      name: "get_system_status",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result);
    expect(data.system_id).toBe("test");
    expect(data.system_name).toBe("Test Transit");
    expect(data.route_count).toBe(2);
    expect(data.stop_count).toBe(5);
    expect(data.active_alerts).toBe(2);
    expect(data.feeds).toHaveProperty("trip_updates");
    expect(data.feeds).toHaveProperty("alerts");
    expect(data.feeds).toHaveProperty("vehicle_positions");
  });
});
