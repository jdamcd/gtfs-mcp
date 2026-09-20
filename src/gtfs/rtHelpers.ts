import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";
import { extractRtTime } from "../time.js";

const { transit_realtime } = GtfsRealtimeBindings;

export const TRIP_CANCELED =
  transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
export const TRIP_ADDED =
  transit_realtime.TripDescriptor.ScheduleRelationship.ADDED;
export const STOP_SKIPPED =
  transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
export const STOP_NO_DATA =
  transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA;

export type TripStatus = "scheduled" | "canceled" | "added";
export type StopStatus = "scheduled" | "skipped" | "no_data";

export function tripStatusFromRelationship(
  sr: number | null | undefined
): TripStatus {
  if (sr === TRIP_CANCELED) return "canceled";
  if (sr === TRIP_ADDED) return "added";
  return "scheduled";
}

export function stopStatusFromRelationship(
  sr: number | null | undefined
): StopStatus {
  if (sr === STOP_SKIPPED) return "skipped";
  if (sr === STOP_NO_DATA) return "no_data";
  return "scheduled";
}

// GTFS-RT: an alert with no active_period is always active. Otherwise it's
// active if at least one period covers now. start=0/unset means -infinity,
// end=0/unset means +infinity. Unset bounds decode as a Long(0) object, which
// is truthy, so they go through extractRtTime rather than a truthiness check.
export function isAlertActiveAt(
  alert: TransitRealtime.IAlert,
  nowSecs: number
): boolean {
  const periods = alert.activePeriod;
  if (!periods || periods.length === 0) return true;
  const nowMs = nowSecs * 1000;
  for (const p of periods) {
    const start = extractRtTime(p.start) ?? 0;
    const end = extractRtTime(p.end) ?? Number.MAX_SAFE_INTEGER;
    if (nowMs >= start && nowMs <= end) return true;
  }
  return false;
}
