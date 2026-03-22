import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import {
  setupTestDb,
  cleanupTestDb,
  createTestConfig,
  getTextContent,
  getJsonContent,
  encodeTripUpdateFeed,
  encodeAlertFeed,
  encodeVehiclePositionFeed,
} from "./helpers.js";

// Mock static.ts before any imports use it
let testDb: any;
vi.mock("../src/gtfs/static.js", () => ({
  ensureGtfsLoaded: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockImplementation(() => testDb),
}));

// Must import AFTER vi.mock
const { createHttpMcpServer } = await import("../src/http.js");

const testConfig = createTestConfig();

let client: Client;
let httpServer: Server;
let dbDir: string;

beforeAll(async () => {
  const result = await setupTestDb();
  testDb = result.db;
  dbDir = result.dir;

  // Mock realtime feeds
  const nowSecs = Math.floor(Date.now() / 1000);
  const tripUpdateData = encodeTripUpdateFeed([
    {
      tripId: "T1",
      routeId: "R1",
      stopTimeUpdates: [
        { stopId: "S2", arrivalTime: nowSecs + 600, arrivalDelay: 120 },
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
  ]);
  const vehicleData = encodeVehiclePositionFeed([
    {
      vehicleId: "V1",
      tripId: "T1",
      routeId: "R1",
      latitude: 40.72,
      longitude: -74.01,
    },
  ]);

  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init?) => {
    const urlStr = String(url);
    let body: Uint8Array;
    if (urlStr.includes("trip-updates")) {
      body = tripUpdateData;
    } else if (urlStr.includes("alerts")) {
      body = alertData;
    } else if (urlStr.includes("vehicle-positions")) {
      body = vehicleData;
    } else {
      return originalFetch(url, init);
    }
    return new Response(body, { status: 200 });
  });

  httpServer = createHttpMcpServer(testConfig);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${port}/mcp`),
  );
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client?.close();
  await new Promise<void>((resolve) => {
    httpServer?.close(() => resolve());
  });
  cleanupTestDb(dbDir);
});

describe("HTTP transport", () => {
  it("lists systems", async () => {
    const result = await client.callTool({
      name: "list_systems",
      arguments: {},
    });
    const systems = getJsonContent(result as any);
    expect(systems).toEqual([{ id: "test", name: "Test Transit" }]);
  });

  it("searches stops", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "test", query: "Central" },
    });
    const stops = getJsonContent(result as any) as any[];
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(stops[0]).toHaveProperty("stop_id");
    expect(stops[0]).toHaveProperty("name");
  });

  it("lists routes", async () => {
    const result = await client.callTool({
      name: "list_routes",
      arguments: { system: "test" },
    });
    const routes = getJsonContent(result as any) as any[];
    expect(routes.length).toBe(2);
  });

  it("gets realtime arrivals", async () => {
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S2" },
    });
    const arrivals = getJsonContent(result as any) as any[];
    expect(arrivals.length).toBeGreaterThanOrEqual(1);
    expect(arrivals[0]).toHaveProperty("trip_id");
    expect(arrivals[0].is_realtime).toBe(true);
  });

  it("gets alerts", async () => {
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    const alerts = getJsonContent(result as any) as any[];
    expect(alerts.length).toBe(1);
    expect(alerts[0].header).toBe("Delay on Route 1");
  });

  it("gets vehicles", async () => {
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    const vehicles = getJsonContent(result as any) as any[];
    expect(vehicles.length).toBe(1);
    expect(vehicles[0].vehicle_id).toBe("V1");
  });

  it("returns error for unknown system", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "nonexistent", query: "test" },
    });
    expect(getTextContent(result as any)).toContain("Unknown system");
  });
});
