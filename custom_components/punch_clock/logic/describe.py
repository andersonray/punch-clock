"""Plain-language messages for Home Assistant's Activity view (the logbook).

The engine adds an Activity entry for each write and each problem; see
docs/semantics.md, "Activity view and events". An entry about an entity is titled with
the entity's name, so its message starts with "Punch Clock".
"""

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .actions import DOMAIN_KEYS, domain_of
from .model import Config
from .resolver import Source

TITLE = "Punch Clock"

DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

REASONS: dict[str, str] = {
    "condition": "because conditions changed",
    "config": "because the schedule changed",
    "enabled": "because Punch Clock was turned back on",
    "startup": "when Punch Clock started",
    "available": "now that it's available",
    "core_config": "because Home Assistant's settings changed",
}
"""Why the engine wrote, as a closing phrase.

Block starts and ends ("schedule") need none, and neither does the 15-minute safety
check ("periodic"): it only finds work when a boundary was missed or coincides with it.
"""


def _num(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _on_off(value: Any) -> str:
    return "on" if value else "off"


_PHRASES: dict[str, Callable[[Any, str], str]] = {
    "state": lambda v, _: str(v),
    "hvac_mode": lambda v, _: str(v),
    "preset_mode": lambda v, _: f"preset {v}",
    "temperature": lambda v, unit: f"{_num(v)} {unit}",
    "temp_range": lambda v, unit: f"{_num(v['low'])} to {_num(v['high'])} {unit}",
    "fan_mode": lambda v, _: f"fan {v}",
    "swing_mode": lambda v, _: f"swing {v}",
    "swing_horizontal_mode": lambda v, _: f"horizontal swing {v}",
    "humidity": lambda v, _: f"humidity {_num(v)}%",
    "operation_mode": lambda v, _: f"mode {v}",
    "away_mode": lambda v, _: f"away mode {_on_off(v)}",
    "mode": lambda v, _: f"mode {v}",
    "percentage": lambda v, _: f"speed {_num(v)}%",
    "oscillating": lambda v, _: f"oscillation {_on_off(v)}",
    "direction": lambda v, _: f"direction {v}",
    "brightness_pct": lambda v, _: f"brightness {_num(v)}%",
    "color_temp_kelvin": lambda v, _: f"{_num(v)} K",
    "rgb_color": lambda v, _: "color RGB " + ", ".join(_num(c) for c in v),
    "effect": lambda v, _: f"effect {v}",
    "value": lambda v, _: _num(v),
    "option": lambda v, _: str(v),
    "position": lambda v, _: f"position {_num(v)}%",
    "tilt_position": lambda v, _: f"tilt {_num(v)}%",
    "source": lambda v, _: f"source {v}",
    "volume_level": lambda v, _: f"volume {round(v * 100)}%",
    "is_volume_muted": lambda v, _: "muted" if v else "unmuted",
}


def describe_value(key: str, value: Any, unit: str) -> str:
    """One setting as a phrase, e.g. "21 °C" or "fan low"."""
    phrase = _PHRASES.get(key)
    if phrase is not None:
        try:
            return phrase(value, unit)
        except TypeError, KeyError, ValueError:
            pass
    return f"{key.replace('_', ' ')} {value}"


def describe_settings(entity_id: str, settings: Mapping[str, Any], unit: str) -> str:
    """Settings as a list in the domain's key order, e.g. "heat, 21 °C, fan low"."""
    order = list(DOMAIN_KEYS.get(domain_of(entity_id), {}))
    keys = sorted(settings, key=lambda k: order.index(k) if k in order else len(order))
    return ", ".join(describe_value(key, settings[key], unit) for key in keys)


def _clock(minute: int, twelve_hour: bool) -> str:
    hours, minutes = divmod(minute, 60)
    if not twelve_hour:
        return f"{hours:02d}:{minutes:02d}"
    return f"{(hours - 1) % 12 + 1}:{minutes:02d} {'AM' if hours < 12 else 'PM'}"


def source_data(config: Config, source: Source, keys: Sequence[str]) -> dict[str, Any]:
    """Event data naming the block or tab default that set ``keys``.

    ``label`` is what Activity shows: the block's name, or for an unnamed block its
    day and start time.
    """
    tab = next((t for t in config.tabs if t.id == source.tab_id), None)
    block = next((b for b in config.blocks if b.id == source.block_id), None)
    tab_name = tab.name if tab is not None else None
    if source.kind == "default":
        label = f"default for {tab_name or 'a deleted tab'}"
    elif block is None:
        label = "a deleted block"
    elif block.name.strip():
        label = block.name.strip()
    else:
        when = _clock(block.start, config.settings.time_format == "12")
        label = f"unnamed block, {DAY_NAMES[block.day]} {when}"
    return {
        "kind": source.kind,
        "tab_id": source.tab_id,
        "tab": tab_name,
        "block_id": source.block_id,
        "block": block.name if block is not None else None,
        "label": label,
        "keys": list(keys),
    }


def entity_ids(target: Mapping[str, Any]) -> list[str]:
    """The entity ids a service action targets."""
    ids = target.get("entity_id")
    if isinstance(ids, str):
        return [ids]
    return [i for i in ids if isinstance(i, str)] if isinstance(ids, list) else []


def _reason(reason: str) -> str:
    phrase = REASONS.get(reason)
    return f" {phrase}" if phrase else ""


def write_message(
    entity_id: str,
    settings: Mapping[str, Any],
    unit: str,
    sources: Sequence[Mapping[str, Any]],
    reason: str,
) -> str:
    """The message of a write's entry, which Activity titles with the entity's name.

    For example "Punch Clock set heat, 21 °C (Morning warm-up) and fan low (default
    for Winter) because conditions changed". ``sources`` come from ``source_data``.
    """
    parts: list[str] = []
    covered: set[str] = set()
    for source in sources:
        keys = [k for k in source["keys"] if k in settings and k not in covered]
        if keys:
            covered.update(keys)
            values = describe_settings(entity_id, {k: settings[k] for k in keys}, unit)
            parts.append(f"{values} ({source['label']})")
    if rest := {k: v for k, v in settings.items() if k not in covered}:
        parts.insert(0, describe_settings(entity_id, rest, unit))
    return f"{TITLE} set {' and '.join(parts)}{_reason(reason)}"


def service_message(
    service: str, targets: Sequence[str], sources: Sequence[Mapping[str, Any]], reason: str
) -> str:
    """The message of a service action's entry, which is titled "Punch Clock".

    For example "called script.turn_on for Bedtime (Evening)".
    """
    message = f"called {service}"
    if targets:
        message += " for " + ", ".join(targets)
    if labels := [str(s["label"]) for s in sources]:
        message += f" ({', '.join(labels)})"
    return message + _reason(reason)


def problem_message(message: str, service: str | None = None) -> str:
    """The message of a problem's entry: titled with the entity, or "Punch Clock" for a service."""
    if service:
        return f"had a problem with {service}: {message}"
    return f"{TITLE} had a problem: {message}"
