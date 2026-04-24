import type { openDb } from "gtfs";

export type GtfsDb = ReturnType<typeof openDb>;

export interface TripRow {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign: string | null;
  direction_id: number | null;
}

export interface StopResult {
  stop_id: string;
  stop_name: string;
  stop_lat: number | null;
  stop_lon: number | null;
  stop_code: string | null;
  location_type: number | null;
  parent_station: string | null;
}

export interface RouteResult {
  route_id: string;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
  route_color: string | null;
  route_text_color: string | null;
  agency_id: string | null;
}

export interface StopTimeResult {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: number;
  stop_headsign: string | null;
  pickup_type: number | null;
  drop_off_type: number | null;
}

export interface NearbyStopResult extends StopResult {
  distance_m: number;
}

// Meters per degree of latitude (roughly constant). Dividing by cos(lat)
// adjusts for longitude lines converging toward the poles; the floor avoids
// runaway deltas at extreme latitudes where transit systems don't exist.
const METERS_PER_DEGREE = 111_320;
const MIN_COS_LAT = 0.01;

type PositionedStop = StopResult & { stop_lat: number; stop_lon: number };

export function findStopsNearby(
  db: GtfsDb,
  lat: number,
  lon: number,
  radiusMeters: number,
  limit: number
): NearbyStopResult[] {
  const latDelta = radiusMeters / METERS_PER_DEGREE;
  const lonDelta = radiusMeters / (METERS_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), MIN_COS_LAT));

  const candidates = db
    .prepare(
      `SELECT stop_id, stop_name, stop_lat, stop_lon, stop_code, location_type, parent_station
       FROM stops
       WHERE stop_lat BETWEEN ? AND ?
         AND stop_lon BETWEEN ? AND ?
         AND (parent_station IS NULL OR parent_station = '')
         AND stop_lat IS NOT NULL
         AND stop_lon IS NOT NULL`
    )
    .all(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta) as PositionedStop[];

  return candidates
    .map((s) => ({ ...s, distance_m: Math.round(haversineMeters(lat, lon, s.stop_lat, s.stop_lon)) }))
    .filter((s) => s.distance_m <= radiusMeters)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function getStopName(db: GtfsDb, stopId: string): string | null {
  const row = db
    .prepare(`SELECT stop_name FROM stops WHERE stop_id = ?`)
    .get(stopId) as { stop_name: string | null } | undefined;
  return row?.stop_name ?? null;
}

export function makeStopNameResolver(
  db: GtfsDb
): (stopId: string) => string | null {
  const cache = new Map<string, string | null>();
  return (stopId) => {
    let name = cache.get(stopId);
    if (name === undefined && !cache.has(stopId)) {
      name = getStopName(db, stopId);
      cache.set(stopId, name);
    }
    return name ?? null;
  };
}

export function resolveStopIds(db: GtfsDb, stopId: string): string[] {
  const children = db
    .prepare(`SELECT stop_id FROM stops WHERE parent_station = ?`)
    .all(stopId) as Array<{ stop_id: string }>;

  if (children.length > 0) {
    return children.map((c) => c.stop_id);
  }
  return [stopId];
}

export function searchStops(
  db: GtfsDb,
  query: string,
  limit: number = 10
): StopResult[] {
  const stmt = db.prepare(
    `SELECT stop_id, stop_name, stop_lat, stop_lon, stop_code, location_type, parent_station
     FROM stops
     WHERE stop_name LIKE ?
       AND (parent_station IS NULL OR parent_station = '')
       AND (location_type IS NULL OR location_type IN (0, 1))
     LIMIT ?`
  );
  return stmt.all(`%${query}%`, limit) as StopResult[];
}

export function getStopDetails(
  db: GtfsDb,
  stopId: string
): { stop: StopResult | null; routes: RouteResult[] } {
  const stop = db
    .prepare(
      `SELECT stop_id, stop_name, stop_lat, stop_lon, stop_code, location_type, parent_station
       FROM stops WHERE stop_id = ?`
    )
    .get(stopId) as StopResult | undefined;

  if (!stop) {
    return { stop: null, routes: [] };
  }

  // Resolve to child stops if this is a parent station
  const queryStopIds = resolveStopIds(db, stopId);
  const placeholders = queryStopIds.map(() => "?").join(", ");

  const routes = db
    .prepare(
      `SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, r.route_type, r.route_color, r.route_text_color, r.agency_id
       FROM routes r
       INNER JOIN trips t ON r.route_id = t.route_id
       INNER JOIN stop_times st ON t.trip_id = st.trip_id
       WHERE st.stop_id IN (${placeholders})`
    )
    .all(...queryStopIds) as RouteResult[];

  return { stop, routes };
}

