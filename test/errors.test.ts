import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import {
  setupTestDb,
  cleanupTestDb,
  createTestConfig,
  getJsonContent,
} from "./helpers.js";
import { clearFeedCache } from "../src/gtfs/realtime.js";

let testDb: any;
vi.mock("../src/gtfs/static.js", () => ({
  ensureGtfsLoaded: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockImplementation(() => testDb),
}));

const { createServer } = await import("../src/server.js");

let dbDir: string;

beforeAll(async () => {
  const result = await setupTestDb();
  testDb = result.db;
  dbDir = result.dir;
});

afterAll(() => {
  cleanupTestDb(dbDir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  clearFeedCache();
  // Silence the expected error logs from failed-feed tests.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

async function makeClient(config: AppConfig): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-errors", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("realtime fetch failures", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Upstream error", { status: 500, statusText: "Error" })
    );
  });

  it("get_arrivals falls back to scheduled when trip_updates feed fails", async () => {
    const client = await makeClient(createTestConfig());
    vi.useFakeTimers({ now: new Date("2026-04-20T07:00:00-04:00") });

    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1S" },
    });
    const arrivals = getJsonContent(result) as any[];

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
  });

  it("get_alerts returns [] when alerts feed fails", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(getJsonContent(result)).toEqual([]);
  });

  it("get_vehicles returns [] when vehicle_positions feed fails", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    expect(getJsonContent(result)).toEqual([]);
  });

  it("get_system_status reports error per feed type and doesn't throw", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_system_status",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result) as any;

    expect(data.route_count).toBeGreaterThan(0);
    expect(data.active_alerts).toBe(0);
    // All three feed types are configured with URLs, so all three should report the fetch outcome.
    // After the 500s, entities is empty — feeds report "0 entities".
    for (const feed of Object.values(data.feeds) as string[]) {
      expect(feed).toMatch(/0 entities|error/);
    }
  });
});

describe("malformed protobuf in realtime feeds", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { status: 200 })
    );
  });

  it("get_arrivals falls back to scheduled when trip_updates protobuf is corrupt", async () => {
    const client = await makeClient(createTestConfig());
    vi.useFakeTimers({ now: new Date("2026-04-20T07:00:00-04:00") });

    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1S" },
    });
    const arrivals = getJsonContent(result) as any[];

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
  });

  it("get_alerts returns [] when alerts protobuf is corrupt", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(getJsonContent(result)).toEqual([]);
  });
});

describe("empty realtime config", () => {
  const emptyRealtimeConfig = createTestConfig({
    systems: [
      {
        id: "test",
        name: "Test Transit",
        schedule_url: "http://localhost/gtfs.zip",
        timezone: "America/New_York",
        realtime: { trip_updates: [], vehicle_positions: [], alerts: [] },
        auth: null,
      },
    ],
  });

  beforeEach(() => {
    // No fetch should be called with empty URL lists; fail loudly if it is.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected fetch with empty realtime config");
    });
  });

  it("get_arrivals falls back to scheduled when no trip_updates are configured", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    vi.useFakeTimers({ now: new Date("2026-04-20T07:00:00-04:00") });

    const result = await client.callTool({
      name: "get_arrivals",
      arguments: { system: "test", stop_id: "S1S" },
    });
    const arrivals = getJsonContent(result) as any[];

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
  });

  it("get_alerts returns [] when no alerts are configured", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(getJsonContent(result)).toEqual([]);
  });

  it("get_vehicles returns [] when no vehicle_positions are configured", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    expect(getJsonContent(result)).toEqual([]);
  });

  it("get_system_status reports feeds as 'not configured'", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_system_status",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result) as any;

    expect(data.feeds.trip_updates).toBe("not configured");
    expect(data.feeds.vehicle_positions).toBe("not configured");
    expect(data.feeds.alerts).toBe("not configured");
  });
});
