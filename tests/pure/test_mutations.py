import pytest

from logic import mutations
from logic.model import Condition, ConfigError, default_config
from logic.mutations import (
    LimitError,
    NotFoundError,
    copy_name,
    create_blocks,
    create_tab,
    delete_block,
    delete_blocks,
    delete_tab,
    duplicate_tab,
    reorder_tabs,
    update_block,
    update_blocks,
    update_settings,
    update_tab,
)


def test_settings() -> None:
    config = update_settings(default_config(), {"week_start": 0})
    assert config.settings.week_start == 0
    assert config.revision == 1
    with pytest.raises(ConfigError, match="unknown field"):
        update_settings(config, {"color": "x"})
    with pytest.raises(ConfigError):
        update_settings(config, {"week_start": 7})


def test_changing_temperature_unit_converts_schedules() -> None:
    config = default_config()
    tab_id = config.tabs[0].id
    item = {
        "tab_id": tab_id,
        "day": 0,
        "start": 0,
        "duration": 60,
        "actions": [{"entity_id": "climate.x", "settings": {"temperature": 20}}],
    }
    config, _ = create_blocks(config, [item])
    config = update_settings(config, {"temperature_unit": "°F"})
    assert config.settings.temperature_unit == "°F"
    assert config.blocks[0].actions[0].settings == {"temperature": 68.0}  # type: ignore[union-attr]
    config = update_settings(config, {"time_format": "24"})
    assert config.blocks[0].actions[0].settings == {"temperature": 68.0}  # type: ignore[union-attr]
    with pytest.raises(ConfigError, match="must be one of"):
        update_settings(config, {"temperature_unit": "K"})
    with pytest.raises(ConfigError, match="must be one of"):
        update_settings(config, {"time_format": "13"})


def test_tab_lifecycle() -> None:
    config = default_config()
    first = config.tabs[0].id
    config, tab = create_tab(config, {"name": "Vacation"})
    assert tab.enabled
    assert tab.id.startswith("t_")
    config, tab = update_tab(config, tab.id, {"enabled": False, "name": " Away "})
    assert not tab.enabled
    assert tab.name == "Away"
    config = reorder_tabs(config, [tab.id, first])
    assert [t.id for t in config.tabs] == [tab.id, first]
    config = delete_tab(config, tab.id)
    assert [t.id for t in config.tabs] == [first]
    with pytest.raises(ConfigError, match="last tab"):
        delete_tab(config, first)
    with pytest.raises(NotFoundError):
        update_tab(config, "t_nope", {"name": "x"})
    with pytest.raises(ConfigError, match="every tab"):
        reorder_tabs(config, [first, first])


def test_delete_tab_deletes_its_blocks() -> None:
    config, tab = create_tab(default_config(), {"name": "Two"})
    config, _ = create_blocks(config, [{"tab_id": tab.id, "day": 0, "start": 0, "duration": 60}])
    config = delete_tab(config, tab.id)
    assert config.blocks == ()


def test_duplicate_tab_copies_it_turned_off_with_its_blocks() -> None:
    config = default_config()
    other = config.tabs[0].id
    config, tab = create_tab(
        config,
        {
            "name": "Work",
            "conditions": {
                "items": [{"entity_id": "person.ray", "operator": "is", "value": "home"}]
            },
            "defaults": [{"entity_id": "climate.x", "settings": {"temperature": 18}}],
        },
    )
    config = reorder_tabs(config, [tab.id, other])
    item = {
        "tab_id": tab.id,
        "day": 1,
        "start": 60,
        "duration": 30,
        "name": "Wake",
        "actions": [{"entity_id": "climate.x", "settings": {"temperature": 21}}],
    }
    config, originals = create_blocks(config, [item, {**item, "day": 2}, {**item, "tab_id": other}])
    revision = config.revision

    config, (copy, blocks) = duplicate_tab(config, tab.id)
    assert config.revision == revision + 1
    assert [t.id for t in config.tabs] == [tab.id, copy.id, other]
    assert (copy.name, copy.enabled) == ("Work copy", False)
    condition = copy.conditions.items[0]
    assert isinstance(condition, Condition)
    assert condition.entity_id == "person.ray"
    assert condition.id != tab.conditions.items[0].id
    assert copy.conditions.id != tab.conditions.id
    assert copy.defaults[0].settings == {"temperature": 18}
    assert copy.defaults[0].id != tab.defaults[0].id

    assert [(b.tab_id, b.day, b.name) for b in blocks] == [
        (copy.id, 1, "Wake"),
        (copy.id, 2, "Wake"),
    ]
    assert [b.seq for b in blocks] == [4, 5]
    assert config.seq == 5
    assert not {b.id for b in blocks} & {b.id for b in originals}
    assert blocks[0].actions[0].id != originals[0].actions[0].id
    assert config.blocks[:3] == tuple(originals)  # the originals are untouched

    config, (again, _) = duplicate_tab(config, tab.id)
    assert again.name == "Work copy 2"
    assert [t.id for t in config.tabs] == [tab.id, again.id, copy.id, other]
    with pytest.raises(NotFoundError):
        duplicate_tab(config, "t_nope")


