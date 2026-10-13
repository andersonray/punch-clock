from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import pytest
from builders import block, hm, wm

from logic.timemath import (
    boundaries,
    in_window,
    next_boundary,
    segments,
    since_start,
    wall_to_utc,
    week_minute,
)

NY = ZoneInfo("America/New_York")
LONDON = ZoneInfo("Europe/London")
LORD_HOWE = ZoneInfo("Australia/Lord_Howe")


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_week_minute() -> None:
    # 2026-10-12 is a Monday.
    assert week_minute(datetime(2026, 10, 12, 0, 0)) == 0
    assert week_minute(datetime(2026, 10, 12, 6, 30)) == hm(6, 30)
    assert week_minute(datetime(2026, 10, 18, 23, 59)) == 10079


@pytest.mark.parametrize(
    ("now", "expected"),
    [
        (wm(0, 6, 29), False),
        (wm(0, 6, 30), True),
        (wm(0, 8, 29), True),
        (wm(0, 8, 30), False),
    ],
)
def test_in_window_simple(now: int, expected: bool) -> None:
    b = block("b", day=0, start=hm(6, 30), duration=120)
    assert in_window(now, b) is expected


def test_in_window_crosses_midnight() -> None:
    b = block("b", day=4, start=hm(22), duration=240)  # Fri 22:00 -> Sat 02:00
    assert in_window(wm(4, 23), b)
    assert in_window(wm(5, 1, 59), b)
    assert not in_window(wm(5, 2), b)
    assert not in_window(wm(4, 21, 59), b)


def test_in_window_wraps_sunday_to_monday() -> None:
    b = block("b", day=6, start=hm(23), duration=120)  # Sun 23:00 -> Mon 01:00
    assert in_window(wm(6, 23, 30), b)
    assert in_window(wm(0, 0, 30), b)
    assert not in_window(wm(0, 1), b)


def test_full_day_block() -> None:
    b = block("b", day=2, start=hm(6), duration=1440)
    assert in_window(wm(2, 6), b)
    assert in_window(wm(3, 5, 59), b)
    assert not in_window(wm(3, 6), b)


def test_since_start_wraps() -> None:
    assert since_start(wm(0, 0, 30), wm(6, 23)) == 90


def test_boundaries() -> None:
    blocks = [
        block("a", day=0, start=hm(6), duration=60),
        block("b", day=6, start=hm(23), duration=120),
    ]
    assert boundaries(blocks) == {wm(0, 6), wm(0, 7), wm(6, 23), wm(0, 1)}


def test_segments() -> None:
    assert segments(1, hm(8), 60) == [(1, hm(8), hm(9))]
    assert segments(1, hm(22), 240) == [(1, hm(22), 1440), (2, 0, hm(2))]
    assert segments(6, hm(22), 240) == [(6, hm(22), 1440), (0, 0, hm(2))]
    assert segments(3, 0, 1440) == [(3, 0, 1440)]


def test_wall_to_utc_normal() -> None:
    assert wall_to_utc(date(2026, 7, 1), hm(9), NY) == [utc(2026, 7, 1, 13)]


def test_wall_to_utc_spring_forward_gap() -> None:
    # 2026-03-08: 02:00 EST jumps to 03:00 EDT (07:00 UTC).
    assert wall_to_utc(date(2026, 3, 8), hm(2, 30), NY) == [utc(2026, 3, 8, 7)]


def test_wall_to_utc_fall_back_repeats() -> None:
    # 2026-11-01: 01:30 happens at 05:30 UTC (EDT) and again at 06:30 UTC (EST).
    assert wall_to_utc(date(2026, 11, 1), hm(1, 30), NY) == [
        utc(2026, 11, 1, 5, 30),
        utc(2026, 11, 1, 6, 30),
    ]


def test_wall_to_utc_half_hour_shift() -> None:
    # Lord Howe Island moves 02:00 -> 02:30 on 2026-10-04 (UTC+10:30 -> +11).
    assert wall_to_utc(date(2026, 10, 4), hm(2, 15), LORD_HOWE) == [utc(2026, 10, 3, 15, 30)]


def test_wall_to_utc_london() -> None:
    # 2026-03-29: 01:00 GMT -> 02:00 BST.
    assert wall_to_utc(date(2026, 3, 29), hm(1, 30), LONDON) == [utc(2026, 3, 29, 1)]


def test_next_boundary_basic() -> None:
    now = utc(2026, 7, 6, 13)  # Monday 09:00 EDT
    bounds = {wm(0, 9, 30), wm(0, 10)}
    assert next_boundary(now, bounds, NY) == utc(2026, 7, 6, 13, 30)


def test_next_boundary_strictly_after_now() -> None:
    now = utc(2026, 7, 6, 13, 30)  # exactly at Monday 09:30 EDT
    bounds = {wm(0, 9, 30), wm(0, 10)}
    assert next_boundary(now, bounds, NY) == utc(2026, 7, 6, 14)


def test_next_boundary_wraps_to_next_week() -> None:
    now = utc(2026, 7, 6, 15)  # Monday 11:00 EDT
    bounds = {wm(0, 9, 30)}
    assert next_boundary(now, bounds, NY) == utc(2026, 7, 13, 13, 30)


def test_next_boundary_none() -> None:
    assert next_boundary(utc(2026, 7, 6), set(), NY) is None


def test_next_boundary_dst_gap() -> None:
    now = utc(2026, 3, 8, 6)  # Sunday 01:00 EST
    bounds = {wm(6, 2, 30)}
    assert next_boundary(now, bounds, NY) == utc(2026, 3, 8, 7)


def test_next_boundary_fall_back_fires_twice() -> None:
    bounds = {wm(6, 1, 30)}
    first = next_boundary(utc(2026, 11, 1, 5), bounds, NY)
    assert first == utc(2026, 11, 1, 5, 30)
    assert next_boundary(first, bounds, NY) == utc(2026, 11, 1, 6, 30)
