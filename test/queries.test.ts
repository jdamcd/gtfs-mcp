import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, cleanupTestDb } from "./helpers.js";
import {
  searchStops,
  getStopDetails,
  getScheduledArrivals,
  resolveStopIds,
  listRoutes,
  getRouteDetails,
  getTripDetails,
} from "../src/gtfs/queries.js";

let db: any;
let dbDir: string;

beforeAll(async () => {
  const result = await setupTestDb();
  db = result.db;
  dbDir = result.dir;
}, 30_000);

afterAll(() => {
  cleanupTestDb(dbDir);
});

describe("searchStops", () => {
  it("finds stops by partial name match", () => {
    const results = searchStops(db, "Central");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((s) => s.stop_name.includes("Central"))).toBe(true);
  });

  it("is case-insensitive (SQLite LIKE)", () => {
    const results = searchStops(db, "central");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("respects limit", () => {
    const results = searchStops(db, "Station", 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("returns empty array for no matches", () => {
    const results = searchStops(db, "Nonexistent Stop XYZ");
    expect(results).toEqual([]);
  });

  it("returns expected fields", () => {
    const results = searchStops(db, "Park");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const stop = results[0];
    expect(stop).toHaveProperty("stop_id");
    expect(stop).toHaveProperty("stop_name");
    expect(stop).toHaveProperty("stop_lat");
    expect(stop).toHaveProperty("stop_lon");
  });
});

describe("getStopDetails", () => {
  it("returns stop and routes for a valid stop", () => {
    const details = getStopDetails(db, "S1N");
    expect(details.stop).not.toBeNull();
    expect(details.stop!.stop_name).toBe("Central Station North");
    expect(details.routes.length).toBeGreaterThanOrEqual(1);
  });

  it("includes parent_station info", () => {
    const details = getStopDetails(db, "S1N");
    expect(details.stop!.parent_station).toBe("S1");
  });

  it("returns null stop for invalid stop_id", () => {
    const details = getStopDetails(db, "INVALID");
    expect(details.stop).toBeNull();
    expect(details.routes).toEqual([]);
  });

  it("finds routes serving the stop", () => {
    // S1N is served by R1 (trip T1) and R2 (trip T3)
    const details = getStopDetails(db, "S1N");
    const routeIds = details.routes.map((r) => r.route_id);
    expect(routeIds).toContain("R1");
    expect(routeIds).toContain("R2");
  });
});

describe("resolveStopIds", () => {
  it("returns child stop IDs for a parent station", () => {
    const ids = resolveStopIds(db, "S1");
    expect(ids).toContain("S1N");
    expect(ids).toContain("S1S");
    expect(ids).not.toContain("S1");
  });

  it("returns the stop ID itself for a non-parent stop", () => {
    const ids = resolveStopIds(db, "S2");
    expect(ids).toEqual(["S2"]);
  });

  it("returns the stop ID itself for an unknown stop", () => {
    const ids = resolveStopIds(db, "UNKNOWN");
    expect(ids).toEqual(["UNKNOWN"]);
  });
});

describe("getScheduledArrivals", () => {
  it("returns arrivals for a stop", () => {
    const arrivals = getScheduledArrivals(db, ["S2"]);
    expect(arrivals.length).toBeGreaterThanOrEqual(1);
    expect(arrivals[0]).toHaveProperty("trip_id");
    expect(arrivals[0]).toHaveProperty("arrival_time");
    expect(arrivals[0]).toHaveProperty("route_id");
  });

  it("returns arrivals for multiple stop IDs", () => {
    const arrivals = getScheduledArrivals(db, ["S1N", "S1S"]);
    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    const stopIds = new Set(arrivals.map((a) => a.stop_id));
    expect(stopIds.has("S1N") || stopIds.has("S1S")).toBe(true);
  });

  it("filters by route_id", () => {
    const arrivals = getScheduledArrivals(db, ["S2"], "R1");
    for (const a of arrivals) {
      expect(a.route_id).toBe("R1");
    }
  });

  it("respects limit", () => {
    const arrivals = getScheduledArrivals(db, ["S2"], undefined, 1);
    expect(arrivals.length).toBeLessThanOrEqual(1);
  });

  it("returns arrivals sorted by time", () => {
    const arrivals = getScheduledArrivals(db, ["S2"], undefined, 10);
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i].arrival_time >= arrivals[i - 1].arrival_time).toBe(
        true
      );
    }
  });

  it("includes trip_headsign", () => {
    const arrivals = getScheduledArrivals(db, ["S3"]);
    expect(arrivals[0]).toHaveProperty("trip_headsign");
  });
});

describe("listRoutes", () => {
  it("returns all routes", () => {
    const routes = listRoutes(db);
    expect(routes.length).toBe(2);
  });

  it("filters by route_type", () => {
    const subwayRoutes = listRoutes(db, 1);
    expect(subwayRoutes.length).toBe(1);
    expect(subwayRoutes[0].route_id).toBe("R1");

    const busRoutes = listRoutes(db, 3);
    expect(busRoutes.length).toBe(1);
    expect(busRoutes[0].route_id).toBe("R2");
  });

  it("returns expected fields", () => {
    const routes = listRoutes(db);
    const route = routes[0];
    expect(route).toHaveProperty("route_id");
    expect(route).toHaveProperty("route_short_name");
    expect(route).toHaveProperty("route_long_name");
    expect(route).toHaveProperty("route_type");
    expect(route).toHaveProperty("route_color");
  });
});

describe("getRouteDetails", () => {
  it("returns route and ordered stops", () => {
    const details = getRouteDetails(db, "R1");
    expect(details.route).not.toBeNull();
    expect(details.route!.route_id).toBe("R1");
    expect(details.stops.length).toBeGreaterThanOrEqual(2);
  });

  it("returns stops in sequence order", () => {
    const details = getRouteDetails(db, "R1", 0);
    // Trip T1 (direction 0): S1N -> S2 -> S3
    const stopIds = details.stops.map((s) => s.stop_id);
    expect(stopIds).toEqual(["S1N", "S2", "S3"]);
  });

  it("filters by direction_id", () => {
    const dir0 = getRouteDetails(db, "R1", 0);
    const dir1 = getRouteDetails(db, "R1", 1);
    // Direction 0 (T1): S1N, S2, S3
    // Direction 1 (T2): S3, S2, S1S
    expect(dir0.stops[0].stop_id).toBe("S1N");
    expect(dir1.stops[0].stop_id).toBe("S3");
  });

  it("returns null route for invalid route_id", () => {
    const details = getRouteDetails(db, "INVALID");
    expect(details.route).toBeNull();
    expect(details.stops).toEqual([]);
  });
});

describe("getTripDetails", () => {
  it("returns trip with stop times", () => {
    const details = getTripDetails(db, "T1");
    expect(details.trip).not.toBeNull();
    expect(details.trip.trip_id).toBe("T1");
    expect(details.trip.route_id).toBe("R1");
    expect(details.stop_times.length).toBe(3);
  });

  it("includes stop_name in stop_times", () => {
    const details = getTripDetails(db, "T1");
    expect(details.stop_times[0].stop_name).toBe("Central Station North");
  });

  it("returns stop times in sequence order", () => {
    const details = getTripDetails(db, "T1");
    const sequences = details.stop_times.map((st) => st.stop_sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("returns null trip for invalid trip_id", () => {
    const details = getTripDetails(db, "INVALID");
    expect(details.trip).toBeNull();
    expect(details.stop_times).toEqual([]);
  });
});
