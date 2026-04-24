import type { GtfsDb } from "./queries.js";
import type { DayColumn } from "../time.js";

// Resolve services active on a given GTFS service date, honoring calendar
// day-of-week + start/end ranges, then applying calendar_dates exceptions
// (type 1 = service added, type 2 = service removed). Some agencies (TriMet,
// Translink) publish only calendar_dates; this handles that case via the
// same merge logic.
export function getActiveServiceIds(
  db: GtfsDb,
  date: number,
  dayColumn: DayColumn
): string[] {
  const base = db
    .prepare(
      `SELECT service_id FROM calendar
       WHERE "${dayColumn}" = 1 AND start_date <= ? AND end_date >= ?`
    )
    .all(date, date) as Array<{ service_id: string }>;

  const exceptions = db
    .prepare(
      `SELECT service_id, exception_type FROM calendar_dates WHERE date = ?`
    )
    .all(date) as Array<{ service_id: string; exception_type: number }>;

  const active = new Set(base.map((r) => r.service_id));
  for (const e of exceptions) {
    if (e.exception_type === 1) active.add(e.service_id);
    else if (e.exception_type === 2) active.delete(e.service_id);
  }
  return Array.from(active);
}
