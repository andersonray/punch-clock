"""Temperature unit conversion for scheduled values.

Schedules store temperatures in the unit chosen in Punch Clock's settings
(``Settings.temperature_unit``). Entities report and accept temperatures in Home
Assistant's unit, so values are converted on the way out (see the engine), and
every stored temperature is converted when the schedule's unit changes.
"""

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from .actions import domain_of
from .model import CELSIUS, FAHRENHEIT, Action, Block, Config, EntityAction, Tab
from .resolver import Key

TEMPERATURE_KEYS: dict[str, frozenset[str]] = {
    "climate": frozenset({"temperature", "temp_range"}),
    "water_heater": frozenset({"temperature"}),
}

STORED_DIGITS = 1
"""Converted values are stored with one decimal (70 °F -> 21.1 °C -> 70.0 °F)."""


def convert_temperature(value: float, from_unit: str, to_unit: str) -> float:
    if from_unit == to_unit:
        return value
    if (from_unit, to_unit) == (CELSIUS, FAHRENHEIT):
        return value * 9 / 5 + 32
    if (from_unit, to_unit) == (FAHRENHEIT, CELSIUS):
        return (value - 32) * 5 / 9
    raise ValueError(f"can't convert temperatures from {from_unit} to {to_unit}")


def convert_value(
    entity_id: str,
    key: str,
    value: Any,
    from_unit: str,
    to_unit: str,
    ndigits: int | None = None,
) -> Any:
    """Convert one setting value if it's a temperature; return other values unchanged."""
    keys = TEMPERATURE_KEYS.get(domain_of(entity_id))
    if from_unit == to_unit or not keys or key not in keys:
        return value

    def convert(v: float) -> float:
        result = convert_temperature(v, from_unit, to_unit)
        return round(result, ndigits) if ndigits is not None else result

    if key == "temp_range":
        return {"low": convert(value["low"]), "high": convert(value["high"])}
    return convert(value)


def convert_settings(
    entity_id: str,
    settings: Mapping[str, Any],
    from_unit: str,
    to_unit: str,
    ndigits: int | None = None,
) -> dict[str, Any]:
    return {
        key: convert_value(entity_id, key, value, from_unit, to_unit, ndigits)
        for key, value in settings.items()
    }


def convert_config(config: Config, from_unit: str, to_unit: str) -> Config:
    """Convert every stored temperature in actions and tab defaults to another unit."""
    if from_unit == to_unit:
        return config

    def entity_action(a: EntityAction) -> EntityAction:
        settings = convert_settings(a.entity_id, a.settings, from_unit, to_unit, STORED_DIGITS)
        return replace(a, settings=settings)

    def action(a: Action) -> Action:
        return entity_action(a) if isinstance(a, EntityAction) else a

    def tab(t: Tab) -> Tab:
        return replace(t, defaults=tuple(entity_action(a) for a in t.defaults))

    def block(b: Block) -> Block:
        return replace(b, actions=tuple(action(a) for a in b.actions))

    return replace(
        config,
        tabs=tuple(tab(t) for t in config.tabs),
        blocks=tuple(block(b) for b in config.blocks),
    )


def convert_desired(desired: Mapping[Key, Any], from_unit: str, to_unit: str) -> dict[Key, Any]:
    """Convert remembered desired values exactly like ``convert_config`` converts the schedule.

    Re-resolving the converted schedule then gives the same values, so a unit change
    isn't mistaken for a transition (which would undo manual changes).
    """
    return {
        key: convert_value(key[0], key[1], value, from_unit, to_unit, STORED_DIGITS)
        for key, value in desired.items()
    }
