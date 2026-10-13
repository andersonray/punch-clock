"""Decide which desired values to write. See docs/semantics.md, "Writing (transitions)"."""

from collections.abc import Callable, Mapping
from enum import StrEnum
from typing import Any

from .resolver import Key, is_service_key

type MatchFn = Callable[[Key, Any], bool]
"""True if the entity's current state already satisfies the desired value for the key."""


class Mode(StrEnum):
    NORMAL = "normal"
    STARTUP = "startup"
    REENABLE = "reenable"


def plan_writes(
    desired: Mapping[Key, Any],
    last: Mapping[Key, Any],
    matches: MatchFn,
    mode: Mode,
) -> dict[str, dict[str, Any]]:
    """Return {entity_or_service_key: {setting: value}} to write.

    ``last`` is the desired state Punch Clock last acted on. Service keys never
    match the current state, so they are written whenever they transition.
    """
    writes: dict[str, dict[str, Any]] = {}

    def add(key: Key, value: Any) -> None:
        writes.setdefault(key[0], {})[key[1]] = value

    def changed(key: Key, value: Any) -> bool:
        return key not in last or last[key] != value

    match mode:
        case Mode.NORMAL:
            transitioning = {key for key, value in desired.items() if changed(key, value)}
            entities = {key[0] for key in transitioning}
            for key, value in desired.items():
                if key[0] in entities and (key in transitioning or not matches(key, value)):
                    add(key, value)
        case Mode.STARTUP:
            for key, value in desired.items():
                if changed(key, value) and not matches(key, value):
                    add(key, value)
        case Mode.REENABLE:
            for key, value in desired.items():
                if is_service_key(key):
                    if changed(key, value):
                        add(key, value)
                elif not matches(key, value):
                    add(key, value)
    return writes
