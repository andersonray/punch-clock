import { describe, expect, it } from "vitest";
import {
  dayName,
  displayDays,
  durationBetween,
  formatHour,
  formatMinute,
  formatRange,
  nowIn,
  parseTimeInput,
  segments,
  snapCeil,
  snapFloor,
  stopMinute,
  toTimeInput,
  uses24h,
  windowsOverlap,
} from "../src/logic/time";

describe("displayDays", () => {
  it("starts on the configured day", () => {
    expect(displayDays(6)).toEqual([6, 0, 1, 2, 3, 4, 5]); // Sunday first
    expect(displayDays(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let start = 0; start < 7; start++) {
      const days = displayDays(start);
      expect(days[0]).toBe(start);
      expect([...days].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
});

describe("segments", () => {
  // Same cases as tests/pure/test_timemath.py::test_segments.
  it("matches the backend", () => {
    const strip = (s: ReturnType<typeof segments>) =>
      s.map(({ day, start, end }) => [day, start, end]);
    expect(strip(segments(1, 480, 60))).toEqual([[1, 480, 540]]);
    expect(strip(segments(1, 1320, 240))).toEqual([
      [1, 1320, 1440],
      [2, 0, 120],
    ]);
    expect(strip(segments(6, 1320, 240))).toEqual([
      [6, 1320, 1440],
      [0, 0, 120],
    ]);
    expect(strip(segments(3, 0, 1440))).toEqual([[3, 0, 1440]]);
  });

  it("marks continuations", () => {
    const [first, second] = segments(4, 1380, 120);
    expect(first).toMatchObject({ continues: true, continuation: false });
    expect(second).toMatchObject({ continues: false, continuation: true });
  });
});

describe("durations", () => {
  it("treats a stop at or before the start as the next day", () => {
    expect(durationBetween(360, 480)).toBe(120);
    expect(durationBetween(1320, 120)).toBe(240);
    expect(durationBetween(360, 360)).toBe(1440);
    expect(stopMinute(1320, 240)).toBe(120);
  });

  it("snaps to 15 minutes", () => {
    expect(snapFloor(434)).toBe(420);
    expect(snapCeil(421)).toBe(435);
    expect(snapCeil(435)).toBe(435);
  });
});

describe("formatting", () => {
  it("formats 12 and 24 hour times", () => {
    expect(formatMinute(0, false)).toBe("12:00 AM");
    expect(formatMinute(750, false)).toBe("12:30 PM");
    expect(formatMinute(1439, true)).toBe("23:59");
    expect(formatMinute(1440, true)).toBe("24:00");
    expect(formatHour(13, false)).toBe("1 PM");
    expect(formatHour(7, true)).toBe("07:00");
    expect(formatRange(1320, 240, true)).toBe("22:00 – 02:00");
  });

  it("round-trips time inputs", () => {
    expect(toTimeInput(391)).toBe("06:31");
    expect(parseTimeInput("06:31")).toBe(391);
    expect(parseTimeInput("6:31:00")).toBe(391);
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("nope")).toBeNull();
  });

  it("follows the profile time format", () => {
    expect(uses24h({ language: "en", time_format: "24" })).toBe(true);
    expect(uses24h({ language: "de", time_format: "12" })).toBe(false);
    expect(uses24h({ language: "en-US", time_format: "language" })).toBe(false);
    expect(uses24h({ language: "de-DE", time_format: "language" })).toBe(true);
  });

  it("names days starting from Monday", () => {
    expect(dayName(0, "en", "long")).toBe("Monday");
    expect(dayName(6, "en", "short")).toBe("Sun");
  });
});

describe("nowIn", () => {
  it("uses the given time zone, not the browser's", () => {
    // 2026-10-12 14:30 UTC is Monday 07:30 in Los Angeles and Tuesday 03:30 in Auckland (NZDT, +13).
    const date = new Date(Date.UTC(2026, 9, 12, 14, 30));
    expect(nowIn("America/Los_Angeles", date)).toEqual({ day: 0, minute: 450 });
    expect(nowIn("Pacific/Auckland", date)).toEqual({ day: 1, minute: 210 });
  });
});

describe("windowsOverlap", () => {
  it("handles the week wrap", () => {
    expect(windowsOverlap(0, 60, 30, 60)).toBe(true);
    expect(windowsOverlap(0, 60, 60, 60)).toBe(false);
    expect(windowsOverlap(10020, 120, 30, 10)).toBe(true); // Sun 23:00 + 2 h covers Mon 00:30
    expect(windowsOverlap(10020, 60, 30, 10)).toBe(false);
  });
});
