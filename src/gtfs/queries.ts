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

export function resolveStopIds(db: any, stopId: string): string[] {
  // If this is a parent station, return its child stop IDs
  const children = db
    .prepare(`SELECT stop_id FROM stops WHERE parent_station = ?`)
    .all(stopId) as Array<{ stop_id: string }>;

  if (children.length > 0) {
    return children.map((c) => c.stop_id);
  }

  // Otherwise return the stop ID itself
  return [stopId];
}

export function searchStops(
  db: any,
  query: string,
  limit: number = 10
): StopResult[] {
  const stmt = db.prepare(
    `SELECT stop_id, stop_name, stop_lat, stop_lon, stop_code, location_type, parent_station
     FROM stops
     WHERE stop_name LIKE ?
     LIMIT ?`
  );
  return stmt.all(`%${query}%`, limit) as StopResult[];
}

export function getStopDetails(
  db: any,
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
  db: any,
  stopIds: string[],
  routeId?: string,
  limit: number = 10,
  fromTime?: string
): Array<StopTimeResult & { route_id: string; trip_headsign: string | null }> {
  const placeholders = stopIds.map(() => "?").join(", ");
  let query = `
    SELECT st.trip_id, st.arrival_time, st.departure_time, st.stop_id, st.stop_sequence,
           st.stop_headsign, st.pickup_type, st.drop_off_type,
           t.route_id, t.trip_headsign
    FROM stop_times st
    INNER JOIN trips t ON st.trip_id = t.trip_id
    WHERE st.stop_id IN (${placeholders})
  `;
  const params: any[] = [...stopIds];

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

  return db.prepare(query).all(...params);
}

export function listRoutes(
  db: any,
  routeType?: number
): RouteResult[] {
  if (routeType !== undefined) {
    return db
      .prepare(
        `SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id
         FROM routes WHERE route_type = ?`
      )
      .all(routeType) as RouteResult[];
  }
  return db
    .prepare(
      `SELECT route_id, route_short_name, route_long_name, route_type, route_color, route_text_color, agency_id
       FROM routes`
    )
    .all() as RouteResult[];
}

export function getRouteDetails(
  db: any,
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

  // Get ordered stops for one representative trip on this route
  let tripQuery = `SELECT trip_id FROM trips WHERE route_id = ?`;
  const tripParams: any[] = [routeId];

  if (directionId !== undefined) {
    tripQuery += ` AND direction_id = ?`;
    tripParams.push(directionId);
  }

  tripQuery += ` LIMIT 1`;
  const trip = db.prepare(tripQuery).get(...tripParams);

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
  db: any,
  tripId: string
): {
  trip: any | null;
  stop_times: Array<StopTimeResult & { stop_name: string }>;
} {
  const trip = db
    .prepare(
      `SELECT trip_id, route_id, service_id, trip_headsign, direction_id
       FROM trips WHERE trip_id = ?`
    )
    .get(tripId);

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
    .all(tripId);

  return { trip, stop_times: stopTimes };
}
