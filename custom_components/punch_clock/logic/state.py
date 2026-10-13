"""A minimal, Home Assistant independent view of an entity's state."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

UNAVAILABLE = "unavailable"
UNKNOWN = "unknown"
SPECIAL_STATES = frozenset({UNAVAILABLE, UNKNOWN})


@dataclass(frozen=True, slots=True)
class StateView:
    """The parts of a Home Assistant State that the logic needs."""

    state: str
    attributes: Mapping[str, Any] = field(default_factory=dict)

    @property
    def available(self) -> bool:
        return self.state not in SPECIAL_STATES


type Lookup = Callable[[str], StateView | None]
"""Return the current state of an entity, or None if it doesn't exist."""
