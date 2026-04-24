import { describe, it, expect, afterEach, vi } from "vitest";
import {
  currentGtfsTime,
  formatLocalTime,
  formatLocalDateTime,
  localMidnightMs,
  previousGtfsDate,
  shiftGtfsTimeByDays,
} from "../src/time.js";

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

describe("localMidnightMs", () => {
  // Round-trips: formatting the returned unix ms back to HH:MM:SS in the tz
  // must yield "00:00:00". This is the invariant that matters at call sites.
  const cases: Array<[number, string, string]> = [
    [20260715, "UTC", "regular UTC day"],
    [20260715, "America/New_York", "regular NY day"],
    [20260308, "America/New_York", "spring-forward NY"],
    [20261101, "America/New_York", "fall-back NY"],
    [20260329, "Europe/London", "spring-forward UK"],
    [20260125, "Asia/Kolkata", "Kolkata (+5:30) winter"],
    [20260405, "Pacific/Auckland", "fall-back NZ"],
    [20260927, "Pacific/Auckland", "spring-forward NZ"],
  ];
  for (const [date, tz, label] of cases) {
    it(`returns midnight local for ${label}`, () => {
      const ms = localMidnightMs(date, tz);
      expect(formatLocalTime(new Date(ms), tz)).toBe("00:00:00");
    });
  }
});

describe("previousGtfsDate", () => {
  it("rolls back across month boundaries", () => {
    expect(previousGtfsDate(20260301)).toBe(20260228);
    expect(previousGtfsDate(20260101)).toBe(20251231);
    expect(previousGtfsDate(20260501)).toBe(20260430);
  });
  it("handles leap year February", () => {
    expect(previousGtfsDate(20240301)).toBe(20240229);
  });
});

describe("shiftGtfsTimeByDays", () => {
  it("adds 24h to produce 24h+ times usable in yesterday-service queries", () => {
    expect(shiftGtfsTimeByDays("01:30:00", 1)).toBe("25:30:00");
    expect(shiftGtfsTimeByDays("00:00:00", 1)).toBe("24:00:00");
    expect(shiftGtfsTimeByDays("10:15:30", 1)).toBe("34:15:30");
  });
});
