import { describe, it, expect, afterEach, vi } from "vitest";
import { currentGtfsTime, formatLocalTime, formatLocalDateTime } from "../src/time.js";

describe("formatLocalTime", () => {
  it("formats HH:MM:SS in the given timezone", () => {
    // 2026-04-20T12:00:00Z is 08:00 America/New_York (EDT)
    const d = new Date("2026-04-20T12:00:00Z");
    expect(formatLocalTime(d, "America/New_York")).toBe("08:00:00");
    expect(formatLocalTime(d, "Europe/London")).toBe("13:00:00");
    expect(formatLocalTime(d, "UTC")).toBe("12:00:00");
  });

  it("renders midnight as 00:00:00, not 24:00:00", () => {
    const d = new Date("2026-04-20T00:00:00Z");
    expect(formatLocalTime(d, "UTC")).toBe("00:00:00");
  });

  it("crosses the date boundary correctly", () => {
    // 03:30 UTC = 23:30 previous day in NY
    const d = new Date("2026-04-20T03:30:00Z");
    expect(formatLocalTime(d, "America/New_York")).toBe("23:30:00");
  });
});

describe("formatLocalDateTime", () => {
  it("formats YYYY-MM-DD HH:MM:SS in the given timezone", () => {
    const d = new Date("2026-04-20T12:00:00Z");
    expect(formatLocalDateTime(d, "America/New_York")).toBe("2026-04-20 08:00:00");
    expect(formatLocalDateTime(d, "Europe/London")).toBe("2026-04-20 13:00:00");
  });

  it("shows date rollover in the target timezone", () => {
    // 03:30 UTC = 23:30 April 19 in NY
    const d = new Date("2026-04-20T03:30:00Z");
    expect(formatLocalDateTime(d, "America/New_York")).toBe("2026-04-19 23:30:00");
  });
});

describe("currentGtfsTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the supplied timezone, not the server's", () => {
    vi.useFakeTimers({ now: new Date("2026-04-20T12:00:00Z") });
    expect(currentGtfsTime("America/New_York")).toBe("08:00:00");
    expect(currentGtfsTime("Europe/London")).toBe("13:00:00");
    expect(currentGtfsTime("Asia/Tokyo")).toBe("21:00:00");
  });
});
