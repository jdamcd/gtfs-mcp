import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export const AuthConfigSchema = z.object({
  type: z.enum(["query_param", "header"]),
  param_name: z.string().optional(),
  header_name: z.string().optional(),
  key_env: z.string(),
});

export const RealtimeConfigSchema = z.object({
  trip_updates: z.array(z.string()),
  vehicle_positions: z.array(z.string()),
  alerts: z.array(z.string()),
});

const TimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid IANA timezone (e.g. 'America/New_York', 'Europe/London')" }
);

export const SystemConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  schedule_url: z.string(),
  timezone: TimezoneSchema,
  realtime: RealtimeConfigSchema,
  auth: AuthConfigSchema.nullable(),
});

export const AppConfigSchema = z.object({
  systems: z.array(SystemConfigSchema),
  data_dir: z.string().default("~/.gtfs-mcp/data"),
  schedule_refresh_hours: z.number().default(24),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type RealtimeConfig = z.infer<typeof RealtimeConfigSchema>;
export type SystemConfig = z.infer<typeof SystemConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(): AppConfig {
  const configPath = process.env.GTFS_MCP_CONFIG;
  if (!configPath) {
    throw new Error(
      "GTFS_MCP_CONFIG environment variable must be set to the path of the config file"
    );
  }

  const resolvedPath = resolve(configPath.replace(/^~/, homedir()));
  const raw = readFileSync(resolvedPath, "utf-8");
  const json = JSON.parse(raw);
  const config = AppConfigSchema.parse(json);

  // Resolve ~ in data_dir
  config.data_dir = config.data_dir.replace(/^~/, homedir());

  return config;
}
