import { closeDb, importGtfs, openDb } from "gtfs";
import { existsSync, statSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SystemConfig } from "../config.js";
import { applyAuth } from "../auth.js";

// Per system, when to look at the DB file again.
const recheckAt = new Map<string, number>();
const importLocks = new Map<string, Promise<void>>();
const dbConnections = new Map<string, ReturnType<typeof openDb>>();

// Longer than a hung download (downloadTimeout), far shorter than a refresh.
const REFRESH_RETRY_MS = 10 * 60 * 1000;

function getSqlitePath(dataDir: string, systemId: string): string {
  return join(dataDir, systemId, "gtfs.db");
}

export async function ensureGtfsLoaded(
  system: SystemConfig,
  dataDir: string,
  refreshHours: number
): Promise<void> {
  const dbPath = getSqlitePath(dataDir, system.id);
  const now = Date.now();
  const maxAge = refreshHours * 60 * 60 * 1000;

  if ((recheckAt.get(system.id) ?? 0) > now && existsSync(dbPath)) return;
  if (!existsSync(dbPath)) return startImport(system, dataDir, dbPath);

  if (now - statSync(dbPath).mtimeMs < maxAge) {
    recheckAt.set(system.id, now + maxAge);
    return;
  }
  // Serve the stale schedule and refresh behind the request; an outage at
  // the feed host would otherwise fail every tool call until it ends.
  refreshInBackground(system, dataDir, dbPath);
}

// Only the call that starts the refresh handles its failure, so it logs once.
function refreshInBackground(
  system: SystemConfig,
  dataDir: string,
  dbPath: string
): void {
  if (importLocks.has(system.id)) return;
  startImport(system, dataDir, dbPath).catch((err) => {
    recheckAt.set(system.id, Date.now() + REFRESH_RETRY_MS);
    console.error(
      `[gtfs-mcp] Schedule refresh failed for ${system.name}, still serving the previous schedule: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });
}

// Deduplicates concurrent imports for the same system.
async function startImport(
  system: SystemConfig,
  dataDir: string,
  dbPath: string
): Promise<void> {
  const existing = importLocks.get(system.id);
  if (existing) return existing;

  const importPromise = doImport(system, dataDir, dbPath);
  importLocks.set(system.id, importPromise);
  try {
    await importPromise;
  } finally {
    importLocks.delete(system.id);
  }
}

// The gtfs package keeps its own registry of connections keyed by path, and
// openDb hands back the registered instance. Closing one with db.close()
// leaves a dead entry that importGtfs would receive next time, so every
// release goes through closeDb.
function releaseDb(sqlitePath: string): void {
  closeDb(openDb({ sqlitePath }));
}

async function doImport(
  system: SystemConfig,
  dataDir: string,
  dbPath: string
): Promise<void> {
  mkdirSync(join(dataDir, system.id), { recursive: true });

  // importGtfs drops every table before it downloads anything, so it can't
  // run against the live DB: a failed download would leave nothing to serve.
  // The scratch file is per process because several servers can share a
  // data_dir (one per eval provider, or two clients) and refresh at once.
  const tmpPath = `${dbPath}.${process.pid}.tmp`;
  const { url, headers } = applyAuth(system.schedule_url, system.auth);

  console.error(`[gtfs-mcp] Importing GTFS data for ${system.name}...`);
  try {
    await importGtfs({
      agencies: [{ url, headers }],
      sqlitePath: tmpPath,
      ignoreDuplicates: true,
      verbose: false,
      // The gtfs package default is 30s, which is too short for large feeds
      // (VBB Berlin, Paris metro, etc.). Allow up to 5 minutes.
      downloadTimeout: 300_000,
    });
  } catch (err) {
    releaseDb(tmpPath);
    rmSync(tmpPath, { force: true });
    throw err;
  }
  releaseDb(tmpPath);

  // No await between here and the rename, so nothing can reopen the old
  // file in the gap.
  const cached = dbConnections.get(system.id);
  if (cached) {
    closeDb(cached);
    dbConnections.delete(system.id);
  }
  renameSync(tmpPath, dbPath);
  console.error(`[gtfs-mcp] Import complete for ${system.name}`);
}

// A refresh closes the old connection when its import lands, so take the
// handle after the last await and use it synchronously.
export function getDb(
  system: SystemConfig,
  dataDir: string
): ReturnType<typeof openDb> {
  const cached = dbConnections.get(system.id);
  if (cached) {
    return cached;
  }

  const dbPath = getSqlitePath(dataDir, system.id);
  const db = openDb({ sqlitePath: dbPath });
  // The gtfs package doesn't index stop coordinates, so nearby-stop lookups
  // otherwise scan the full stops table on every call.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stops_coords ON stops(stop_lat, stop_lon)`);
  dbConnections.set(system.id, db);
  return db;
}
