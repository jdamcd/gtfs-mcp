import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SystemConfig } from "../src/config.js";

vi.mock("gtfs", () => ({
  importGtfs: vi.fn(),
  openDb: vi.fn(() => ({ exec: vi.fn(), close: vi.fn() })),
}));

const { importGtfs, openDb } = await import("gtfs");
const { ensureGtfsLoaded, getDb } = await import("../src/gtfs/static.js");

const TMP_ROOT = "/tmp/gtfs-mcp-test/static";

function makeSystem(): SystemConfig {
  return {
    id: `sys-${randomUUID()}`,
    name: "Test",
    schedule_url: "http://localhost/gtfs.zip",
    timezone: "UTC",
    realtime: { trip_updates: [], vehicle_positions: [], alerts: [] },
    auth: null,
  };
}

beforeEach(() => {
  vi.mocked(importGtfs).mockReset();
  vi.mocked(openDb).mockReset();
  vi.mocked(openDb).mockImplementation(() => ({ exec: vi.fn(), close: vi.fn() }) as any);
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("ensureGtfsLoaded", () => {
  it("removes the partial DB when import fails", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "partial junk");
      throw new Error("network error");
    });

    await expect(ensureGtfsLoaded(system, TMP_ROOT, 24)).rejects.toThrow("network error");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("retries import on the next call after a failure", async () => {
    const system = makeSystem();

    vi.mocked(importGtfs)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined as any);

    await expect(ensureGtfsLoaded(system, TMP_ROOT, 24)).rejects.toThrow("transient");
    // DB file not written by second call, but importGtfs should be invoked again
    // (the second call has nothing to import since we're mocking, so just assert the call count).
    try {
      await ensureGtfsLoaded(system, TMP_ROOT, 24);
    } catch {
      // openDb won't find a real file; we only care that importGtfs was re-invoked
    }
    expect(vi.mocked(importGtfs)).toHaveBeenCalledTimes(2);
  });

  it("ignores missing file when cleaning up after failure", async () => {
    const system = makeSystem();

    vi.mocked(importGtfs).mockRejectedValue(new Error("dns"));

    // importGtfs throws without ever writing — unlink must not blow up.
    await expect(ensureGtfsLoaded(system, TMP_ROOT, 24)).rejects.toThrow("dns");
  });

  it("closes the cached DB connection before a refresh", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "db");
    });

    const closeSpy = vi.fn();
    vi.mocked(openDb).mockImplementation(() => ({ exec: vi.fn(), close: closeSpy }) as any);

    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    getDb(system, TMP_ROOT);

    // Remove the DB file so the next call re-imports instead of short-circuiting.
    unlinkSync(dbPath);
    await ensureGtfsLoaded(system, TMP_ROOT, 24);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
