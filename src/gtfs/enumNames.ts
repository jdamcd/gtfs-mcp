import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;

// protobuf.js reverse-maps numeric enum values to their string names on the
// same enum object (e.g. `Cause[8] === "WEATHER"`). Wrap with a helper that
// normalizes to lowercase for consumer friendliness and falls back to null
// for unknown/unset values.
function nameOf(
  enumObj: Record<string | number, string | number>,
  value: number | null | undefined
): string | null {
  if (value == null) return null;
  const name = enumObj[value];
  return typeof name === "string" ? name.toLowerCase() : null;
}

export function alertCauseName(value: number | null | undefined): string | null {
  return nameOf(transit_realtime.Alert.Cause, value);
}

export function alertEffectName(value: number | null | undefined): string | null {
  return nameOf(transit_realtime.Alert.Effect, value);
}

export function vehicleStopStatusName(
  value: number | null | undefined
): string | null {
  return nameOf(transit_realtime.VehiclePosition.VehicleStopStatus, value);
}

export function occupancyStatusName(
  value: number | null | undefined
): string | null {
  return nameOf(transit_realtime.VehiclePosition.OccupancyStatus, value);
}

export function congestionLevelName(
  value: number | null | undefined
): string | null {
  return nameOf(transit_realtime.VehiclePosition.CongestionLevel, value);
}
