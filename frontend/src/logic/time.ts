// Wall-clock time helpers. Day indices are 0 = Monday ... 6 = Sunday, like the backend.

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
export const SNAP_MINUTES = 15;

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));

export const snapFloor = (minute: number, step = SNAP_MINUTES): number =>
  Math.floor(minute / step) * step;

export const snapCeil = (minute: number, step = SNAP_MINUTES): number =>
  Math.ceil(minute / step) * step;

/** Day indices in display order for a given first day of the week. */
export function displayDays(weekStart: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
}

export interface Segment {
  day: number;
  start: number;
  end: number;
  /** True for the part of a block that continues from the previous day. */
  continuation: boolean;
  /** True if the block continues into the next day. */
  continues: boolean;
}

/** Split a block into per-day pieces (at most two). */
export function segments(day: number, start: number, duration: number): Segment[] {
  const end = start + duration;
  if (end <= MINUTES_PER_DAY) {
    return [{ day, start, end, continuation: false, continues: false }];
  }
  return [
    { day, start, end: MINUTES_PER_DAY, continuation: false, continues: true },
    {
      day: (day + 1) % 7,
      start: 0,
      end: end - MINUTES_PER_DAY,
      continuation: true,
      continues: false,
    },
  ];
}

/** Duration from a start and stop time of day. Stop at or before start means the next day. */
export function durationBetween(start: number, stop: number): number {
  const minutes = (((stop - start) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return minutes === 0 ? MINUTES_PER_DAY : minutes;
}

export const stopMinute = (start: number, duration: number): number =>
  (start + duration) % MINUTES_PER_DAY;

const pad = (n: number): string => String(n).padStart(2, "0");

/** "HH:MM" for <input type="time">. */
export function toTimeInput(minute: number): string {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Parse "HH:MM" (or "HH:MM:SS"); null if invalid. */
export function parseTimeInput(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Whether to show 24-hour times, following Home Assistant's profile setting. */
export function uses24h(locale: { language: string; time_format?: string }): boolean {
  switch (locale.time_format) {
    case "24":
      return true;
    case "12":
      return false;
    case "system":
      return !new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12;
    default:
      return !new Intl.DateTimeFormat(locale.language, { hour: "numeric" }).resolvedOptions()
        .hour12;
  }
}

/** Format a minute of the day; 1440 is shown as the end of the day. */
export function formatMinute(minute: number, use24h: boolean): string {
  if (use24h) {
    if (minute === MINUTES_PER_DAY) return "24:00";
    return toTimeInput(minute);
  }
  const m = minute % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  const suffix = h < 12 ? "AM" : "PM";
  return `${((h + 11) % 12) + 1}:${pad(m % 60)} ${suffix}`;
}

/** Hour label for the time axis. */
export function formatHour(hour: number, use24h: boolean): string {
  if (use24h) return `${pad(hour)}:00`;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${((hour + 11) % 12) + 1} ${suffix}`;
}

export function formatRange(start: number, duration: number, use24h: boolean): string {
  const end = start + duration;
  const stop = end > MINUTES_PER_DAY ? end - MINUTES_PER_DAY : end;
  return `${formatMinute(start, use24h)} – ${formatMinute(stop, use24h)}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} h ${m} min`;
  return h ? `${h} h` : `${m} min`;
}

/** Localized weekday name for a day index (0 = Monday). */
export function dayName(day: number, language: string, style: "short" | "long" = "short"): string {
  // 2024-01-01 was a Monday.
  const date = new Date(Date.UTC(2024, 0, 1 + day));
  try {
    return new Intl.DateTimeFormat(language, { weekday: style, timeZone: "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en", { weekday: style, timeZone: "UTC" }).format(date);
  }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface WallClock {
  day: number;
  minute: number;
}

/** Current wall-clock day and minute in a time zone (Home Assistant's, not the browser's). */
export function nowIn(timeZone: string, date: Date = new Date()): WallClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  return { day: WEEKDAYS.indexOf(get("weekday")), minute: hour * 60 + Number(get("minute")) };
}

/** True if two weekly windows (start minute of week + duration) overlap. */
export function windowsOverlap(
  aStart: number,
  aDur: number,
  bStart: number,
  bDur: number,
): boolean {
  const ab = (((bStart - aStart) % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  const ba = (((aStart - bStart) % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return ab < aDur || ba < bDur;
}