export function getScheduledArrivals(
  db: GtfsDb,
  stopIds: string[],
  serviceIds: string[],
  routeId?: string,
  limit: number = 10,
  fromTime?: string
): Array<StopTimeResult & { route_id: string; trip_headsign: string | null }> {
  if (stopIds.length === 0 || serviceIds.length === 0) return [];

  const stopPlaceholders = stopIds.map(() => "?").join(", ");
  const servicePlaceholders = serviceIds.map(() => "?").join(", ");
  let query = `
    SELECT st.trip_id, st.arrival_time, st.departure_time, st.stop_id, st.stop_sequence,
           st.stop_headsign, st.pickup_type, st.drop_off_type,
           t.route_id, t.trip_headsign
    FROM stop_times st
    INNER JOIN trips t ON st.trip_id = t.trip_id
    WHERE st.stop_id IN (${stopPlaceholders})
      AND t.service_id IN (${servicePlaceholders})
  `;
  const params: (string | number)[] = [...stopIds, ...serviceIds];

  if (fromTime) {
    query += ` AND st.arrival_time >= ?`;
    params.push(fromTime);
  }

  if (routeId) {
    query += ` AND t.route_id = ?`;
    params.push(routeId);
  }

  query += ` ORDER BY st.arrival_time LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params) as Array<
    StopTimeResult & { route_id: string; trip_headsign: string | null }
  >;
}

export function listRoutes(
  db: GtfsDb,
  options: {
    routeType?: number;
    query?: string;
    limit?: number;
    offset?: number;
  } = {}
): { routes: RouteResult[]; total: number } {
  const { routeType, query, limit, offset } = options;
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (routeType !== undefined) {
    where.push("route_type = ?");
    params.push(routeType);
  }
  if (query) {
    where.push(
      "(route_short_name LIKE ? OR route_long_name LIKE ? OR route_id LIKE ?)"
    );
    const pattern = `%${query}%`;
    params.push(pattern, pattern, pattern);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  let listSql = `SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id
                 FROM routes${whereSql}
                 ORDER BY route_short_name, route_id`;
  const listParams = [...params];
  if (limit !== undefined) {
    listSql += " LIMIT ?";
    listParams.push(limit);
    if (offset) {
      listSql += " OFFSET ?";
      listParams.push(offset);
    }
  }

  const routes = db.prepare(listSql).all(...listParams) as RouteResult[];

  // Skip the COUNT(*) scan when we can derive `total` from the result itself:
  // no pagination, or the result came back smaller than the requested page.
  const needsCount =
    limit !== undefined && (routes.length === limit || (offset ?? 0) > 0);
  const total = needsCount
    ? (
        db
          .prepare(`SELECT COUNT(*) as n FROM routes${whereSql}`)
          .get(...params) as { n: number }
      ).n
    : routes.length + (offset ?? 0);

  return { routes, total };
}

export function getRouteDetails(
  db: GtfsDb,
  routeId: string,
  directionId?: number
): { route: RouteResult | null; stops: StopResult[] } {
  const route = db
    .prepare(
      `SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id
       FROM routes WHERE route_id = ?`
    )
    .get(routeId) as RouteResult | undefined;

  if (!route) {
    return { route: null, stops: [] };
  }

  // Pick the longest trip variant as representative — a bare LIMIT 1 returns
  // whatever SQLite finds first, which often lands on short-turn or branch
  // variants (e.g. the 8-stop Rockaway Park shuttle instead of the 58-stop A).
  let tripQuery = `SELECT t.trip_id FROM trips t
                   INNER JOIN stop_times st ON t.trip_id = st.trip_id
                   WHERE t.route_id = ?`;
  const tripParams: (string | number)[] = [routeId];

  if (directionId !== undefined) {
    tripQuery += ` AND t.direction_id = ?`;
    tripParams.push(directionId);
  }

  tripQuery += ` GROUP BY t.trip_id ORDER BY COUNT(st.stop_sequence) DESC LIMIT 1`;
  const trip = db.prepare(tripQuery).get(...tripParams) as
    | { trip_id: string }
    | undefined;

  if (!trip) {
    return { route, stops: [] };
  }

  const stops = db
    .prepare(
      `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, s.stop_code, s.location_type, s.parent_station
       FROM stop_times st
       INNER JOIN stops s ON st.stop_id = s.stop_id
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`
    )
    .all(trip.trip_id) as StopResult[];

  return { route, stops };
}

export function getTripDetails(
  db: GtfsDb,
  tripId: string
): {
  trip: TripRow | null;
  stop_times: Array<StopTimeResult & { stop_name: string }>;
} {
  const trip = db
    .prepare(
      `SELECT trip_id, route_id, service_id, trip_headsign, direction_id
       FROM trips WHERE trip_id = ?`
    )
    .get(tripId) as TripRow | undefined;

  if (!trip) {
    return { trip: null, stop_times: [] };
  }

  const stopTimes = db
    .prepare(
      `SELECT st.trip_id, st.arrival_time, st.departure_time, st.stop_id, st.stop_sequence,
              st.stop_headsign, st.pickup_type, st.drop_off_type, s.stop_name
       FROM stop_times st
       INNER JOIN stops s ON st.stop_id = s.stop_id
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`
    )
    .all(tripId) as Array<StopTimeResult & { stop_name: string }>;

  return { trip, stop_times: stopTimes };
}
