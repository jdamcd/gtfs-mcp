import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SystemConfig } from "../src/config.js";

vi.mock("gtfs", () => ({
  importGtfs: vi.fn(),
  openDb: vi.fn(() => ({ exec: vi.fn(), close: vi.fn() })),
  closeDb: vi.fn((db: any) => db.close()),
}));

// Only scratch files go through the gtfs package's openDb now.
vi.mock("better-sqlite3", () => ({
  default: vi.fn(function () {
    return { exec: vi.fn(), close: vi.fn() };
  }),
}));

const { importGtfs, openDb } = await import("gtfs");
const Database = (await import("better-sqlite3")).default;
const { ensureGtfsLoaded, getDb, preWarmDatabases, DB_RETIRE_MS, PRE_WARM_CHECK_MS } = await import("../src/gtfs/static.js");

const TMP_ROOT = "/tmp/gtfs-mcp-test/static";

function scratchFiles(systemId: string): string[] {
  const dir = join(TMP_ROOT, systemId);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tmp")) : [];
}

// A DB file old enough to fail any refresh window.
function writeStaleDb(system: SystemConfig, contents: string): string {
  const dbPath = join(TMP_ROOT, system.id, "gtfs.db");
  mkdirSync(join(TMP_ROOT, system.id), { recursive: true });
  writeFileSync(dbPath, contents);
  utimesSync(dbPath, 1, 1);
  return dbPath;
}

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

let stderr: MockInstance;

beforeEach(() => {
  vi.mocked(importGtfs).mockReset();
  vi.mocked(openDb).mockReset();
  vi.mocked(openDb).mockImplementation(() => ({ exec: vi.fn(), close: vi.fn() }) as any);
  vi.mocked(Database).mockReset();
  vi.mocked(Database).mockImplementation(function () {
    return { exec: vi.fn(), close: vi.fn() } as any;
  });
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(scratchFiles(system.id)).toEqual([]);
  });

  it("keeps serving the existing DB when a refresh fails", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");

    vi.mocked(importGtfs).mockImplementationOnce(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "good");
    });
    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    const live = { exec: vi.fn(), close: vi.fn() };
    vi.mocked(Database).mockImplementation(function () {
      return live as any;
    });
    expect(getDb(system, TMP_ROOT)).toBe(live);

    // Age the file and use a zero refresh window so both freshness checks fail.
    utimesSync(dbPath, 1, 1);
    vi.mocked(importGtfs).mockImplementationOnce(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "partial junk");
      throw new Error("network error");
    });

    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    await vi.waitFor(() =>
      expect(stderr.mock.calls.flat().join("\n")).toMatch(/refresh failed.*network error/)
    );
    expect(readFileSync(dbPath, "utf8")).toBe("good");
    expect(scratchFiles(system.id)).toEqual([]);
    expect(getDb(system, TMP_ROOT)).toBe(live);
    expect(live.close).not.toHaveBeenCalled();
  });

  it("waits before retrying a failed refresh", async () => {
    const system = makeSystem();
    const dbPath = writeStaleDb(system, "old");
    vi.mocked(importGtfs).mockRejectedValue(new Error("dns"));
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    await vi.waitFor(() => expect(stderr.mock.calls.flat().join("\n")).toMatch(/refresh failed/));

    vi.setSystemTime(new Date(start.getTime() + 9 * 60_000));
    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    expect(importGtfs).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(start.getTime() + 11 * 60_000));
    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    expect(importGtfs).toHaveBeenCalledTimes(2);
    expect(readFileSync(dbPath, "utf8")).toBe("old");
  });

  it("serves a stale DB without waiting for the refresh", async () => {
    const system = makeSystem();
    const dbPath = writeStaleDb(system, "old");

    let finishImport!: () => void;
    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      await new Promise<void>((r) => (finishImport = r));
      writeFileSync(sqlitePath, "new");
    });

    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    expect(importGtfs).toHaveBeenCalledTimes(1);
    expect(readFileSync(dbPath, "utf8")).toBe("old");
    // A second call while the refresh runs joins it rather than starting another.
    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    expect(importGtfs).toHaveBeenCalledTimes(1);

    finishImport();
    await vi.waitFor(() => expect(readFileSync(dbPath, "utf8")).toBe("new"));
    expect(scratchFiles(system.id)).toEqual([]);
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

  it("leaves another process's in-progress import alone when its own fails", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");
    const realPid = process.pid;
    const setPid = (pid: number) => Object.defineProperty(process, "pid", { value: pid, configurable: true });

    // A fresh module copy has its own import lock, like a separate server.
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((started) => {
      vi.mocked(importGtfs)
        .mockImplementationOnce(async ({ sqlitePath }: any) => {
          writeFileSync(sqlitePath, "first, half done");
          started();
          await new Promise<void>((r) => (releaseFirst = r));
          writeFileSync(sqlitePath, "first, complete");
        })
        .mockImplementationOnce(async ({ sqlitePath }: any) => {
          writeFileSync(sqlitePath, "second, partial junk");
          throw new Error("network error");
        });
    });

    try {
      setPid(1001);
      const first = ensureGtfsLoaded(system, TMP_ROOT, 24);
      await firstStarted;

      setPid(1002);
      vi.resetModules();
      const secondServer = await import("../src/gtfs/static.js");
      await expect(secondServer.ensureGtfsLoaded(system, TMP_ROOT, 24)).rejects.toThrow("network error");
      const scratchContents = scratchFiles(system.id).map((f) => readFileSync(join(TMP_ROOT, system.id, f), "utf8"));
      expect(scratchContents).toEqual(["first, half done"]);

      releaseFirst();
      await first;
      expect(readFileSync(dbPath, "utf8")).toBe("first, complete");
      expect(scratchFiles(system.id)).toEqual([]);
    } finally {
      setPid(realPid);
    }
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
    vi.mocked(Database).mockImplementation(function () {
      return { exec: vi.fn(), close: closeSpy } as any;
    });

    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    const before = getDb(system, TMP_ROOT);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    utimesSync(dbPath, 1, 1);
    await ensureGtfsLoaded(system, TMP_ROOT, 0);
    await vi.waitFor(() => expect(readFileSync(dbPath, "utf8")).toBe("gen2"));
    expect(scratchFiles(system.id)).toEqual([]);
    // New requests open the new file at once; a request still holding the
    // old connection keeps it until the grace period ends.
    expect(getDb(system, TMP_ROOT)).not.toBe(before);
    expect(closeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DB_RETIRE_MS);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("counts the refresh window from the file's age, not the last check", async () => {
    const system = makeSystem();
    const dbPath = join(TMP_ROOT, system.id, "gtfs.db");
    mkdirSync(join(TMP_ROOT, system.id), { recursive: true });
    writeFileSync(dbPath, "old");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    const mtime = new Date(start.getTime() - 23 * 3600_000);
    utimesSync(dbPath, mtime, mtime);
    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, "new");
    });

    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    expect(importGtfs).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(start.getTime() + 2 * 3600_000));
    await ensureGtfsLoaded(system, TMP_ROOT, 24);
    await vi.waitFor(() => expect(readFileSync(dbPath, "utf8")).toBe("new"));
  });
});

