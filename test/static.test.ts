import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SystemConfig } from "../src/config.js";

vi.mock("gtfs", () => ({
  importGtfs: vi.fn(),
  openDb: vi.fn(() => ({ exec: vi.fn(), close: vi.fn() })),
  closeDb: vi.fn((db: any) => db.close()),
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
  it("removes the scratch file when a first import fails", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "partial junk");
      throw new Error("network error");
    });

    await expect(ensureGtfsLoaded(system, TMP_ROOT, 24)).rejects.toThrow("network error");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
  });

  it("keeps serving the existing DB when a refresh fails", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    vi.mocked(importGtfs).mockImplementationOnce(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "good");
    });
    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    const live = { exec: vi.fn(), close: vi.fn() };
    vi.mocked(openDb).mockImplementation(
      ({ sqlitePath }: any) => (sqlitePath === dbPath ? live : { exec: vi.fn(), close: vi.fn() }) as any
    );
    expect(getDb(system, TMP_ROOT)).toBe(live);

    // Age the file and use a zero refresh window so both freshness checks fail.
    utimesSync(dbPath, 1, 1);
    vi.mocked(importGtfs).mockImplementationOnce(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "partial junk");
      throw new Error("network error");
    });

    await expect(ensureGtfsLoaded(system, TMP_ROOT, 0)).rejects.toThrow("network error");
    expect(readFileSync(dbPath, "utf8")).toBe("good");
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
    expect(getDb(system, TMP_ROOT)).toBe(live);
    expect(live.close).not.toHaveBeenCalled();
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

  it("swaps in the new DB and reopens the connection after a refresh", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    let generation = 0;
    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, `gen${++generation}`);
    });

    const closeSpy = vi.fn();
    vi.mocked(openDb).mockImplementation(() => ({ exec: vi.fn(), close: closeSpy }) as any);

    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    const before = getDb(system, TMP_ROOT);

    utimesSync(dbPath, 1, 1);
    await ensureGtfsLoaded(system, TMP_ROOT, 0);

    expect(readFileSync(dbPath, "utf8")).toBe("gen2");
    expect(existsSync(`${dbPath}.tmp`)).toBe(false);
    // The old connection was released through closeDb, and the next getDb
    // opens the new file rather than returning the stale instance.
    expect(closeSpy).toHaveBeenCalled();
    expect(getDb(system, TMP_ROOT)).not.toBe(before);
  });
});
