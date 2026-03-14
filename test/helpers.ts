import { importGtfs, openDb } from "gtfs";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;

const TEST_DB_BASE = "/tmp/gtfs-mcp-test";
const FIXTURE_ZIP = join(import.meta.dirname, "fixtures", "gtfs.zip");

export async function setupTestDb(): Promise<{ db: ReturnType<typeof openDb>; dir: string }> {
  const dbDir = join(TEST_DB_BASE, randomUUID());
  mkdirSync(dbDir, { recursive: true });
  const sqlitePath = join(dbDir, "test.db");

  await importGtfs({
    agencies: [{ path: FIXTURE_ZIP }],
    sqlitePath,
    ignoreDuplicates: true,
  });

  return { db: openDb({ sqlitePath }), dir: dbDir };
}

export function cleanupTestDb(dir?: string): void {
  const target = dir ?? TEST_DB_BASE;
  try {
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

export function encodeTripUpdateFeed(
  tripUpdates: Array<{
    tripId: string;
    routeId?: string;
    scheduleRelationship?: number;
    stopTimeUpdates: Array<{
      stopId: string;
      arrivalTime?: number;
      arrivalDelay?: number;
      departureTime?: number;
      departureDelay?: number;
    }>;
  }>
): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: tripUpdates.map((tu, i) => ({
      id: `tu-${i}`,
      tripUpdate: {
        trip: {
          tripId: tu.tripId,
          routeId: tu.routeId,
          scheduleRelationship: tu.scheduleRelationship ?? 0,
        },
        stopTimeUpdate: tu.stopTimeUpdates.map((stu) => ({
          stopId: stu.stopId,
          arrival: {
            time: stu.arrivalTime ? stu.arrivalTime : undefined,
            delay: stu.arrivalDelay,
          },
          departure: {
            time: stu.departureTime ? stu.departureTime : undefined,
            delay: stu.departureDelay,
          },
        })),
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}

export function encodeAlertFeed(
  alerts: Array<{
    id: string;
    headerText: string;
    descriptionText: string;
    informedEntities?: Array<{ routeId?: string; stopId?: string }>;
  }>
): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: alerts.map((a) => ({
      id: a.id,
      alert: {
        headerText: {
          translation: [{ text: a.headerText, language: "en" }],
        },
        descriptionText: {
          translation: [{ text: a.descriptionText, language: "en" }],
        },
        informedEntity: (a.informedEntities ?? []).map((ie) => ({
          routeId: ie.routeId,
          stopId: ie.stopId,
        })),
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}

export function encodeVehiclePositionFeed(
  vehicles: Array<{
    vehicleId: string;
    tripId?: string;
    routeId?: string;
    latitude: number;
    longitude: number;
    bearing?: number;
    timestamp?: number;
    stopId?: string;
    currentStatus?: number;
  }>
): Uint8Array {
  const message = transit_realtime.FeedMessage.create({
    header: {
      gtfsRealtimeVersion: "2.0",
      timestamp: Math.floor(Date.now() / 1000),
    },
    entity: vehicles.map((v, i) => ({
      id: `vp-${i}`,
      vehicle: {
        vehicle: { id: v.vehicleId },
        trip: v.tripId ? { tripId: v.tripId, routeId: v.routeId } : undefined,
        position: {
          latitude: v.latitude,
          longitude: v.longitude,
          bearing: v.bearing,
        },
        timestamp: v.timestamp ?? undefined,
        stopId: v.stopId,
        currentStatus: v.currentStatus,
      },
    })),
  });
  return transit_realtime.FeedMessage.encode(message).finish();
}
