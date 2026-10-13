"""Small builders for configs and states used across the pure tests."""

import itertools
from collections.abc import Mapping
from typing import Any

from logic.model import (
    Block,
    Condition,
    Config,
    EntityAction,
    Group,
    ServiceAction,
    Settings,
    Tab,
)
from logic.state import Lookup, StateView

_counter = itertools.count(1)


def _next() -> int:
    return next(_counter)


def cond(entity_id: str, operator: str = "is", value: str = "on", attribute: str | None = None):
    return Condition(f"c{_next()}", entity_id, attribute, operator, value)  # type: ignore[arg-type]


def all_of(*items: Condition | Group) -> Group:
    return Group(f"g{_next()}", "all", tuple(items))


def any_of(*items: Condition | Group) -> Group:
    return Group(f"g{_next()}", "any", tuple(items))


def act(entity_id: str, **settings: Any) -> EntityAction:
    return EntityAction(f"a{_next()}", entity_id, settings)


def svc(service: str, entity_id: str | None = None, **data: Any) -> ServiceAction:
    target = {"entity_id": [entity_id]} if entity_id else {}
    return ServiceAction(f"a{_next()}", service, target, data)


def tab(
    tab_id: str,
    *,
    enabled: bool = True,
    conditions: Group | None = None,
    defaults: tuple[EntityAction, ...] = (),
    name: str | None = None,
) -> Tab:
    return Tab(tab_id, name or tab_id, enabled, conditions or all_of(), defaults)


def block(
    block_id: str,
    tab_id: str = "t1",
    *,
    day: int = 0,
    start: int = 0,
    duration: int = 60,
    actions: tuple[Any, ...] = (),
    conditions: Group | None = None,
    seq: int | None = None,
) -> Block:
    return Block(
        id=block_id,
        tab_id=tab_id,
        seq=seq if seq is not None else _next(),
        day=day,
        start=start,
        duration=duration,
        name=block_id,
        color="#039be5",
        actions=actions,
        conditions=conditions or all_of(),
    )


def config(tabs: tuple[Tab, ...] = (), blocks: tuple[Block, ...] = (), **settings: Any) -> Config:
    return Config(
        revision=1,
        seq=100,
        settings=Settings(**settings),
        tabs=tabs or (tab("t1"),),
        blocks=blocks,
    )


def lookup(states: Mapping[str, str | tuple[str, Mapping[str, Any]]]) -> Lookup:
    """Build a Lookup from {entity_id: state} or {entity_id: (state, attributes)}."""
    views: dict[str, StateView] = {}
    for entity_id, value in states.items():
        if isinstance(value, tuple):
            views[entity_id] = StateView(value[0], dict(value[1]))
        else:
            views[entity_id] = StateView(value, {})
    return views.get


def hm(hours: int, minutes: int = 0) -> int:
    return hours * 60 + minutes


def wm(day: int, hours: int, minutes: int = 0) -> int:
    return day * 1440 + hm(hours, minutes)
