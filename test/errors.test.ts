import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../src/config.js";
import {
  setupTestDb,
  cleanupTestDb,
  createTestConfig,
  getJsonContent,
  encodeAlertFeed,
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

function errorText(result: any): string {
  return result.content[0].text;
}

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
    const response = getJsonContent(result) as any;
    const arrivals = response.arrivals;

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
    expect(response.data_source).toBe("scheduled");
    expect(response.warnings).toHaveLength(1);
    expect(response.warnings[0]).toContain("trip updates feed");
    expect(response.warnings[0]).toContain("500");
  });

  // An empty list here would read as "no alerts, good service".
  it("get_alerts is an error, not [], when the alerts feed fails", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("could not be fetched");
    expect(errorText(result)).toContain("500");
  });

  it("get_vehicles is an error, not [], when the vehicle_positions feed fails", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("could not be fetched");
  });

  it("get_trip keeps the scheduled trip but warns when trip_updates fails", async () => {
    const client = await makeClient(createTestConfig());
    vi.useFakeTimers({ now: new Date("2026-04-20T07:00:00-04:00") });
    const { arrivals } = getJsonContent(
      await client.callTool({
        name: "get_arrivals",
        arguments: { system: "test", stop_id: "S1S" },
      })
    ) as any;

    const result = await client.callTool({
      name: "get_trip",
      arguments: { system: "test", trip_id: arrivals[0].trip_id },
    });
    const data = getJsonContent(result) as any;
    expect(data.trip.trip_id).toBe(arrivals[0].trip_id);
    expect(data.warnings).toHaveLength(1);
  });

  it("get_trip mentions the feed failure when the trip isn't in the schedule", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_trip",
      arguments: { system: "test", trip_id: "RT_ONLY_TRIP" },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Trip not found");
    expect(errorText(result)).toContain("could not be fetched");
  });

  it("get_feed_health reports error per feed type and doesn't throw", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_feed_health",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result) as any;

    for (const feed of Object.values(data.feeds) as any[]) {
      expect(feed.configured).toBe(true);
      expect(feed.urls_failed).toBeGreaterThan(0);
      expect(feed.urls_ok).toBe(0);
      expect(feed.entities).toBe(0);
      expect(feed.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("partial realtime fetch failures", () => {
  it("get_alerts returns what it could fetch, with a warning", async () => {
    const config = createTestConfig();
    config.systems[0].realtime.alerts = [
      "http://localhost/alerts-good",
      "http://localhost/alerts-bad",
    ];
    const alertFeed = encodeAlertFeed([
      { id: "a1", headerText: "Delays", descriptionText: "Signal problems" },
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("bad")
        ? new Response("Upstream error", { status: 500, statusText: "Error" })
        : new Response(alertFeed, { status: 200 })
    );

    const client = await makeClient(config);
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result) as any;
    expect(result.isError).toBeFalsy();
    expect(data.alerts.map((a: any) => a.id)).toEqual(["a1"]);
    expect(data.warnings).toHaveLength(1);
    expect(data.warnings[0]).toContain("1 of 2 alerts feeds");
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
    const response = getJsonContent(result) as any;
    const arrivals = response.arrivals;

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
  });

  it("get_alerts is an error when alerts protobuf is corrupt", async () => {
    const client = await makeClient(createTestConfig());
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(result.isError).toBe(true);
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
    const response = getJsonContent(result) as any;
    const arrivals = response.arrivals;

    expect(arrivals.length).toBeGreaterThan(0);
    for (const a of arrivals) {
      expect(a.is_realtime).toBe(false);
    }
    // Schedule-only is a normal configuration, not a problem to flag.
    expect(response.warnings).toBeUndefined();
  });

  it("get_alerts says alerts are unavailable when no alerts feed is configured", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_alerts",
      arguments: { system: "test" },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("No alerts feed is configured");
  });

  it("get_vehicles says positions are unavailable when no feed is configured", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_vehicles",
      arguments: { system: "test" },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("No vehicle positions feed is configured");
  });

  it("get_feed_health reports feeds as not configured when no URLs are set", async () => {
    const client = await makeClient(emptyRealtimeConfig);
    const result = await client.callTool({
      name: "get_feed_health",
      arguments: { system: "test" },
    });
    const data = getJsonContent(result) as any;

    for (const feed of Object.values(data.feeds) as any[]) {
      expect(feed.configured).toBe(false);
      expect(feed.urls).toBe(0);
    }
  });
});
