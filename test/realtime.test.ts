import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchFeed, fetchAllFeeds, clearFeedCache } from "../src/gtfs/realtime.js";
import {
  encodeTripUpdateFeed,
  encodeAlertFeed,
  encodeVehiclePositionFeed,
} from "./helpers.js";

beforeEach(() => {
  vi.restoreAllMocks();
  clearFeedCache();
});

function mockFetchResponse(body: Uint8Array, ok = true, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(body, {
      status,
      statusText: ok ? "OK" : "Error",
    })
  );
}

describe("fetchFeed", () => {
  it("decodes a trip update protobuf feed", async () => {
    const encoded = encodeTripUpdateFeed([
      {
        tripId: "T1",
        routeId: "R1",
        stopTimeUpdates: [
          { stopId: "S1", arrivalDelay: 120 },
        ],
      },
    ]);

    mockFetchResponse(encoded);

    const feed = await fetchFeed("http://test/trip-updates", null);
    expect(feed.entity).toHaveLength(1);
    expect(feed.entity[0].tripUpdate?.trip?.tripId).toBe("T1");
    expect(
      feed.entity[0].tripUpdate?.stopTimeUpdate?.[0]?.arrival?.delay
    ).toBe(120);
  });

  it("decodes an alert protobuf feed", async () => {
    const encoded = encodeAlertFeed([
      {
        id: "alert-1",
        headerText: "Service disruption",
        descriptionText: "Delays on Route 1",
        informedEntities: [{ routeId: "R1" }],
      },
    ]);

    mockFetchResponse(encoded);

    const feed = await fetchFeed("http://test/alerts", null);
    expect(feed.entity).toHaveLength(1);
    expect(feed.entity[0].alert).toBeDefined();
  });

  it("decodes a vehicle position protobuf feed", async () => {
    const encoded = encodeVehiclePositionFeed([
      {
        vehicleId: "V1",
        tripId: "T1",
        routeId: "R1",
        latitude: 40.7128,
        longitude: -74.006,
      },
    ]);

    mockFetchResponse(encoded);

    const feed = await fetchFeed("http://test/vehicles", null);
    expect(feed.entity).toHaveLength(1);
    expect(feed.entity[0].vehicle?.position?.latitude).toBeCloseTo(40.7128);
  });

  it("throws on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404, statusText: "Not Found" })
    );

    await expect(
      fetchFeed("http://test/missing", null)
    ).rejects.toThrow("404");
  });

  it("throws on malformed protobuf body", async () => {
    mockFetchResponse(new Uint8Array([0xff, 0xff, 0xff, 0xff]));

    await expect(
      fetchFeed("http://test/corrupt", null)
    ).rejects.toThrow();
  });

  it("passes auth headers when provided", async () => {
    const encoded = encodeTripUpdateFeed([]);
    const spy = mockFetchResponse(encoded);

    process.env.TEST_KEY = "secret";
    await fetchFeed("http://test/feed", {
      type: "header",
      header_name: "X-Api-Key",
      key_env: "TEST_KEY",
    });

    expect(spy).toHaveBeenCalledWith(
      "http://test/feed",
      expect.objectContaining({
        headers: { "X-Api-Key": "secret" },
      })
    );
    delete process.env.TEST_KEY;
  });

  it("appends auth query param when provided", async () => {
    const encoded = encodeTripUpdateFeed([]);
    const spy = mockFetchResponse(encoded);

    process.env.TEST_KEY = "secret";
    await fetchFeed("http://test/feed", {
      type: "query_param",
      param_name: "api_key",
      key_env: "TEST_KEY",
    });

    expect(spy).toHaveBeenCalledWith(
      "http://test/feed?api_key=secret",
      expect.anything()
    );
    delete process.env.TEST_KEY;
  });
});

describe("fetchAllFeeds", () => {
  it("returns empty array for empty URL list", async () => {
    const entities = await fetchAllFeeds([], null);
    expect(entities).toEqual([]);
  });

  it("merges entities from multiple feeds", async () => {
    const feed1 = encodeTripUpdateFeed([
      { tripId: "T1", stopTimeUpdates: [{ stopId: "S1", arrivalDelay: 60 }] },
    ]);
    const feed2 = encodeTripUpdateFeed([
      { tripId: "T2", stopTimeUpdates: [{ stopId: "S2", arrivalDelay: 30 }] },
    ]);

    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      callCount++;
      const body = String(url).includes("feed1") ? feed1 : feed2;
      return new Response(body, { status: 200 });
    });

    const entities = await fetchAllFeeds(
      ["http://test/feed1", "http://test/feed2"],
      null
    );

    expect(entities).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  it("gracefully handles individual feed failures", async () => {
    const goodFeed = encodeTripUpdateFeed([
      { tripId: "T1", stopTimeUpdates: [] },
    ]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("bad")) {
        return new Response("Error", { status: 500, statusText: "Error" });
      }
      return new Response(goodFeed, { status: 200 });
    });

    // Suppress console.error for this test
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const entities = await fetchAllFeeds(
      ["http://test/good", "http://test/bad"],
      null
    );

    // Should still return entities from the good feed
    expect(entities).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("skips feeds with malformed protobuf but returns others", async () => {
    const goodFeed = encodeTripUpdateFeed([
      { tripId: "T1", stopTimeUpdates: [] },
    ]);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("corrupt")) {
        return new Response(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { status: 200 });
      }
      return new Response(goodFeed, { status: 200 });
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const entities = await fetchAllFeeds(
      ["http://test/good", "http://test/corrupt"],
      null
    );

    expect(entities).toHaveLength(1);
    expect(consoleError).toHaveBeenCalled();
  });
});
