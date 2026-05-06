import { z } from "zod";

// --- Building-block schemas ---

export const StopSchema = z.object({
  stop_id: z.string(),
  name: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});

export const NearbyStopSchema = StopSchema.extend({
  distance_m: z.number(),
});

export const StopWithParentSchema = StopSchema.extend({
  parent_station: z.string().nullable(),
});

export const RouteSummarySchema = z.object({
  route_id: z.string(),
  short_name: z.string().nullable(),
  long_name: z.string().nullable(),
  type: z.number(),
});

export const RouteDetailSchema = RouteSummarySchema.extend({
  color: z.string().nullable(),
});

export const SystemEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const ArrivalSchema = z.object({
  trip_id: z.string(),
  route_id: z.string(),
  stop_id: z.string(),
  arrival_time: z.string(),
  minutes_away: z.number().nullable(),
  headsign: z.string().nullable(),
  is_realtime: z.boolean(),
  is_added: z.boolean().optional(),
});

export const ActivePeriodSchema = z.object({
  start: z.string().nullable(),
  end: z.string().nullable(),
});

export const InformedEntitySchema = z.object({
  route_id: z.string().nullable(),
  stop_id: z.string().nullable(),
  trip_id: z.string().nullable(),
});

export const AlertSchema = z.object({
  id: z.string(),
  header: z.string(),
  description: z.string(),
  cause: z.string().nullable(),
  effect: z.string().nullable(),
  active_periods: z.array(ActivePeriodSchema),
  informed_entities: z.array(InformedEntitySchema),
});

export const VehiclePositionSchema = z.object({
  vehicle_id: z.string().nullable(),
  trip_id: z.string().nullable(),
  route_id: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  bearing: z.number().nullable(),
  speed: z.number().nullable(),
  timestamp: z.string().nullable(),
  stop_id: z.string().nullable(),
  current_status: z.string().nullable(),
  occupancy_status: z.string().nullable(),
  congestion_level: z.string().nullable(),
});

export const TripStopTimeSchema = z.object({
  stop_id: z.string().nullable(),
  stop_name: z.string().nullable(),
  stop_sequence: z.number(),
  arrival_time: z.string().nullable(),
  departure_time: z.string().nullable(),
  arrival_delay_seconds: z.number().nullable(),
  departure_delay_seconds: z.number().nullable(),
  is_realtime: z.boolean(),
  status: z.enum(["scheduled", "skipped", "no_data"]),
});

export const TripSchema = z.object({
  trip_id: z.string(),
  route_id: z.string().nullable(),
  service_id: z.string().nullable(),
  trip_headsign: z.string().nullable(),
  direction_id: z.number().nullable(),
  status: z.enum(["scheduled", "canceled", "added"]),
});

export const FeedStatusSchema = z.object({
  configured: z.boolean(),
  urls: z.number(),
  urls_ok: z.number(),
  urls_failed: z.number(),
  entities: z.number(),
  oldest_feed_age_seconds: z.number().nullable(),
  errors: z.array(z.string()),
});

// --- Tool response schemas (top-level structuredContent shape) ---

export const ListSystemsResponseSchema = z.object({
  systems: z.array(SystemEntrySchema),
});

export const SearchStopsResponseSchema = z.object({
  stops: z.array(StopSchema),
});

export const NearbyStopsResponseSchema = z.object({
  stops: z.array(NearbyStopSchema),
});

export const StopDetailsResponseSchema = z.object({
  stop: StopWithParentSchema,
  routes: z.array(RouteSummarySchema),
});

export const ListRoutesResponseSchema = z.object({
  total: z.number(),
  routes: z.array(RouteSummarySchema),
});

export const RouteDetailsResponseSchema = z.object({
  route: RouteDetailSchema,
  stops: z.array(StopSchema),
});

export const ArrivalsResponseSchema = z.object({
  data_source: z.enum(["realtime", "scheduled", "mixed", "none"]),
  arrivals: z.array(ArrivalSchema),
});

export const AlertsResponseSchema = z.object({
  alerts: z.array(AlertSchema),
});

export const VehiclesResponseSchema = z.object({
  vehicles: z.array(VehiclePositionSchema),
});

export const TripDetailsResponseSchema = z.object({
  trip: TripSchema,
  stop_times: z.array(TripStopTimeSchema),
});

export const SystemStatusResponseSchema = z.object({
  system_id: z.string(),
  system_name: z.string(),
  route_count: z.number(),
  stop_count: z.number(),
  active_alerts: z.number(),
  feeds: z.object({
    trip_updates: FeedStatusSchema,
    vehicle_positions: FeedStatusSchema,
    alerts: FeedStatusSchema,
  }),
});

// --- Inferred TS types ---

export type Arrival = z.infer<typeof ArrivalSchema>;
export type ArrivalsResponse = z.infer<typeof ArrivalsResponseSchema>;
export type ActivePeriod = z.infer<typeof ActivePeriodSchema>;
export type InformedEntity = z.infer<typeof InformedEntitySchema>;
export type Alert = z.infer<typeof AlertSchema>;
export type VehiclePosition = z.infer<typeof VehiclePositionSchema>;
