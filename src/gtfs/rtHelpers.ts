import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import type { transit_realtime as TransitRealtime } from "gtfs-realtime-bindings";

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
// end=0/unset means +infinity.
export function isAlertActiveAt(
  alert: TransitRealtime.IAlert,
  nowSecs: number
): boolean {
  const periods = alert.activePeriod;
  if (!periods || periods.length === 0) return true;
  for (const p of periods) {
    const start = p.start ? Number(p.start) : 0;
    const end = p.end ? Number(p.end) : Number.MAX_SAFE_INTEGER;
    if (nowSecs >= start && nowSecs <= end) return true;
  }
  return false;
}
