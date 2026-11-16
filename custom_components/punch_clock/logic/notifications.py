"""Phone notifications about values Punch Clock couldn't set.

With ``settings.notify_failures`` on, the engine sends one notification for each write that
fails or has to wait for an unavailable entity, and adds an entry to Punch Clock's own Activity;
see docs/semantics.md, "Failure notifications". This module builds both. The HA layer
(``notifier.py``) sends the notification with the Companion app's ``notify.mobile_app_*``
services.
"""

from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
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
    "critical": {
        "channel": "alarm_stream",
        "priority": "high",
        "ttl": 0,
        "push": {
            "interruption-level": "critical",
            "sound": {"name": "default", "critical": 1, "volume": 1.0},
        },
    },
}
"""Companion app data for each priority.

On Android, ``importance`` sets how the notification channel alerts (high pops up on the screen,
low is silent), and ``priority: high`` with ``ttl: 0`` delivers at once even when the phone is
idle. Android fixes a channel's importance when the channel is first created, so each priority
has a channel of its own. The app's special ``alarm_stream`` channel plays the alarm sound, even
when the phone is on silent. On an iPhone, ``push.interruption-level`` does the same:
time-sensitive breaks through Focus, passive is silent, and critical (with the critical sound)
plays even on silent, once the app is allowed to send critical alerts.
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


def unavailable_problem(state: str | None) -> str:
    """The problem line for a write that waits because the entity isn't available.

    ``state`` is the entity's state, or None if the entity doesn't exist.
    """
    if state is None:
        return "It doesn't exist, so Punch Clock will set it if it appears."
    status = "It's unavailable" if state == "unavailable" else f"Its state is {state}"
    return f"{status}, so Punch Clock will set it when it's available again."


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


@dataclass(frozen=True, slots=True)
class Failure:
    """What a failure notification, and its entry in Punch Clock's Activity, say."""

    action: str
    """What Punch Clock couldn't do, e.g. "couldn't set Hall"."""
    schedule: tuple[str, ...]
    """The block or tab default behind it, and what it wanted, as sentences."""
    problems: tuple[str, ...]
    entity_id: str | None = None
    """The entity, named in Activity, where the entry isn't the entity's own."""

    @property
    def title(self) -> str:
        """The notification's title, e.g. "Punch Clock couldn't set Hall"."""
        return f"{TITLE} {self.action}"

    @property
    def message(self) -> str:
        """The notification's message: a line per schedule sentence, then per problem."""
        return "\n".join([*self.schedule, *self.problems])

    @property
    def activity(self) -> str:
        """The message of the Activity entry, which is titled "Punch Clock".

        One line, e.g. "couldn't set Hall (climate.hall). Morning warm-up (Winter tab, Mon
        06:30 to 08:00) wanted heat, 21 °C. climate.set_temperature failed: device offline."
        """
        action = self.action
        if self.entity_id and not action.endswith(self.entity_id):
            action += f" ({self.entity_id})"
        return " ".join([f"{action}.", *self.schedule, *(_sentence(p) for p in self.problems)])


def _sentence(text: str) -> str:
    return text if text.endswith((".", "!", "?")) else f"{text}."


def entity_failure(
    config: Config,
    entity_id: str,
    name: str | None,
    settings: Mapping[str, Any],
    sources: Sequence[Mapping[str, Any]],
    problems: Sequence[str],
) -> Failure:
    """A failed write to an entity.

    For example "couldn't set Hall", with "Morning warm-up (Winter tab, Mon 06:30 to 08:00)
    wanted heat, 21 °C." and problems such as "climate.set_temperature failed: device
    offline". ``settings`` are every value the write tried to set, in the schedule's unit.
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
    return Failure(f"couldn't set {name or entity_id}", tuple(lines), tuple(problems), entity_id)


def service_failure(
    config: Config,
    service: str,
    targets: Sequence[str],
    sources: Sequence[Mapping[str, Any]],
    problems: Sequence[str],
) -> Failure:
    """A failed service action.

    For example "couldn't call script.turn_on", with "Bedtime (Week tab, Sun 21:00 to
    22:00) scheduled it for Bedroom." and its problems.
    """
    suffix = f" for {', '.join(targets)}" if targets else ""
    lines = tuple(f"{_schedule(config, source)} scheduled it{suffix}." for source in sources)
    return Failure(f"couldn't call {service}", lines, tuple(problems))


def sample_notification() -> tuple[str, str]:
    """The title and message of the test notification sent from the settings."""
    return (
        f"{TITLE} test notification",
        "When Punch Clock can't set a scheduled value, it notifies you like this. The "
        "notification names the entity, the block or tab default behind the value, and what "
        "went wrong.",
    )
