"""Desired-state resolution. See docs/semantics.md, "Activity" and "Desired state"."""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .conditions import evaluate
from .model import Action, Block, Config, EntityAction, ServiceAction
from .state import Lookup
from .timemath import in_window, since_start

type Key = tuple[str, str]
"""(entity_id, setting key); for service actions (SERVICE_PREFIX + service|target, "call")."""

SERVICE_PREFIX = "service:"
SERVICE_SETTING = "call"


def is_service_key(key: Key) -> bool:
    return key[0].startswith(SERVICE_PREFIX)


def key_to_str(key: Key) -> str:
    return f"{key[0]}|{key[1]}"


def key_from_str(text: str) -> Key:
    entity, _, setting = text.rpartition("|")
    return entity, setting


def service_key(action: ServiceAction) -> Key:
    target = json.dumps(action.target, sort_keys=True, separators=(",", ":"))
    return f"{SERVICE_PREFIX}{action.service}|{target}", SERVICE_SETTING


@dataclass(frozen=True, slots=True)
class Source:
    kind: Literal["block", "default"]
    tab_id: str
    block_id: str | None = None


@dataclass(frozen=True, slots=True)
class Desired:
    value: Any
    source: Source


@dataclass(frozen=True, slots=True)
class TabState:
    enabled: bool
    conditions_met: bool

    @property
    def active(self) -> bool:
        return self.enabled and self.conditions_met


@dataclass(frozen=True, slots=True)
class BlockState:
    in_window: bool
    conditions_met: bool
    active: bool


@dataclass(slots=True)
class Resolution:
    tabs: dict[str, TabState] = field(default_factory=dict)
    blocks: dict[str, BlockState] = field(default_factory=dict)
    desired: dict[Key, Desired] = field(default_factory=dict)

    def values(self) -> dict[Key, Any]:
        return {key: d.value for key, d in self.desired.items()}


def action_values(action: Action, block_id: str | None) -> dict[Key, Any]:
    """The desired values one action contributes, keyed by setting key."""
    if isinstance(action, EntityAction):
        return {(action.entity_id, k): v for k, v in action.settings.items()}
    return {
        service_key(action): {
            "block": block_id,
            "service": action.service,
            "target": dict(action.target),
            "data": dict(action.data),
        }
    }


def block_values(block: Block) -> dict[Key, Any]:
    """All values a block sets; a later action overrides an earlier one."""
    values: dict[Key, Any] = {}
    for action in block.actions:
        values.update(action_values(action, block.id))
    return values


def resolve(config: Config, wm: int, lookup: Lookup) -> Resolution:
    """Compute tab/block activity and the desired value of every setting key at ``wm``."""
    result = Resolution()
    tab_rank = {tab.id: i for i, tab in enumerate(config.tabs)}
    for tab in config.tabs:
        result.tabs[tab.id] = TabState(tab.enabled, evaluate(tab.conditions, lookup))

    # (rank, value, source) per key; the smallest rank wins.
    best: dict[Key, tuple[tuple[int, int, int, int], Any, Source]] = {}
    for block in config.blocks:
        tab_state = result.tabs.get(block.tab_id)
        if tab_state is None:
            continue
        # Conditions are evaluated for every block, so the panel can show which blocks
        # wouldn't run right now even outside their time window.
        window = in_window(wm, block)
        met = evaluate(block.conditions, lookup)
        active = window and met and tab_state.active
        result.blocks[block.id] = BlockState(in_window=window, conditions_met=met, active=active)
        if not active:
            continue
        rank = (
            tab_rank[block.tab_id],
            since_start(wm, block.week_start),  # most recently started first
            block.duration,  # then the shorter block
            -block.seq,  # then the newer block
        )
        source = Source("block", block.tab_id, block.id)
        for key, value in block_values(block).items():
            current = best.get(key)
            if current is None or rank < current[0]:
                best[key] = (rank, value, source)

    for key, (_, value, source) in best.items():
        result.desired[key] = Desired(value, source)

    for tab in config.tabs:
        if not result.tabs[tab.id].active:
            continue
        for action in tab.defaults:
            for key, value in action_values(action, None).items():
                if key not in result.desired:
                    result.desired[key] = Desired(value, Source("default", tab.id))
    return result


def controlled_entities(config: Config) -> set[str]:
    """Entities that any block action or tab default sets."""
    entities: set[str] = set()
    for tab in config.tabs:
        entities.update(a.entity_id for a in tab.defaults)
    for block in config.blocks:
        entities.update(a.entity_id for a in block.actions if isinstance(a, EntityAction))
    return entities


def entity_settings(values: Mapping[Key, Any]) -> dict[str, dict[str, Any]]:
    """Group desired values by entity: {entity_id: {setting: value}}."""
    grouped: dict[str, dict[str, Any]] = {}
    for (entity, setting), value in values.items():
        grouped.setdefault(entity, {})[setting] = value
    return grouped
