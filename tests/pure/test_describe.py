from dataclasses import replace
from typing import Any

import pytest

from logic.describe import (
    describe_settings,
    describe_value,
    entity_ids,
    problem_message,
    service_message,
    source_data,
    write_message,
)
from logic.resolver import Source

from builders import block, config, hm, tab


@pytest.mark.parametrize(
    ("key", "value", "expected"),
    [
        ("hvac_mode", "heat", "heat"),
        ("temperature", 21.0, "21 °C"),
        ("temperature", 21.5, "21.5 °C"),
        ("temp_range", {"low": 20, "high": 24}, "20 to 24 °C"),
        ("fan_mode", "low", "fan low"),
        ("humidity", 40, "humidity 40%"),
        ("brightness_pct", 50, "brightness 50%"),
        ("color_temp_kelvin", 2700, "2700 K"),
        ("rgb_color", [255, 0, 0], "color RGB 255, 0, 0"),
        ("oscillating", False, "oscillation off"),
        ("volume_level", 0.4, "volume 40%"),
        ("is_volume_muted", True, "muted"),
        ("position", 30, "position 30%"),
        ("option", "Away", "Away"),
        ("value", 5.0, "5"),
        ("brand_new_key", "x", "brand new key x"),
        # Malformed values (anyone can fire the event) fall back instead of raising.
        ("temp_range", 20, "temp range 20"),
        ("volume_level", "loud", "volume level loud"),
    ],
)
def test_describe_value(key: str, value: Any, expected: str) -> None:
    assert describe_value(key, value, "°C") == expected


def test_settings_follow_the_domain_key_order() -> None:
    settings = {"fan_mode": "low", "temperature": 21, "hvac_mode": "heat"}
    assert describe_settings("climate.hall", settings, "°F") == "heat, 21 °F, fan low"


def test_source_labels() -> None:
    cfg = config(
        tabs=(tab("t1", name="Winter"),),
        blocks=(
            block("b1", day=0, start=hm(7)),
            replace(block("b2", day=4, start=hm(18, 30)), name="  "),
        ),
        time_format="12",
    )
    named = source_data(cfg, Source("block", "t1", "b1"), ["temperature"])
    assert named == {
        "kind": "block",
        "tab_id": "t1",
        "tab": "Winter",
        "block_id": "b1",
        "block": "b1",
        "label": "b1",
        "keys": ["temperature"],
    }
    unnamed = source_data(cfg, Source("block", "t1", "b2"), [])
    assert unnamed["label"] == "unnamed block, Fri 6:30 PM"
    cfg24 = replace(cfg, settings=replace(cfg.settings, time_format="24"))
    assert source_data(cfg24, Source("block", "t1", "b2"), [])["label"] == (
        "unnamed block, Fri 18:30"
    )
    assert source_data(cfg, Source("default", "t1"), [])["label"] == "default for Winter"
    assert source_data(cfg, Source("block", "t1", "gone"), [])["label"] == "a deleted block"
    assert source_data(cfg, Source("default", "gone"), [])["label"] == "default for a deleted tab"


def test_write_message_one_source() -> None:
    sources = [{"label": "Morning warm-up", "keys": ["temperature", "hvac_mode"]}]
    settings = {"temperature": 21, "hvac_mode": "heat"}
    assert write_message("climate.hall", settings, "°C", sources, "schedule") == (
        "Punch Clock set heat, 21 °C (Morning warm-up)"
    )


def test_write_message_several_sources_and_a_reason() -> None:
    sources = [
        {"label": "Morning warm-up", "keys": ["hvac_mode", "temperature"]},
        {"label": "default for Winter", "keys": ["fan_mode"]},
    ]
    settings = {"hvac_mode": "heat", "temperature": 21, "fan_mode": "low"}
    assert write_message("climate.hall", settings, "°C", sources, "condition") == (
        "Punch Clock set heat, 21 °C (Morning warm-up) and fan low (default for Winter) "
        "because conditions changed"
    )


def test_write_message_without_a_source() -> None:
    assert write_message("light.desk", {"state": "off"}, "°C", [], "available") == (
        "Punch Clock set off now that it's available"
    )


def test_service_message() -> None:
    sources = [{"label": "Evening", "keys": ["call"]}]
    assert service_message("script.turn_on", ["Bedtime"], sources, "startup") == (
        "called script.turn_on for Bedtime (Evening) when Punch Clock started"
    )
    assert service_message("notify.notify", [], [], "schedule") == "called notify.notify"


def test_entity_ids() -> None:
    assert entity_ids({"entity_id": "script.a"}) == ["script.a"]
    assert entity_ids({"entity_id": ["script.a", 3]}) == ["script.a"]
    assert entity_ids({"area_id": "kitchen"}) == []


def test_problem_message() -> None:
    message = "hvac_mode skipped: 'cool' is not in the entity's hvac_modes"
    assert problem_message(message) == f"Punch Clock had a problem: {message}"
    assert problem_message("boom", "script.turn_on") == "had a problem with script.turn_on: boom"