describe("preWarmDatabases", () => {
  function importWriting(contents: string) {
    vi.mocked(importGtfs).mockImplementation(async ({ sqlitePath }: any) => {
      writeFileSync(sqlitePath, contents);
    });
  }

  it("does nothing when off", async () => {
    const system = makeSystem();
    await preWarmDatabases({
      systems: [system],
      data_dir: TMP_ROOT,
      schedule_refresh_hours: 24,
      pre_warm_database: "off",
    });
    expect(importGtfs).not.toHaveBeenCalled();
  });

  it("setup imports systems without a DB, continuing past a failure, and leaves stale ones alone", async () => {
    const failing = makeSystem();
    failing.schedule_url = "http://localhost/failing.zip";
    const missing = makeSystem();
    const stale = makeSystem();
    writeStaleDb(stale, "stale");

    vi.mocked(importGtfs).mockImplementation(async ({ agencies, sqlitePath }: any) => {
      if (agencies[0].url === failing.schedule_url) throw new Error("dns");
      writeFileSync(sqlitePath, "new");
    });

    await preWarmDatabases({
      systems: [failing, missing, stale],
      data_dir: TMP_ROOT,
      schedule_refresh_hours: 0,
      pre_warm_database: "setup",
    });

    expect(importGtfs).toHaveBeenCalledTimes(2);
    expect(existsSync(join(TMP_ROOT, failing.id, "gtfs.db"))).toBe(false);
    expect(readFileSync(join(TMP_ROOT, missing.id, "gtfs.db"), "utf8")).toBe("new");
    expect(readFileSync(join(TMP_ROOT, stale.id, "gtfs.db"), "utf8")).toBe("stale");
    expect(stderr.mock.calls.flat().join("\n")).toMatch(/import failed for Test.*dns/);
  });

  it("proactive refreshes stale DBs at start and keeps checking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const missing = makeSystem();
    const stale = makeSystem();
    const fresh = makeSystem();
    const staleDb = writeStaleDb(stale, "stale");
    mkdirSync(join(TMP_ROOT, fresh.id), { recursive: true });
    writeFileSync(join(TMP_ROOT, fresh.id, "gtfs.db"), "fresh");
    importWriting("new");

    await preWarmDatabases({
      systems: [missing, stale, fresh],
      data_dir: TMP_ROOT,
      schedule_refresh_hours: 24,
      pre_warm_database: "proactive",
    });
    expect(readFileSync(join(TMP_ROOT, missing.id, "gtfs.db"), "utf8")).toBe("new");
    await vi.waitFor(() => expect(readFileSync(staleDb, "utf8")).toBe("new"));
    expect(importGtfs).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(TMP_ROOT, fresh.id, "gtfs.db"), "utf8")).toBe("fresh");

    // Just refreshed, so age it by hand for the next check to find it stale.
    utimesSync(staleDb, 1, 1);
    importWriting("newer");
    vi.advanceTimersByTime(PRE_WARM_CHECK_MS);
    await vi.waitFor(() => expect(readFileSync(staleDb, "utf8")).toBe("newer"));
    expect(importGtfs).toHaveBeenCalledTimes(3);
  });
});
