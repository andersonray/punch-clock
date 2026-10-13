import pytest

from logic import mutations
from logic.model import ConfigError, default_config
from logic.mutations import (
    LimitError,
    NotFoundError,
    create_blocks,
    create_tab,
    delete_block,
    delete_tab,
    reorder_tabs,
    update_block,
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


def test_block_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mutations, "MAX_BLOCKS", 1)
    config = default_config()
    item = {"tab_id": config.tabs[0].id, "day": 1, "start": 60, "duration": 30}
    with pytest.raises(LimitError):
        create_blocks(config, [item, item])
