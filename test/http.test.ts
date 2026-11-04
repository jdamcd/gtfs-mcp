import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { request as httpRequest, type Server } from "node:http";
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

let httpServer: Server;
let closeHandler: () => Promise<void>;
let dbDir: string;
let port: number;
let url: URL;

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

  ({ httpServer, close: closeHandler } = createHttpMcpServer(testConfig));

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  url = new URL(`http://localhost:${port}/mcp`);
}, 30_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await closeHandler?.();
  await new Promise<void>((resolve) => {
    httpServer?.close(() => resolve());
  });
  cleanupTestDb(dbDir);
});

// The default client opens with `initialize` (2025 era); `mode: "auto"`
// probes with `server/discover` (2026-07-28). Both go through one handler.
describe.each([
  { era: "legacy", options: undefined },
  { era: "modern", options: { versionNegotiation: { mode: "auto" as const } } },
])("HTTP transport ($era era)", ({ era, options }) => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "test-client", version: "1.0.0" }, options);
    await client.connect(new StreamableHTTPClientTransport(url));
  });

  afterAll(async () => {
    await client.close();
  });

  it(`negotiates the ${era} era`, () => {
    expect(client.getProtocolEra()).toBe(era);
  });

  it("lists systems", async () => {
    const result = await client.callTool({
      name: "list_systems",
      arguments: {},
    });
    const data = getJsonContent(result);
    expect(data.systems).toEqual([{ id: "test", name: "Test Transit" }]);
  });

  it("searches stops", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "test", query: "Central" },
    });
    const stops = getJsonContent(result).stops;
    expect(stops.length).toBeGreaterThanOrEqual(1);
    expect(stops[0]).toHaveProperty("stop_id");
    expect(stops[0]).toHaveProperty("name");
  });

  it("lists routes", async () => {
    const result = await client.callTool({
      name: "list_routes",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result);
    expect(data.routes.length).toBe(2);
    expect(data.total).toBe(2);
  });

  it("gets realtime arrivals", async () => {
    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S2" },
    });
    const response = getJsonContent(result);
    expect(response.arrivals.length).toBeGreaterThanOrEqual(1);
    expect(response.arrivals[0]).toHaveProperty("trip_id");
    expect(response.arrivals[0].is_realtime).toBe(true);
  });

  it("gets alerts", async () => {
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    const alerts = getJsonContent(result).alerts;
    expect(alerts.length).toBe(1);
    expect(alerts[0].header).toBe("Delay on Route 1");
  });

  it("gets vehicles", async () => {
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    const vehicles = getJsonContent(result).vehicles;
    expect(vehicles.length).toBe(1);
    expect(vehicles[0].vehicle_id).toBe("V1");
  });

  it("returns error for unknown system", async () => {
    const result = await client.callTool({
      name: "search_stops",
      arguments: { system: "nonexistent", query: "test" },
    });
    expect(getTextContent(result)).toContain("Unknown system");
  });
});

describe("HTTP transport", () => {
  describe("stateless serving", () => {
    const postHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    it("answers a 2025-era request with no session header", async () => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "raw", version: "0" },
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeNull();
    });

    it.each(["GET", "DELETE"])("405 for the session verb %s", async (method) => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method,
        headers: { accept: "application/json, text/event-stream" },
      });
      expect(res.status).toBe(405);
    });
  });

  describe("endpoint routing", () => {
    it.each(["/", "/foo", "/mcp/extra"])("404 for path %s", async (path) => {
      const res = await fetch(`http://localhost:${port}${path}`);
      expect(res.status).toBe(404);
    });

    it("405 for unsupported methods", async () => {
      const res = await fetch(`http://localhost:${port}/mcp`, { method: "PUT" });
      expect(res.status).toBe(405);
    });
  });

  describe("DNS rebinding protection", () => {
    it("403 for disallowed Origin", async () => {
      const res = await fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          origin: "http://evil.example.com",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(403);
    });

    it("403 for disallowed Host", async () => {
      // Use raw http.request because fetch/undici locks the Host header.
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              host: "evil.example.com",
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
      });
      expect(status).toBe(403);
    });
  });

  it("413 for oversized body", async () => {
    const big = "x".repeat(300 * 1024);
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it("hangs up on a body far beyond the cap instead of reading it all", async () => {
    const huge = "x".repeat(4 * 1024 * 1024);
    await expect(
      fetch(`http://localhost:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: huge,
      })
    ).rejects.toThrow();
  });
});
