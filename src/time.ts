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

function parts(date: Date, timezone: string): Parts {
  const out: Partial<Parts> = {};
  for (const p of getFormatter(timezone).formatToParts(date)) {
    if (p.type !== "literal") out[p.type as keyof Parts] = p.value;
  }
  return out as Parts;
}

/** Current wall-clock time in the agency timezone, as HH:MM:SS, for comparing with GTFS stop_times. */
export function currentGtfsTime(timezone: string): string {
  const p = parts(new Date(), timezone);
  return `${p.hour}:${p.minute}:${p.second}`;
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
