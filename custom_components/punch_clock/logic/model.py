"""Configuration model: immutable dataclasses plus parsing (validation) and dumping.

Everything that comes in from storage or the WebSocket API goes through the
``parse_*`` functions, which raise ``ConfigError`` with a path to the bad value.
"""

import math
import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from .actions import validate_settings

MINUTES_PER_DAY = 1440
DAYS_PER_WEEK = 7
MINUTES_PER_WEEK = MINUTES_PER_DAY * DAYS_PER_WEEK

MAX_TABS = 20
MAX_BLOCKS = 2000
MAX_ACTIONS = 50
MAX_CONDITION_DEPTH = 6
MAX_CONDITION_NODES = 100
MAX_NAME_LENGTH = 64
MAX_VALUE_LENGTH = 255

DEFAULT_WEEK_START = 6  # Sunday (0 = Monday)
DEFAULT_DEBOUNCE_SECONDS = 2.0
DEFAULT_COLOR = "#039be5"

type Operator = Literal["is", "is_not", "gt", "lt"]
type GroupMode = Literal["all", "any"]
OPERATORS: tuple[str, ...] = ("is", "is_not", "gt", "lt")
GROUP_MODES: tuple[str, ...] = ("all", "any")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_ENTITY_ID_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_SERVICE_RE = re.compile(r"^[a-z0-9_]+\.[a-z0-9_]+$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
_TARGET_KEYS = frozenset({"entity_id", "device_id", "area_id", "floor_id", "label_id"})


class ConfigError(ValueError):
    """Invalid configuration data. ``path`` points at the offending value."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.path = path
        self.message = message


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Condition:
    id: str
    entity_id: str
    attribute: str | None
    operator: Operator
    value: str


@dataclass(frozen=True, slots=True)
class Group:
    id: str
    mode: GroupMode = "all"
    items: tuple[Condition | Group, ...] = ()


@dataclass(frozen=True, slots=True)
class EntityAction:
    id: str
    entity_id: str
    settings: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class ServiceAction:
    id: str
    service: str
    target: Mapping[str, Any]
    data: Mapping[str, Any]


type Action = EntityAction | ServiceAction


@dataclass(frozen=True, slots=True)
class Tab:
    id: str
    name: str
    enabled: bool
    conditions: Group
    defaults: tuple[EntityAction, ...]


@dataclass(frozen=True, slots=True)
class Block:
    id: str
    tab_id: str
    seq: int
    day: int
    start: int
    duration: int
    name: str
    color: str
    actions: tuple[Action, ...]
    conditions: Group

    @property
    def week_start(self) -> int:
        """Minute of the week (Monday 00:00 = 0) at which the block starts."""
        return self.day * MINUTES_PER_DAY + self.start


@dataclass(frozen=True, slots=True)
class Settings:
    enabled: bool = True
    week_start: int = DEFAULT_WEEK_START
    debounce_seconds: float = DEFAULT_DEBOUNCE_SECONDS
    temperature_unit: str | None = None


@dataclass(frozen=True, slots=True)
class Config:
    revision: int
    seq: int
    settings: Settings
    tabs: tuple[Tab, ...]
    blocks: tuple[Block, ...]

    def tab(self, tab_id: str) -> Tab | None:
        return next((t for t in self.tabs if t.id == tab_id), None)

    def block(self, block_id: str) -> Block | None:
        return next((b for b in self.blocks if b.id == block_id), None)


def empty_group() -> Group:
    return Group(id=new_id("g"))


def default_config() -> Config:
    tab = Tab(id=new_id("t"), name="Schedule", enabled=True, conditions=empty_group(), defaults=())
    return Config(revision=0, seq=0, settings=Settings(), tabs=(tab,), blocks=())


# ---------------------------------------------------------------------------
# Field readers
# ---------------------------------------------------------------------------

_MISSING: Any = object()


def _mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConfigError(path, "must be an object")
    return cast(Mapping[str, Any], value)


def _sequence(value: Any, path: str) -> Sequence[Any]:
    if not isinstance(value, list | tuple):
        raise ConfigError(path, "must be a list")
    return value


def _str(
    m: Mapping[str, Any],
    key: str,
    path: str,
    *,
    default: Any = _MISSING,
    max_length: int = MAX_NAME_LENGTH,
    pattern: re.Pattern[str] | None = None,
    allow_empty: bool = False,
) -> str:
    value = m.get(key, default)
    if value is _MISSING:
        raise ConfigError(f"{path}.{key}", "is required")
    if not isinstance(value, str):
        raise ConfigError(f"{path}.{key}", "must be a string")
    if not allow_empty and not value.strip():
        raise ConfigError(f"{path}.{key}", "must not be empty")
    if len(value) > max_length:
        raise ConfigError(f"{path}.{key}", f"must be at most {max_length} characters")
    if pattern is not None and not pattern.match(value):
        raise ConfigError(f"{path}.{key}", "has an invalid format")
    return value


def _int(
    m: Mapping[str, Any], key: str, path: str, lo: int, hi: int, *, default: Any = _MISSING
) -> int:
    value = m.get(key, default)
    if value is _MISSING:
        raise ConfigError(f"{path}.{key}", "is required")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ConfigError(f"{path}.{key}", "must be an integer")
    if not lo <= value <= hi:
        raise ConfigError(f"{path}.{key}", f"must be between {lo} and {hi}")
    return value


def _float(
    m: Mapping[str, Any], key: str, path: str, lo: float, hi: float, *, default: Any = _MISSING
) -> float:
    value = m.get(key, default)
    if value is _MISSING:
        raise ConfigError(f"{path}.{key}", "is required")
    if not isinstance(value, int | float) or isinstance(value, bool) or not math.isfinite(value):
        raise ConfigError(f"{path}.{key}", "must be a number")
    if not lo <= value <= hi:
        raise ConfigError(f"{path}.{key}", f"must be between {lo} and {hi}")
    return float(value)


def _bool(m: Mapping[str, Any], key: str, path: str, *, default: Any = _MISSING) -> bool:
    value = m.get(key, default)
    if value is _MISSING:
        raise ConfigError(f"{path}.{key}", "is required")
    if not isinstance(value, bool):
        raise ConfigError(f"{path}.{key}", "must be true or false")
    return value


class _Ids:
    """Hands out IDs for nested objects, replacing missing, invalid or repeated ones."""

    def __init__(self, *, fresh: bool = False) -> None:
        self._seen: set[str] = set()
        self._fresh = fresh

    def take(self, m: Mapping[str, Any], prefix: str) -> str:
        value = m.get("id")
        if (
            self._fresh
            or not isinstance(value, str)
            or not _ID_RE.match(value)
            or value in self._seen
        ):
            value = new_id(prefix)
        self._seen.add(value)
        return value


# ---------------------------------------------------------------------------
# Conditions
# ---------------------------------------------------------------------------


def _condition_value(value: Any, path: str) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float) and math.isfinite(value):
        return str(value)
    if isinstance(value, str):
        if len(value) > MAX_VALUE_LENGTH:
            raise ConfigError(path, f"must be at most {MAX_VALUE_LENGTH} characters")
        return value
    raise ConfigError(path, "must be a string or number")


def parse_group(data: Any, path: str = "conditions", *, fresh_ids: bool = False) -> Group:
    """Parse a condition tree. Missing/None means an empty (always true) group."""
    if data is None:
        return empty_group()
    nodes = [0]
    return _parse_group(data, path, 1, _Ids(fresh=fresh_ids), nodes)


def _parse_group(data: Any, path: str, depth: int, ids: _Ids, nodes: list[int]) -> Group:
    if depth > MAX_CONDITION_DEPTH:
        raise ConfigError(path, f"conditions may be nested at most {MAX_CONDITION_DEPTH} deep")
    m = _mapping(data, path)
    mode = m.get("mode", "all")
    if mode not in GROUP_MODES:
        raise ConfigError(f"{path}.mode", "must be 'all' or 'any'")
    items: list[Condition | Group] = []
    for i, item in enumerate(_sequence(m.get("items", []), f"{path}.items")):
        nodes[0] += 1
        if nodes[0] > MAX_CONDITION_NODES:
            raise ConfigError(path, f"at most {MAX_CONDITION_NODES} conditions are allowed")
        item_path = f"{path}.items[{i}]"
        item_m = _mapping(item, item_path)
        if item_m.get("type") == "group":
            items.append(_parse_group(item_m, item_path, depth + 1, ids, nodes))
        else:
            items.append(_parse_condition(item_m, item_path, ids))
    return Group(id=ids.take(m, "g"), mode=cast(GroupMode, mode), items=tuple(items))


def _parse_condition(m: Mapping[str, Any], path: str, ids: _Ids) -> Condition:
    if m.get("type", "condition") != "condition":
        raise ConfigError(f"{path}.type", "must be 'condition' or 'group'")
    entity_id = _str(m, "entity_id", path, max_length=255, pattern=_ENTITY_ID_RE)
    attribute = m.get("attribute")
    if attribute is not None:
        attribute = _str(m, "attribute", path, max_length=255) if attribute != "" else None
    operator = m.get("operator", "is")
    if operator not in OPERATORS:
        raise ConfigError(f"{path}.operator", f"must be one of {list(OPERATORS)}")
    value = _condition_value(m.get("value", ""), f"{path}.value")
    return Condition(
        id=ids.take(m, "c"),
        entity_id=entity_id,
        attribute=attribute,
        operator=cast(Operator, operator),
        value=value,
    )


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


def _json_value(value: Any, path: str, depth: int = 0) -> Any:
    """Check that a value is plain JSON (no NaN, bounded nesting) and return a copy."""
    if depth > 10:
        raise ConfigError(path, "is nested too deeply")
    if value is None or isinstance(value, bool | str | int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ConfigError(path, "must be a finite number")
        return value
    if isinstance(value, list | tuple):
        return [_json_value(v, f"{path}[{i}]", depth + 1) for i, v in enumerate(value)]
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise ConfigError(path, "object keys must be strings")
            result[k] = _json_value(v, f"{path}.{k}", depth + 1)
        return result
    raise ConfigError(path, "must be JSON data")


def parse_entity_action(data: Any, path: str, ids: _Ids | None = None) -> EntityAction:
    ids = ids or _Ids()
    m = _mapping(data, path)
    entity_id = _str(m, "entity_id", path, max_length=255, pattern=_ENTITY_ID_RE)
    settings = _json_value(_mapping(m.get("settings", {}), f"{path}.settings"), f"{path}.settings")
    try:
        validate_settings(entity_id, settings)
    except ValueError as err:
        raise ConfigError(f"{path}.settings", str(err)) from err
    return EntityAction(id=ids.take(m, "a"), entity_id=entity_id, settings=settings)


def _parse_target(data: Any, path: str) -> dict[str, Any]:
    m = _mapping(data, path)
    target: dict[str, Any] = {}
    for key, value in m.items():
        if key not in _TARGET_KEYS:
            raise ConfigError(f"{path}.{key}", f"must be one of {sorted(_TARGET_KEYS)}")
        values = [value] if isinstance(value, str) else value
        if not isinstance(values, list | tuple) or not all(
            isinstance(v, str) and v for v in values
        ):
            raise ConfigError(f"{path}.{key}", "must be a string or a list of strings")
        if key == "entity_id" and not all(_ENTITY_ID_RE.match(v) for v in values):
            raise ConfigError(f"{path}.{key}", "contains an invalid entity ID")
        target[key] = list(values)
    return target


def parse_service_action(data: Any, path: str, ids: _Ids | None = None) -> ServiceAction:
    ids = ids or _Ids()
    m = _mapping(data, path)
    service = _str(m, "service", path, max_length=255, pattern=_SERVICE_RE)
    target = _parse_target(m.get("target", {}), f"{path}.target")
    raw_data = _mapping(m.get("data", {}), f"{path}.data")
    return ServiceAction(
        id=ids.take(m, "a"),
        service=service,
        target=target,
        data=_json_value(raw_data, f"{path}.data"),
    )


def parse_action(data: Any, path: str, ids: _Ids | None = None) -> Action:
    m = _mapping(data, path)
    kind = m.get("type", "entity")
    if kind == "entity":
        return parse_entity_action(m, path, ids)
    if kind == "service":
        return parse_service_action(m, path, ids)
    raise ConfigError(f"{path}.type", "must be 'entity' or 'service'")


def _parse_actions(
    data: Any, path: str, *, fresh_ids: bool, entity_only: bool = False
) -> tuple[Action, ...]:
    items = _sequence(data if data is not None else [], path)
    if len(items) > MAX_ACTIONS:
        raise ConfigError(path, f"at most {MAX_ACTIONS} actions are allowed")
    ids = _Ids(fresh=fresh_ids)
    if entity_only:
        return tuple(parse_entity_action(a, f"{path}[{i}]", ids) for i, a in enumerate(items))
    return tuple(parse_action(a, f"{path}[{i}]", ids) for i, a in enumerate(items))


# ---------------------------------------------------------------------------
# Tabs, blocks, settings, config
# ---------------------------------------------------------------------------


def parse_tab(data: Any, path: str = "tab", *, tab_id: str | None = None) -> Tab:
    m = _mapping(data, path)
    return Tab(
        id=tab_id or _str(m, "id", path, pattern=_ID_RE),
        name=_str(m, "name", path).strip(),
        enabled=_bool(m, "enabled", path, default=True),
        conditions=parse_group(m.get("conditions"), f"{path}.conditions"),
        defaults=cast(
            tuple[EntityAction, ...],
            _parse_actions(
                m.get("defaults"), f"{path}.defaults", fresh_ids=False, entity_only=True
            ),
        ),
    )


def parse_block(
    data: Any,
    path: str = "block",
    *,
    block_id: str | None = None,
    seq: int | None = None,
    fresh_ids: bool = False,
) -> Block:
    m = _mapping(data, path)
    color = _str(m, "color", path, default=DEFAULT_COLOR, pattern=_COLOR_RE)
    return Block(
        id=block_id or _str(m, "id", path, pattern=_ID_RE),
        tab_id=_str(m, "tab_id", path, pattern=_ID_RE),
        seq=seq if seq is not None else _int(m, "seq", path, 0, 2**31),
        day=_int(m, "day", path, 0, DAYS_PER_WEEK - 1),
        start=_int(m, "start", path, 0, MINUTES_PER_DAY - 1),
        duration=_int(m, "duration", path, 1, MINUTES_PER_DAY),
        name=_str(m, "name", path, default="", allow_empty=True).strip(),
        color=color.lower(),
        actions=_parse_actions(m.get("actions"), f"{path}.actions", fresh_ids=fresh_ids),
        conditions=parse_group(m.get("conditions"), f"{path}.conditions", fresh_ids=fresh_ids),
    )


def parse_settings(data: Any, path: str = "settings") -> Settings:
    m = _mapping(data if data is not None else {}, path)
    unit = m.get("temperature_unit")
    if unit is not None and not isinstance(unit, str):
        raise ConfigError(f"{path}.temperature_unit", "must be a string")
    return Settings(
        enabled=_bool(m, "enabled", path, default=True),
        week_start=_int(m, "week_start", path, 0, 6, default=DEFAULT_WEEK_START),
        debounce_seconds=_float(
            m, "debounce_seconds", path, 0, 60, default=DEFAULT_DEBOUNCE_SECONDS
        ),
        temperature_unit=unit,
    )


def parse_config(data: Any, *, strict: bool = True) -> tuple[Config, list[str]]:
    """Parse a stored or imported configuration.

    With ``strict=False`` invalid tabs and blocks are dropped (and reported in the
    returned list of messages) instead of failing the whole configuration.
    """
    m = _mapping(data, "")
    problems: list[str] = []

    def keep(err: ConfigError) -> None:
        if strict:
            raise err
        problems.append(str(err))

    try:
        settings = parse_settings(m.get("settings"))
    except ConfigError as err:
        keep(err)
        settings = Settings()

    tabs: list[Tab] = []
    for i, raw in enumerate(_sequence(m.get("tabs", []), "tabs")):
        try:
            tab = parse_tab(raw, f"tabs[{i}]")
        except ConfigError as err:
            keep(err)
            continue
        if any(t.id == tab.id for t in tabs):
            keep(ConfigError(f"tabs[{i}].id", "is a duplicate"))
            continue
        tabs.append(tab)
    if len(tabs) > MAX_TABS:
        keep(ConfigError("tabs", f"at most {MAX_TABS} tabs are allowed"))
        tabs = tabs[:MAX_TABS]
    if not tabs:
        tabs = list(default_config().tabs)

    tab_ids = {t.id for t in tabs}
    blocks: list[Block] = []
    block_ids: set[str] = set()
    for i, raw in enumerate(_sequence(m.get("blocks", []), "blocks")):
        try:
            block = parse_block(raw, f"blocks[{i}]")
        except ConfigError as err:
            keep(err)
            continue
        if block.tab_id not in tab_ids:
            keep(ConfigError(f"blocks[{i}].tab_id", "refers to an unknown tab"))
            continue
        if block.id in block_ids:
            keep(ConfigError(f"blocks[{i}].id", "is a duplicate"))
            continue
        block_ids.add(block.id)
        blocks.append(block)
    if len(blocks) > MAX_BLOCKS:
        keep(ConfigError("blocks", f"at most {MAX_BLOCKS} blocks are allowed"))
        blocks = blocks[:MAX_BLOCKS]

    max_seq = max((b.seq for b in blocks), default=0)
    config = Config(
        revision=_int(m, "revision", "", 0, 2**53, default=0),
        seq=max(_int(m, "seq", "", 0, 2**53, default=0), max_seq),
        settings=settings,
        tabs=tuple(tabs),
        blocks=tuple(blocks),
    )
    return config, problems


# ---------------------------------------------------------------------------
# Dumping
# ---------------------------------------------------------------------------


def dump_group(group: Group) -> dict[str, Any]:
    return {
        "type": "group",
        "id": group.id,
        "mode": group.mode,
        "items": [
            dump_group(item) if isinstance(item, Group) else dump_condition(item)
            for item in group.items
        ],
    }


def dump_condition(condition: Condition) -> dict[str, Any]:
    return {
        "type": "condition",
        "id": condition.id,
        "entity_id": condition.entity_id,
        "attribute": condition.attribute,
        "operator": condition.operator,
        "value": condition.value,
    }


def dump_action(action: Action) -> dict[str, Any]:
    if isinstance(action, EntityAction):
        return {
            "id": action.id,
            "type": "entity",
            "entity_id": action.entity_id,
            "settings": dict(action.settings),
        }
    return {
        "id": action.id,
        "type": "service",
        "service": action.service,
        "target": dict(action.target),
        "data": dict(action.data),
    }


def dump_tab(tab: Tab) -> dict[str, Any]:
    return {
        "id": tab.id,
        "name": tab.name,
        "enabled": tab.enabled,
        "conditions": dump_group(tab.conditions),
        "defaults": [dump_action(a) for a in tab.defaults],
    }


def dump_block(block: Block) -> dict[str, Any]:
    return {
        "id": block.id,
        "tab_id": block.tab_id,
        "seq": block.seq,
        "day": block.day,
        "start": block.start,
        "duration": block.duration,
        "name": block.name,
        "color": block.color,
        "actions": [dump_action(a) for a in block.actions],
        "conditions": dump_group(block.conditions),
    }


def dump_settings(settings: Settings) -> dict[str, Any]:
    return {
        "enabled": settings.enabled,
        "week_start": settings.week_start,
        "debounce_seconds": settings.debounce_seconds,
        "temperature_unit": settings.temperature_unit,
    }


def dump_config(config: Config) -> dict[str, Any]:
    return {
        "revision": config.revision,
        "seq": config.seq,
        "settings": dump_settings(config.settings),
        "tabs": [dump_tab(t) for t in config.tabs],
        "blocks": [dump_block(b) for b in config.blocks],
    }
