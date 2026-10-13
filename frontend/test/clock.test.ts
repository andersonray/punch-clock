import { describe, expect, it } from "vitest";
import {
  INNER_RADIUS,
  OUTER_RADIUS,
  angleAt,
  hourAt,
  hourItems,
  minuteAt,
  minuteItems,
  polar,
  to12,
  to24,
} from "../src/logic/clock";

/** Offset from the dial center for an angle (degrees clockwise from 12) and radius. */
const at = (angle: number, radius = OUTER_RADIUS) => {
  const p = polar(angle, radius);
  return [p.x - 128, p.y - 128] as const;
};

describe("dial geometry", () => {
  it("measures angles clockwise from 12 o'clock", () => {
    expect(angleAt(0, -10)).toBeCloseTo(0);
    expect(angleAt(10, 0)).toBeCloseTo(90);
    expect(angleAt(0, 10)).toBeCloseTo(180);
    expect(angleAt(-10, 0)).toBeCloseTo(270);
  });

  it("lays out a 12-hour dial with 12 at the top", () => {
    const items = hourItems(false);
    expect(items.map((i) => i.label)).toEqual([
      "12",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
    expect(items.every((i) => !i.inner)).toBe(true);
  });

  it("lays out a 24-hour dial like Android: 12 and 1-11 outside, 00 and 13-23 inside", () => {
    const items = hourItems(true);
    expect(items.filter((i) => !i.inner).map((i) => i.value)).toEqual([
      12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(items.filter((i) => i.inner).map((i) => i.label)).toEqual([
      "00",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
    ]);
    expect(new Set(items.map((i) => i.value)).size).toBe(24);
  });

  it("labels minutes every five", () => {
    expect(minuteItems().map((i) => i.label)).toEqual([
      "00",
      "05",
      "10",
      "15",
      "20",
      "25",
      "30",
      "35",
      "40",
      "45",
      "50",
      "55",
    ]);
  });

  it("picks hours from a point", () => {
    expect(hourAt(...at(0), false)).toBe(12);
    expect(hourAt(...at(90), false)).toBe(3);
    expect(hourAt(...at(100), false)).toBe(3); // snaps to the nearest hour
    expect(hourAt(...at(350), false)).toBe(12);
    expect(hourAt(...at(270, INNER_RADIUS), false)).toBe(9); // one ring in 12-hour mode
    expect(hourAt(...at(90), true)).toBe(3);
    expect(hourAt(...at(90, INNER_RADIUS), true)).toBe(15);
    expect(hourAt(...at(0, INNER_RADIUS), true)).toBe(0);
    expect(hourAt(...at(0), true)).toBe(12);
  });

  it("picks any minute from a point", () => {
    expect(minuteAt(...at(0))).toBe(0);
    expect(minuteAt(...at(180))).toBe(30);
    expect(minuteAt(...at(42))).toBe(7);
    expect(minuteAt(...at(358))).toBe(0); // wraps to the top
  });

  it("converts between 12- and 24-hour hours", () => {
    expect(to24(12, false)).toBe(0);
    expect(to24(12, true)).toBe(12);
    expect(to24(7, true)).toBe(19);
    expect(to12(0)).toBe(12);
    expect(to12(13)).toBe(1);
    expect(to12(12)).toBe(12);
  });
});
