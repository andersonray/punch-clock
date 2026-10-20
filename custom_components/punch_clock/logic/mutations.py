"""Pure configuration edits used by the WebSocket API.

Every function returns a new Config with ``revision`` incremented, or raises
ConfigError (or a subclass) without changing anything.
"""

from collections.abc import Collection, Mapping, Sequence
from dataclasses import replace
from typing import Any

from .model import (
    MAX_BLOCKS,
    MAX_NAME_LENGTH,
    MAX_TABS,
    Block,
    Config,
    ConfigError,
    Tab,
    dump_block,
    dump_settings,
    dump_tab,
    new_id,
    parse_block,
    parse_settings,
    parse_tab,
)
from .units import convert_config


class NotFoundError(ConfigError):
    """The referenced tab or block doesn't exist."""


class LimitError(ConfigError):
    """A size limit would be exceeded."""


SETTINGS_FIELDS = frozenset(
    {"enabled", "week_start", "debounce_seconds", "temperature_unit", "time_format"}
)
TAB_FIELDS = frozenset({"name", "enabled", "conditions", "defaults"})
BLOCK_FIELDS = frozenset(
    {"tab_id", "day", "start", "duration", "name", "color", "actions", "conditions"}
)


def _check_fields(changes: Mapping[str, Any], allowed: frozenset[str], path: str) -> None:
    unknown = sorted(set(changes) - allowed)
    if unknown:
        raise ConfigError(path, f"unknown field(s): {', '.join(unknown)}")


def _bump(config: Config, **changes: Any) -> Config:
    return replace(config, revision=config.revision + 1, **changes)


def bump(config: Config) -> Config:
    """Mark an externally edited config (e.g. renamed entities) as a new revision."""
    return _bump(config)


def _tab(config: Config, tab_id: str) -> Tab:
    tab = config.tab(tab_id)
    if tab is None:
        raise NotFoundError("tab_id", f"tab '{tab_id}' not found")
    return tab


def _block(config: Config, block_id: str) -> Block:
    block = config.block(block_id)
    if block is None:
        raise NotFoundError("block_id", f"block '{block_id}' not found")
    return block


def update_settings(config: Config, changes: Mapping[str, Any]) -> Config:
    _check_fields(changes, SETTINGS_FIELDS, "changes")
    settings = parse_settings({**dump_settings(config.settings), **changes})
    # Changing the unit converts every scheduled temperature, so nothing changes meaning.
    config = convert_config(config, config.settings.temperature_unit, settings.temperature_unit)
    return _bump(config, settings=settings)


def create_tab(config: Config, data: Mapping[str, Any]) -> tuple[Config, Tab]:
    _check_fields(data, TAB_FIELDS, "tab")
    if len(config.tabs) >= MAX_TABS:
        raise LimitError("tabs", f"at most {MAX_TABS} tabs are allowed")
    tab = parse_tab(data, "tab", tab_id=new_id("t"))
    return _bump(config, tabs=(*config.tabs, tab)), tab


def update_tab(config: Config, tab_id: str, changes: Mapping[str, Any]) -> tuple[Config, Tab]:
    _check_fields(changes, TAB_FIELDS, "changes")
    old = _tab(config, tab_id)
    tab = parse_tab({**dump_tab(old), **changes}, "tab", tab_id=old.id)
    tabs = tuple(tab if t.id == tab_id else t for t in config.tabs)
    return _bump(config, tabs=tabs), tab


def delete_tab(config: Config, tab_id: str) -> Config:
    _tab(config, tab_id)
    if len(config.tabs) == 1:
        raise ConfigError("tab_id", "the last tab can't be deleted")
    return _bump(
        config,
        tabs=tuple(t for t in config.tabs if t.id != tab_id),
        blocks=tuple(b for b in config.blocks if b.tab_id != tab_id),
    )


def copy_name(name: str, taken: Collection[str]) -> str:
    """A name for a copy: "Name copy", or "Name copy 2" and so on if that's taken."""
    n = 1
    while True:
        suffix = " copy" if n == 1 else f" copy {n}"
        candidate = name[: MAX_NAME_LENGTH - len(suffix)].rstrip() + suffix
        if candidate not in taken:
            return candidate
        n += 1


