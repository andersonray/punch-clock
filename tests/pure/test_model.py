from typing import Any

import pytest

from logic.model import (
    MAX_CONDITION_DEPTH,
    ConfigError,
    EntityAction,
    Group,
    ServiceAction,
    default_config,
    dump_config,
    parse_block,
    parse_config,
    parse_group,
)


def block_data(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": "b_1",
        "tab_id": "t_1",
        "seq": 1,
        "day": 0,
        "start": 390,
        "duration": 120,
        "name": "Morning",
        "color": "#FF9800",
        "actions": [
            {"type": "entity", "entity_id": "climate.house", "settings": {"temperature": 70}},
            {
                "type": "service",
                "service": "script.turn_on",
                "target": {"entity_id": "script.boost"},
                "data": {"variables": {"x": 1}},
            },
        ],
        "conditions": {
            "type": "group",
            "mode": "any",
            "items": [
                {"type": "condition", "entity_id": "person.ray", "operator": "is", "value": "home"},
                {
                    "type": "group",
                    "mode": "all",
                    "items": [{"entity_id": "sensor.temp", "operator": "lt", "value": 60}],
                },
            ],
        },
    }
    data.update(overrides)
    return data


def config_data() -> dict[str, Any]:
    return {
        "revision": 5,
        "seq": 1,
        "settings": {"week_start": 0},
        "tabs": [{"id": "t_1", "name": "Week", "enabled": True}],
        "blocks": [block_data()],
    }


def test_parse_block() -> None:
    block = parse_block(block_data())
    assert block.color == "#ff9800"
    entity, service = block.actions
    assert isinstance(entity, EntityAction)
    assert entity.settings == {"temperature": 70}
    assert isinstance(service, ServiceAction)
    assert service.target == {"entity_id": ["script.boost"]}
    assert block.conditions.mode == "any"
    nested = block.conditions.items[1]
    assert isinstance(nested, Group)
    assert nested.items[0].value == "60"  # type: ignore[union-attr]
    ids = [block.conditions.id, block.conditions.items[0].id, nested.id, nested.items[0].id]
    assert len(set(ids)) == 4  # missing nested IDs are generated


def test_round_trip() -> None:
    config, problems = parse_config(config_data())
    assert problems == []
    again, _ = parse_config(dump_config(config))
    assert again == config
    assert dump_config(again) == dump_config(config)


@pytest.mark.parametrize(
    ("overrides", "path"),
    [
        ({"day": 7}, "block.day"),
        ({"start": 1440}, "block.start"),
        ({"duration": 0}, "block.duration"),
        ({"duration": 1441}, "block.duration"),
        ({"color": "red"}, "block.color"),
        ({"name": "x" * 65}, "block.name"),
        (
            {"actions": [{"entity_id": "climate.house", "settings": {"nope": 1}}]},
            "block.actions[0].settings",
        ),
        ({"actions": [{"entity_id": "Not An Entity"}]}, "block.actions[0].entity_id"),
        ({"actions": [{"type": "service", "service": "bad"}]}, "block.actions[0].service"),
        ({"conditions": {"mode": "xor"}}, "block.conditions.mode"),
        (
            {"conditions": {"items": [{"entity_id": "a.b", "operator": "gte", "value": "1"}]}},
            "block.conditions.items[0].operator",
        ),
    ],
)
def test_block_validation(overrides: dict[str, Any], path: str) -> None:
    with pytest.raises(ConfigError) as err:
        parse_block(block_data(**overrides))
    assert err.value.path == path


def test_condition_depth_limit() -> None:
    tree: dict[str, Any] = {"type": "group", "items": []}
    for _ in range(MAX_CONDITION_DEPTH):
        tree = {"type": "group", "items": [tree]}
    with pytest.raises(ConfigError, match="nested at most"):
        parse_group(tree)


def test_duplicate_nested_ids_are_replaced() -> None:
    group = parse_group(
        {
            "id": "g_same",
            "items": [
                {"id": "g_same", "entity_id": "a.b", "value": "1"},
                {"id": "c_x", "entity_id": "a.b", "value": "2"},
                {"id": "c_x", "entity_id": "a.b", "value": "3"},
            ],
        }
    )
    ids = [group.id, *(i.id for i in group.items)]
    assert len(set(ids)) == 4


def test_fresh_ids() -> None:
    group = parse_group({"id": "g_keep", "items": [{"id": "c_keep", "entity_id": "a.b"}]})
    fresh = parse_group(
        {"id": "g_keep", "items": [{"id": "c_keep", "entity_id": "a.b"}]}, fresh_ids=True
    )
    assert group.id == "g_keep"
    assert fresh.id != "g_keep"
    assert fresh.items[0].id != "c_keep"


def test_lenient_parse_drops_bad_items() -> None:
    data = config_data()
    data["blocks"].append(block_data(id="b_2", day=9))
    data["blocks"].append(block_data(id="b_3", tab_id="t_missing"))
    data["blocks"].append(block_data(id="b_1"))  # duplicate id
    data["tabs"].append({"id": "t_2"})  # no name
    config, problems = parse_config(data, strict=False)
    assert [b.id for b in config.blocks] == ["b_1"]
    assert [t.id for t in config.tabs] == ["t_1"]
    assert len(problems) == 4
    with pytest.raises(ConfigError):
        parse_config(data)


def test_seq_never_below_block_seq() -> None:
    data = config_data()
    data["seq"] = 0
    data["blocks"][0]["seq"] = 17
    assert parse_config(data)[0].seq == 17


def test_default_config_has_a_tab() -> None:
    config = default_config()
    assert len(config.tabs) == 1
    assert config.settings.week_start == 6
    empty, _ = parse_config({})
    assert len(empty.tabs) == 1
