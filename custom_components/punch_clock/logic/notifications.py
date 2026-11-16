"""Phone notifications about values Punch Clock couldn't set.

With ``settings.notify_failures`` on, the engine sends one notification for each failed write;
see docs/semantics.md, "Failure notifications". This module builds the notification. The HA
layer (``notifier.py``) sends it with the Companion app's ``notify.mobile_app_*`` services.
"""

from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import Any

from .describe import DAY_NAMES, TITLE, clock, describe_settings
from .model import MINUTES_PER_DAY, Config, NotifyPriority

COLOR = "#FF9800"
"""Orange. The Android app takes hex or basic color names only, and "orange" isn't one of them."""
ICON = "mdi:alert"
GROUP = "punch_clock"
PANEL_PATH = "/punch-clock"

_CHANNEL = "Punch Clock"

PRIORITY_DATA: dict[str, dict[str, Any]] = {
    "low": {
        "channel": f"{_CHANNEL} (low priority)",
        "importance": "low",
        "push": {"interruption-level": "passive"},
    },
    "normal": {
        "channel": _CHANNEL,
        "importance": "default",
        "push": {"interruption-level": "active"},
    },
    "high": {
        "channel": f"{_CHANNEL} (high priority)",
        "importance": "high",
        "priority": "high",
        "ttl": 0,
        "push": {"interruption-level": "time-sensitive"},
    },
}
"""Companion app data for each priority.

On Android, ``importance`` sets how the notification channel alerts (high pops up on the screen,
low is silent), and ``priority: high`` with ``ttl: 0`` delivers at once even when the phone is
idle. Android fixes a channel's importance when the channel is first created, so each priority
has a channel of its own. On an iPhone, ``push.interruption-level`` does the same: time-sensitive
breaks through Focus, and passive is silent.
"""


def payload(title: str, message: str, tag: str, priority: NotifyPriority) -> dict[str, Any]:
    """The notify service data: orange, with a warning icon; tapping it opens Punch Clock.

    Notifications with the same ``tag`` replace each other, so a phone shows only the latest
    problem for each entity.
    """
    return {
        "title": title,
        "message": message,
        "data": {
            "tag": tag,
            "group": GROUP,
            "color": COLOR,
            "notification_icon": ICON,
            "clickAction": PANEL_PATH,
            "url": PANEL_PATH,
            **deepcopy(PRIORITY_DATA[priority]),
        },
    }


def _schedule(config: Config, source: Mapping[str, Any]) -> str:
    """The part of the schedule behind a value, e.g. "Warm-up (Winter tab, Mon 06:30 to 08:00)".

    ``source`` comes from ``describe.source_data``.
    """
    tab = source.get("tab") or "a deleted tab"
    if source.get("kind") == "default":
        return f"The default for {tab}"
    block_id = source.get("block_id")
    block = config.block(block_id) if isinstance(block_id, str) else None
    if block is None:
        return "A deleted block"
    twelve_hour = config.settings.time_format == "12"
    end = (block.start + block.duration) % MINUTES_PER_DAY
    when = f"{DAY_NAMES[block.day]} {clock(block.start, twelve_hour)} to {clock(end, twelve_hour)}"
    return f"{block.name.strip() or 'An unnamed block'} ({tab} tab, {when})"


def entity_failure(
    config: Config,
    entity_id: str,
    name: str | None,
    settings: Mapping[str, Any],
    sources: Sequence[Mapping[str, Any]],
    problems: Sequence[str],
) -> tuple[str, str]:
    """The title and message for a failed write to an entity.

    For example "Punch Clock couldn't set Hall", and "Morning warm-up (Winter tab, Mon
    06:30 to 08:00) wanted heat, 21 °C." followed by a line for each problem, such as
    "climate.set_temperature failed: device offline". ``settings`` are every value the write
    tried to set, in the schedule's unit.
    """
    unit = config.settings.temperature_unit
    lines: list[str] = []
    covered: set[str] = set()
    for source in sources:
        keys = [k for k in source.get("keys", ()) if k in settings and k not in covered]
        if keys:
            covered.update(keys)
            values = describe_settings(entity_id, {k: settings[k] for k in keys}, unit)
            lines.append(f"{_schedule(config, source)} wanted {values}.")
    if rest := {k: v for k, v in settings.items() if k not in covered}:
        lines.insert(0, f"The schedule wanted {describe_settings(entity_id, rest, unit)}.")
    return f"{TITLE} couldn't set {name or entity_id}", "\n".join([*lines, *problems])


def service_failure(
    config: Config,
    service: str,
    targets: Sequence[str],
    sources: Sequence[Mapping[str, Any]],
    problems: Sequence[str],
) -> tuple[str, str]:
    """The title and message for a failed service action.

    For example "Punch Clock couldn't call script.turn_on", and "Bedtime (Week tab, Sun
    21:00 to 22:00) scheduled it for Bedroom." followed by a line for each problem.
    """
    suffix = f" for {', '.join(targets)}" if targets else ""
    lines = [f"{_schedule(config, source)} scheduled it{suffix}." for source in sources]
    return f"{TITLE} couldn't call {service}", "\n".join([*lines, *problems])


def sample_notification() -> tuple[str, str]:
    """The title and message of the test notification sent from the settings."""
    return (
        f"{TITLE} test notification",
        "When Punch Clock can't set a scheduled value, it notifies you like this. The "
        "notification names the entity, the block or tab default behind the value, and what "
        "went wrong.",
    )
