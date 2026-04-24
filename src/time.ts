// hourCycle 'h23' keeps midnight at 00, not 24.
type Parts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, fmt);
  }
  return fmt;
}

function getOffsetFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = offsetFormatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    offsetFormatterCache.set(timezone, fmt);
  }
  return fmt;
}

function parts(date: Date, timezone: string): Parts {
  const out: Partial<Parts> = {};
  for (const p of getFormatter(timezone).formatToParts(date)) {
    if (p.type !== "literal") out[p.type as keyof Parts] = p.value;
  }
  return out as Parts;
}

function decomposeGtfsDate(date: number): { y: number; m: number; d: number } {
  return {
    y: Math.floor(date / 10000),
    m: Math.floor((date % 10000) / 100),
    d: date % 100,
  };
}

/** Current wall-clock time in the agency timezone, as HH:MM:SS, for comparing with GTFS stop_times. */
export function currentGtfsTime(timezone: string): string {
  const p = parts(new Date(), timezone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** Current GTFS service date in agency timezone as YYYYMMDD integer (matches calendar.txt format). */
export function currentGtfsDate(timezone: string): number {
  const p = parts(new Date(), timezone);
  return Number(`${p.year}${p.month}${p.day}`);
}

/** HH:MM:SS in the agency timezone. */
export function formatLocalTime(date: Date, timezone: string): string {
  const p = parts(date, timezone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** YYYY-MM-DD HH:MM:SS in the agency timezone. */
export function formatLocalDateTime(date: Date, timezone: string): string {
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** UNIX timestamp in ms from a protobuf Long/number time field. null if unset (zero). */
export function extractRtTime(time: unknown): number | null {
  if (time == null) return null;
  const n = Number(time);
  return n > 0 ? n * 1000 : null;
}

/** Matches the HH:MM:SS shape produced by formatLocalTime / currentGtfsTime. */
export const GTFS_TIME_PATTERN = /^\d{2}:\d{2}:\d{2}$/;

export type DayColumn =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export const DAY_COLUMNS: ReadonlyArray<DayColumn> = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** Returns the YYYYMMDD of the day before the given GTFS date, honoring month/year boundaries. */
export function previousGtfsDate(date: number): number {
  const { y, m, d } = decomposeGtfsDate(date);
  const prev = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  return (
    prev.getUTCFullYear() * 10000 +
    (prev.getUTCMonth() + 1) * 100 +
    prev.getUTCDate()
  );
}

/** GTFS calendar day-of-week column for an arbitrary GTFS date (YYYYMMDD). */
export function dayColumnFromDate(date: number): DayColumn {
  const { y, m, d } = decomposeGtfsDate(date);
  return DAY_COLUMNS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function timezoneOffsetMs(timezone: string, atMs: number): number {
  const tzName = getOffsetFormatter(timezone)
    .formatToParts(new Date(atMs))
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  if (tzName === "GMT") return 0;
  const match = tzName.match(/GMT([+-])(\d{1,2}):?(\d{0,2})/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const h = Number(match[2]);
  const m = Number(match[3] || 0);
  return sign * (h * 3600_000 + m * 60_000);
}

/** Unix ms of midnight (local time) for a given GTFS service date in the agency timezone. */
export function localMidnightMs(date: number, timezone: string): number {
  const { y, m, d } = decomposeGtfsDate(date);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Fixed-point iteration over `candidate = utcMidnight - offset(candidate)`.
  // Any single-offset sample can be wrong on DST transition days (e.g. NZ
  // fall-back reads NZST at UTC midnight but local midnight was in NZDT).
  // Iterating once or twice reaches the stable offset regime.
  let offset = timezoneOffsetMs(timezone, utcMidnight);
  let candidate = utcMidnight - offset;
  for (let i = 0; i < 3; i++) {
    const next = timezoneOffsetMs(timezone, candidate);
    if (next === offset) return candidate;
    offset = next;
    candidate = utcMidnight - offset;
  }
  return candidate;
}

/**
 * Parse a GTFS stop_time (HH:MM:SS, hours may exceed 23 for service that
 * continues past midnight) into seconds since service-day midnight.
 */
export function gtfsTimeToSeconds(time: string): number {
  const [h, m, s] = time.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/** Shift a GTFS HH:MM:SS time by N×24 hours to express it relative to a past/future service day. */
export function shiftGtfsTimeByDays(time: string, days: number): string {
  const [h, m, s] = time.split(":");
  const shifted = Number(h) + 24 * days;
  return `${String(shifted).padStart(2, "0")}:${m}:${s}`;
}
