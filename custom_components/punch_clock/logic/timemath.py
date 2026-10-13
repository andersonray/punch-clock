"""Wall-clock week math and DST-aware boundary times. See docs/semantics.md, "Time model"."""

from collections.abc import Iterable
from datetime import UTC, date, datetime, time, timedelta, tzinfo

from .model import MINUTES_PER_DAY, MINUTES_PER_WEEK, Block

_LOOKAHEAD_DAYS = 9


def week_minute(local: datetime) -> int:
    """Minute of the week (Monday 00:00 = 0) of a local, wall-clock datetime."""
    return local.weekday() * MINUTES_PER_DAY + local.hour * 60 + local.minute


def since_start(wm: int, start_wm: int) -> int:
    """Minutes elapsed since a block start, wrapping around the week."""
    return (wm - start_wm) % MINUTES_PER_WEEK


def in_window(wm: int, block: Block) -> bool:
    return since_start(wm, block.week_start) < block.duration


def boundaries(blocks: Iterable[Block]) -> set[int]:
    """Week minutes at which any block starts or ends."""
    result: set[int] = set()
    for block in blocks:
        result.add(block.week_start)
        result.add((block.week_start + block.duration) % MINUTES_PER_WEEK)
    return result


def segments(day: int, start: int, duration: int) -> list[tuple[int, int, int]]:
    """Split a block into per-day (day, start, end) pieces; at most two."""
    end = start + duration
    if end <= MINUTES_PER_DAY:
        return [(day, start, end)]
    return [(day, start, MINUTES_PER_DAY), ((day + 1) % 7, 0, end - MINUTES_PER_DAY)]


def wall_to_utc(day: date, minute: int, tz: tzinfo) -> list[datetime]:
    """UTC instants at which a local wall-clock time occurs.

    Usually one. Two in the repeated hour when clocks fall back. For a time that
    doesn't exist (clocks spring forward), the instant of the transition.
    """
    naive = datetime.combine(day, time(minute // 60, minute % 60))
    candidates = [naive.replace(tzinfo=tz, fold=fold).astimezone(UTC) for fold in (0, 1)]
    real = sorted(
        {c for c in candidates if c.astimezone(tz).replace(tzinfo=None) == naive},
    )
    if real:
        return real
    # Nonexistent: find the first instant whose local time is at or after `naive`.
    lo, hi = min(candidates), max(candidates)
    while hi - lo > timedelta(seconds=1):
        mid = lo + (hi - lo) / 2
        if mid.astimezone(tz).replace(tzinfo=None) >= naive:
            hi = mid
        else:
            lo = mid
    return [hi.replace(microsecond=0)]


def next_boundary(now: datetime, week_minutes: Iterable[int], tz: tzinfo) -> datetime | None:
    """The first UTC instant strictly after ``now`` at which a boundary occurs."""
    by_day: dict[int, set[int]] = {}
    for wm in week_minutes:
        by_day.setdefault(wm // MINUTES_PER_DAY, set()).add(wm % MINUTES_PER_DAY)
    if not by_day:
        return None
    today = now.astimezone(tz).date()
    best: datetime | None = None
    for offset in range(-1, _LOOKAHEAD_DAYS):
        day = today + timedelta(days=offset)
        for minute in by_day.get(day.weekday(), ()):
            for instant in wall_to_utc(day, minute, tz):
                if instant > now and (best is None or instant < best):
                    best = instant
        if best is not None and offset >= 1:
            # Later days can only be later (DST shifts are far less than a day).
            break
    return best