def duplicate_tab(config: Config, tab_id: str) -> tuple[Config, tuple[Tab, list[Block]]]:
    """Copy a tab and all its blocks into a new tab right after it.

    The copy is turned off, so it changes nothing until it has been looked over and turned
    on. Every ID in it is new.
    """
    old = _tab(config, tab_id)
    blocks = [b for b in config.blocks if b.tab_id == tab_id]
    if len(config.tabs) >= MAX_TABS:
        raise LimitError("tabs", f"at most {MAX_TABS} tabs are allowed")
    if len(config.blocks) + len(blocks) > MAX_BLOCKS:
        raise LimitError("blocks", f"at most {MAX_BLOCKS} blocks are allowed")
    name = copy_name(old.name, {t.name for t in config.tabs})
    tab = parse_tab(
        {**dump_tab(old), "name": name, "enabled": False},
        "tab",
        tab_id=new_id("t"),
        fresh_ids=True,
    )
    seq = config.seq
    copies: list[Block] = []
    for block in blocks:
        seq += 1
        copies.append(
            parse_block(
                {**dump_block(block), "tab_id": tab.id},
                "block",
                block_id=new_id("b"),
                seq=seq,
                fresh_ids=True,
            )
        )
    at = config.tabs.index(old) + 1
    tabs = (*config.tabs[:at], tab, *config.tabs[at:])
    return _bump(config, seq=seq, tabs=tabs, blocks=(*config.blocks, *copies)), (tab, copies)


def reorder_tabs(config: Config, order: Sequence[str]) -> Config:
    by_id = {t.id: t for t in config.tabs}
    if sorted(order) != sorted(by_id):
        raise ConfigError("order", "must list every tab exactly once")
    return _bump(config, tabs=tuple(by_id[tab_id] for tab_id in order))


def create_blocks(config: Config, items: Sequence[Mapping[str, Any]]) -> tuple[Config, list[Block]]:
    """Create one or more blocks atomically. Nested IDs are always regenerated."""
    if not items:
        raise ConfigError("blocks", "must not be empty")
    if len(config.blocks) + len(items) > MAX_BLOCKS:
        raise LimitError("blocks", f"at most {MAX_BLOCKS} blocks are allowed")
    created: list[Block] = []
    seq = config.seq
    for i, item in enumerate(items):
        _check_fields(item, BLOCK_FIELDS, f"blocks[{i}]")
        seq += 1
        block = parse_block(item, f"blocks[{i}]", block_id=new_id("b"), seq=seq, fresh_ids=True)
        _tab(config, block.tab_id)
        created.append(block)
    return _bump(config, seq=seq, blocks=(*config.blocks, *created)), created


def _changed_block(config: Config, block_id: str, changes: Mapping[str, Any], path: str) -> Block:
    """The block with ``changes`` applied and validated. ``path`` prefixes error locations."""
    _check_fields(changes, BLOCK_FIELDS, f"{path}changes")
    old = _block(config, block_id)
    block = parse_block(
        {**dump_block(old), **changes}, f"{path}block", block_id=old.id, seq=old.seq
    )
    _tab(config, block.tab_id)
    return block


def update_block(config: Config, block_id: str, changes: Mapping[str, Any]) -> tuple[Config, Block]:
    block = _changed_block(config, block_id, changes, "")
    blocks = tuple(block if b.id == block_id else b for b in config.blocks)
    return _bump(config, blocks=blocks), block


def update_blocks(
    config: Config, updates: Sequence[tuple[str, Mapping[str, Any]]]
) -> tuple[Config, list[Block]]:
    """Update several blocks atomically, as one revision (used to save a block group)."""
    if not updates:
        raise ConfigError("updates", "must not be empty")
    changed: dict[str, Block] = {}
    for i, (block_id, changes) in enumerate(updates):
        if block_id in changed:
            raise ConfigError(f"updates[{i}].block_id", "is listed more than once")
        changed[block_id] = _changed_block(config, block_id, changes, f"updates[{i}].")
    blocks = tuple(changed.get(b.id, b) for b in config.blocks)
    return _bump(config, blocks=blocks), list(changed.values())


def delete_block(config: Config, block_id: str) -> Config:
    return delete_blocks(config, [block_id])


def delete_blocks(config: Config, block_ids: Sequence[str]) -> Config:
    """Delete one or more blocks atomically."""
    if not block_ids:
        raise ConfigError("block_ids", "must not be empty")
    for block_id in block_ids:
        _block(config, block_id)
    gone = set(block_ids)
    return _bump(config, blocks=tuple(b for b in config.blocks if b.id not in gone))
