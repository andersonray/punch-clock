// Geometry of the clock-dial time picker (like Android's). Coordinates are in the
// dial's SVG viewBox units, measured from the dial's center; angles are degrees
// clockwise from 12 o'clock.

export const DIAL_SIZE = 256;
export const DIAL_CENTER = DIAL_SIZE / 2;
export const OUTER_RADIUS = 100;
export const INNER_RADIUS = 62;

export interface DialItem {
  /** Hours: 1-12 in 12-hour mode, 0-23 in 24-hour mode. Minutes: 0-55. */
  value: number;
  label: string;
  angle: number;
  radius: number;
  inner: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * Hour positions. 12-hour: one ring, 12 at the top. 24-hour (as on Android): the
 * outer ring is 12 and 1-11, the inner ring 00 and 13-23.
 */
export function hourItems(use24h: boolean): DialItem[] {
  const outer = Array.from({ length: 12 }, (_, i) => ({
    value: i === 0 ? 12 : i,
    label: String(i === 0 ? 12 : i),
    angle: i * 30,
    radius: OUTER_RADIUS,
    inner: false,
  }));
  if (!use24h) return outer;
  const inner = Array.from({ length: 12 }, (_, i) => ({
    value: i === 0 ? 0 : i + 12,
    label: i === 0 ? "00" : String(i + 12),
    angle: i * 30,
    radius: INNER_RADIUS,
    inner: true,
  }));
  return [...outer, ...inner];
}

/** Minute labels every five minutes; any minute can still be picked. */
export function minuteItems(): DialItem[] {
  return Array.from({ length: 12 }, (_, i) => ({
    value: i * 5,
    label: pad(i * 5),
    angle: i * 30,
    radius: OUTER_RADIUS,
    inner: false,
  }));
}

/** Point on the dial at an angle and radius. */
export function polar(angle: number, radius: number): { x: number; y: number } {
  const rad = (angle * Math.PI) / 180;
  return { x: DIAL_CENTER + radius * Math.sin(rad), y: DIAL_CENTER - radius * Math.cos(rad) };
}

/** Angle of an offset from the center: 0 at 12 o'clock, increasing clockwise. */
export function angleAt(dx: number, dy: number): number {
  return ((((Math.atan2(dx, -dy) * 180) / Math.PI) % 360) + 360) % 360;
}

/**
 * The hour under a pointer. Returns 1-12 in 12-hour mode (combine with AM/PM using
 * `to24`), 0-23 in 24-hour mode, where the distance from the center picks the ring.
 */
export function hourAt(dx: number, dy: number, use24h: boolean): number {
  const index = Math.round(angleAt(dx, dy) / 30) % 12;
  if (use24h && Math.hypot(dx, dy) < (OUTER_RADIUS + INNER_RADIUS) / 2) {
    return index === 0 ? 0 : index + 12;
  }
  return index === 0 ? 12 : index;
}

/** The minute under a pointer, at 1-minute resolution. */
export function minuteAt(dx: number, dy: number): number {
  return Math.round(angleAt(dx, dy) / 6) % 60;
}

/** 12-hour clock hour (1-12) plus AM/PM to a 24-hour hour (0-23). */
export const to24 = (hour12: number, pm: boolean): number => (hour12 % 12) + (pm ? 12 : 0);

/** 24-hour hour to the hour shown on a 12-hour clock (1-12). */
export const to12 = (hour24: number): number => hour24 % 12 || 12;