def test_copy_names_are_unique_and_fit() -> None:
    assert copy_name("Work", set()) == "Work copy"
    assert copy_name("Work", {"Work copy", "Work copy 2"}) == "Work copy 3"
    long = "x" * 64
    assert copy_name(long, set()) == "x" * 59 + " copy"
    assert copy_name(long, {"x" * 59 + " copy"}) == "x" * 57 + " copy 2"


def test_duplicate_tab_limits(monkeypatch: pytest.MonkeyPatch) -> None:
    config = default_config()
    config, _ = create_blocks(
        config, [{"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}]
    )
    monkeypatch.setattr(mutations, "MAX_BLOCKS", 1)
    with pytest.raises(LimitError, match="blocks"):
        duplicate_tab(config, config.tabs[0].id)
    monkeypatch.setattr(mutations, "MAX_TABS", 1)
    with pytest.raises(LimitError, match="tabs"):
        duplicate_tab(config, config.tabs[0].id)


def test_create_blocks_assigns_ids_and_seq() -> None:
    config = default_config()
    tab_id = config.tabs[0].id
    source = {
        "tab_id": tab_id,
        "day": 1,
        "start": 60,
        "duration": 30,
        "actions": [{"id": "a_keep", "entity_id": "switch.x", "settings": {"state": "on"}}],
    }
    config, blocks = create_blocks(config, [source, {**source, "day": 3}])
    assert [b.seq for b in blocks] == [1, 2]
    assert config.seq == 2
    assert blocks[0].id != blocks[1].id
    assert blocks[0].actions[0].id != "a_keep"  # nested IDs are regenerated
    assert blocks[0].actions[0].id != blocks[1].actions[0].id


def test_create_blocks_is_atomic() -> None:
    config = default_config()
    tab_id = config.tabs[0].id
    good = {"tab_id": tab_id, "day": 1, "start": 60, "duration": 30}
    with pytest.raises(ConfigError):
        create_blocks(config, [good, {**good, "day": 8}])
    with pytest.raises(NotFoundError):
        create_blocks(config, [{**good, "tab_id": "t_nope"}])
    with pytest.raises(ConfigError, match="empty"):
        create_blocks(config, [])


def test_block_update_and_delete() -> None:
    config = default_config()
    config, (block,) = create_blocks(
        config, [{"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}]
    )
    config, updated = update_block(config, block.id, {"start": 61, "name": "Wake"})
    assert (updated.start, updated.name, updated.seq) == (61, "Wake", block.seq)
    with pytest.raises(ConfigError, match="unknown field"):
        update_block(config, block.id, {"seq": 99})
    config = delete_block(config, block.id)
    assert config.blocks == ()
    with pytest.raises(NotFoundError):
        delete_block(config, block.id)


def test_update_blocks_is_one_atomic_revision() -> None:
    config = default_config()
    item = {"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}
    config, (a, b, c) = create_blocks(config, [item, {**item, "day": 2}, {**item, "day": 3}])
    revision = config.revision
    config, updated = update_blocks(
        config, [(a.id, {"name": " Wake ", "start": 90}), (b.id, {"name": "Wake"})]
    )
    assert [u.id for u in updated] == [a.id, b.id]
    assert config.revision == revision + 1
    assert [(x.name, x.start) for x in config.blocks] == [("Wake", 90), ("Wake", 60), ("", 60)]
    assert config.blocks[2] == c

    # Nothing changes if any update is invalid.
    for bad in (
        [(a.id, {"name": "x"}), (b.id, {"day": 9})],
        [(a.id, {"name": "x"}), ("b_nope", {})],
        [(a.id, {"name": "x"}), (a.id, {"name": "y"})],
        [(a.id, {"seq": 1})],
        [],
    ):
        with pytest.raises(ConfigError):
            update_blocks(config, bad)


def test_delete_blocks() -> None:
    config = default_config()
    item = {"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}
    config, (a, b, c) = create_blocks(config, [item, item, item])
    with pytest.raises(NotFoundError):
        delete_blocks(config, [a.id, "b_nope"])
    with pytest.raises(ConfigError, match="empty"):
        delete_blocks(config, [])
    config = delete_blocks(config, [a.id, c.id])
    assert config.blocks == (b,)


def test_block_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mutations, "MAX_BLOCKS", 1)
    config = default_config()
    item = {"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}
    with pytest.raises(LimitError):
        create_blocks(config, [item, item])
