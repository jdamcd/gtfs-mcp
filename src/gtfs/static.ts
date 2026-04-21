import { importGtfs, openDb } from "gtfs";
import { existsSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SystemConfig } from "../config.js";
import { applyAuth } from "../auth.js";

const loadedSystems = new Map<string, { loadedAt: number }>();
const importLocks = new Map<string, Promise<void>>();
const dbConnections = new Map<string, ReturnType<typeof openDb>>();

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

  // Check if already loaded and fresh in memory
  const loaded = loadedSystems.get(system.id);
  if (loaded && now - loaded.loadedAt < maxAge && existsSync(dbPath)) {
    return;
  }

  // Check if DB file exists and is fresh enough
  if (existsSync(dbPath)) {
    const age = now - statSync(dbPath).mtimeMs;
    if (age < maxAge) {
      loadedSystems.set(system.id, { loadedAt: now });
      return;
    }
  }

  // Deduplicate concurrent imports for the same system
  const existing = importLocks.get(system.id);
  if (existing) {
    return existing;
  }

  const importPromise = doImport(system, dataDir, dbPath);
  importLocks.set(system.id, importPromise);
  try {
    await importPromise;
  } finally {
    importLocks.delete(system.id);
  }
}

async function doImport(
  system: SystemConfig,
  dataDir: string,
  dbPath: string
): Promise<void> {
  mkdirSync(join(dataDir, system.id), { recursive: true });

  // Close and drop any cached connection so the old file handle is released
  // before importGtfs overwrites the DB.
  const cached = dbConnections.get(system.id);
  if (cached) {
    cached.close();
    dbConnections.delete(system.id);
  }

  const { url, headers } = applyAuth(system.schedule_url, system.auth);

  console.error(`[gtfs-mcp] Importing GTFS data for ${system.name}...`);
  try {
    await importGtfs({
      agencies: [{ url, headers }],
      sqlitePath: dbPath,
      ignoreDuplicates: true,
      verbose: false,
    });
  } catch (err) {
    // Remove any partial DB so the next attempt starts clean instead of opening a corrupt file.
    try {
      unlinkSync(dbPath);
    } catch {
      // Already absent — fine.
    }
    throw err;
  }
  console.error(`[gtfs-mcp] Import complete for ${system.name}`);

  loadedSystems.set(system.id, { loadedAt: Date.now() });
}

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
