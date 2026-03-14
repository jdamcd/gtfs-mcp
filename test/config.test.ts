import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, AppConfigSchema } from "../src/config.js";

const TMP_DIR = "/tmp/gtfs-mcp-test/config";

describe("AppConfigSchema", () => {
  it("parses a valid config", () => {
    const config = AppConfigSchema.parse({
      systems: [
        {
          id: "test",
          name: "Test",
          schedule_url: "http://example.com/gtfs.zip",
          realtime: {
            trip_updates: ["http://example.com/tu"],
            vehicle_positions: [],
            alerts: [],
          },
          auth: null,
        },
      ],
    });
    expect(config.systems).toHaveLength(1);
    expect(config.data_dir).toBe("~/.gtfs-mcp/data");
    expect(config.schedule_refresh_hours).toBe(24);
  });

  it("applies defaults for data_dir and schedule_refresh_hours", () => {
    const config = AppConfigSchema.parse({
      systems: [],
    });
    expect(config.data_dir).toBe("~/.gtfs-mcp/data");
    expect(config.schedule_refresh_hours).toBe(24);
  });

  it("rejects missing systems field", () => {
    expect(() => AppConfigSchema.parse({})).toThrow();
  });

  it("rejects system with missing required fields", () => {
    expect(() =>
      AppConfigSchema.parse({
        systems: [{ id: "test" }],
      })
    ).toThrow();
  });

  it("validates auth config", () => {
    const config = AppConfigSchema.parse({
      systems: [
        {
          id: "test",
          name: "Test",
          schedule_url: "http://example.com/gtfs.zip",
          realtime: { trip_updates: [], vehicle_positions: [], alerts: [] },
          auth: {
            type: "query_param",
            param_name: "api_key",
            key_env: "MY_KEY",
          },
        },
      ],
    });
    expect(config.systems[0].auth?.type).toBe("query_param");
  });

  it("rejects invalid auth type", () => {
    expect(() =>
      AppConfigSchema.parse({
        systems: [
          {
            id: "test",
            name: "Test",
            schedule_url: "http://example.com/gtfs.zip",
            realtime: { trip_updates: [], vehicle_positions: [], alerts: [] },
            auth: { type: "invalid", key_env: "MY_KEY" },
          },
        ],
      })
    ).toThrow();
  });
});

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("throws when GTFS_MCP_CONFIG is not set", () => {
    delete process.env.GTFS_MCP_CONFIG;
    expect(() => loadConfig()).toThrow("GTFS_MCP_CONFIG");
  });

  it("loads and parses a valid config file", () => {
    const configPath = join(TMP_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        systems: [
          {
            id: "test",
            name: "Test",
            schedule_url: "http://example.com/gtfs.zip",
            realtime: { trip_updates: [], vehicle_positions: [], alerts: [] },
            auth: null,
          },
        ],
        data_dir: "/tmp/test-data",
      })
    );

    process.env.GTFS_MCP_CONFIG = configPath;
    const config = loadConfig();
    expect(config.systems[0].id).toBe("test");
    expect(config.data_dir).toBe("/tmp/test-data");
  });

  it("resolves ~ in data_dir to home directory", () => {
    const configPath = join(TMP_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        systems: [],
        data_dir: "~/.gtfs-mcp/data",
      })
    );

    process.env.GTFS_MCP_CONFIG = configPath;
    const config = loadConfig();
    expect(config.data_dir).not.toContain("~");
    expect(config.data_dir).toContain("/.gtfs-mcp/data");
  });

  it("throws on invalid JSON", () => {
    const configPath = join(TMP_DIR, "bad.json");
    writeFileSync(configPath, "not json{{{");

    process.env.GTFS_MCP_CONFIG = configPath;
    expect(() => loadConfig()).toThrow();
  });

  it("throws on missing file", () => {
    process.env.GTFS_MCP_CONFIG = join(TMP_DIR, "nonexistent.json");
    expect(() => loadConfig()).toThrow();
  });
});
