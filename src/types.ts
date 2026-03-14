export interface Arrival {
  trip_id: string;
  route_id: string;
  stop_id: string;
  arrival_time: string; // HH:MM:SS local time
  minutes_away: number | null; // minutes until arrival (realtime only)
  headsign: string | null;
  is_realtime: boolean;
}

export interface VehiclePosition {
  vehicle_id: string | null;
  trip_id: string | null;
  route_id: string | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed: number | null;
  timestamp: string | null;
  stop_id: string | null;
  current_status: string | null;
}

export interface ActivePeriod {
  start: string | null;
  end: string | null;
}

export interface InformedEntity {
  route_id?: string | null;
  stop_id?: string | null;
  trip_id?: string | null;
}

export interface Alert {
  id: string;
  header: string;
  description: string;
  cause: string | null;
  effect: string | null;
  active_periods: ActivePeriod[];
  informed_entities: InformedEntity[];
}
