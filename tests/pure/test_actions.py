import json
from pathlib import Path
from typing import Any

import pytest

from logic.actions import ServiceCall, matches, plan, plan_service, validate_settings
from logic.state import StateView

_RAW = json.loads((Path(__file__).parents[1] / "fixtures" / "entities.json").read_text("utf-8"))
ENTITIES = {eid: StateView(e["state"], e["attributes"]) for eid, e in _RAW.items()}


def calls(entity_id: str, **settings: Any) -> list[tuple[str, dict[str, Any]]]:
    result = plan(entity_id, settings, ENTITIES[entity_id])
    for call in result.calls:
        assert call.target == {"entity_id": entity_id}
        assert call.domain == entity_id.split(".", maxsplit=1)[0]
    return [(c.service, c.data) for c in result.calls]


def skipped(entity_id: str, **settings: Any) -> list[str]:
    return [key for key, _ in plan(entity_id, settings, ENTITIES[entity_id]).skipped]


# --- validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("entity_id", "settings"),
    [
        ("climate.x", {"hvac_mode": "heat", "temperature": 70.5}),
        ("climate.x", {"temp_range": {"low": 66, "high": 74}}),
        ("light.x", {"state": "on", "brightness_pct": 50, "rgb_color": [255, 0, 10]}),
        ("fan.x", {"oscillating": True, "direction": "reverse"}),
        ("lock.x", {"state": "unlocked"}),
        ("cover.x", {"position": 0}),
        ("media_player.x", {"volume_level": 0.3}),
    ],
)
def test_valid_settings(entity_id: str, settings: dict[str, Any]) -> None:
    validate_settings(entity_id, settings)


@pytest.mark.parametrize(
    ("entity_id", "settings", "message"),
    [
        ("sensor.x", {"state": "on"}, "not supported"),
        ("climate.x", {"brightness": 5}, "not a setting"),
        ("climate.x", {"temperature": "warm"}, "must be a number"),
        ("climate.x", {"temperature": True}, "must be a number"),
        ("climate.x", {"temp_range": {"low": 75, "high": 70}}, "greater than"),
        ("climate.x", {"temp_range": {"low": 70}}, "'low' and 'high'"),
        ("switch.x", {"state": "maybe"}, "must be one of"),
        ("light.x", {"brightness_pct": 150}, "at most"),
        ("light.x", {"rgb_color": [1, 2]}, "three integers"),
        ("fan.x", {"oscillating": "yes"}, "true or false"),
    ],
)
def test_invalid_settings(entity_id: str, settings: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        validate_settings(entity_id, settings)


# --- climate ---------------------------------------------------------------------


def test_climate_mode_before_temperature() -> None:
    assert calls("climate.hvac", temperature=20, hvac_mode="heat", fan_mode="auto_low") == [
        ("set_hvac_mode", {"hvac_mode": "heat"}),
        ("set_temperature", {"temperature": 20}),
        ("set_fan_mode", {"fan_mode": "auto_low"}),
    ]


def test_climate_off_suppresses_everything_else() -> None:
    assert calls("climate.hvac", hvac_mode="off", temperature=20) == [
        ("set_hvac_mode", {"hvac_mode": "off"})
    ]
    assert skipped("climate.hvac", hvac_mode="off", temperature=20) == ["temperature"]


def test_climate_temperature_clamped_and_stepped() -> None:
    assert calls("climate.hvac", temperature=21.3) == [("set_temperature", {"temperature": 21.5})]
    assert calls("climate.hvac", temperature=50) == [("set_temperature", {"temperature": 35})]
    assert calls("climate.ecobee", temperature=40) == [("set_temperature", {"temperature": 45})]


def test_climate_range_vs_single() -> None:
    both = {"temperature": 70, "temp_range": {"low": 66, "high": 76}}
    # Current mode is heat_cool: the range wins.
    assert calls("climate.ecobee", **both) == [
        ("set_temperature", {"target_temp_low": 66, "target_temp_high": 76})
    ]
    # Switching to heat: the single temperature wins.
    assert calls("climate.ecobee", hvac_mode="heat", **both) == [
        ("set_hvac_mode", {"hvac_mode": "heat"}),
        ("set_temperature", {"temperature": 70}),
    ]


def test_climate_invalid_enum_skipped() -> None:
    assert calls("climate.ecobee", hvac_mode="dry", preset_mode="away") == [
        ("set_preset_mode", {"preset_mode": "away"})
    ]
    assert skipped("climate.ecobee", hvac_mode="dry") == ["hvac_mode"]


def test_climate_full_order() -> None:
    services = [
        s
        for s, _ in calls(
            "climate.hvac",
            humidity=50,
            swing_mode="1",
            fan_mode="off",
            temperature=22,
            hvac_mode="cool",
        )
    ]
    assert services == [
        "set_hvac_mode",
        "set_temperature",
        "set_fan_mode",
        "set_swing_mode",
        "set_humidity",
    ]


def test_climate_matches() -> None:
    s = ENTITIES["climate.hvac"]
    assert matches("climate.hvac", "hvac_mode", "cool", s)
    assert matches("climate.hvac", "temperature", 21, s)
    assert matches("climate.hvac", "temperature", 21.1, s)  # rounds to step 0.5 -> 21
    assert not matches("climate.hvac", "temperature", 22, s)
    assert matches(
        "climate.ecobee", "temp_range", {"low": 68, "high": 75}, ENTITIES["climate.ecobee"]
    )
    assert matches("climate.hvac", "fan_mode", "on_high", s)


# --- lights ------------------------------------------------------------------------


def test_light_off_only_turns_off() -> None:
    assert calls("light.living_room", state="off", brightness_pct=50) == [("turn_off", {})]


def test_light_single_turn_on() -> None:
    assert calls("light.living_room", state="on", brightness_pct=40, color_temp_kelvin=9000) == [
        ("turn_on", {"brightness_pct": 40, "color_temp_kelvin": 6500})
    ]


def test_light_brightness_implies_on() -> None:
    assert calls("light.porch", brightness_pct=30) == [("turn_on", {"brightness_pct": 30})]


def test_light_kelvin_beats_rgb() -> None:
    assert calls("light.living_room", color_temp_kelvin=2700, rgb_color=[255, 0, 0]) == [
        ("turn_on", {"color_temp_kelvin": 2700})
    ]
    assert skipped("light.living_room", color_temp_kelvin=2700, rgb_color=[255, 0, 0]) == [
        "rgb_color"
    ]


def test_light_matches() -> None:
    s = ENTITIES["light.living_room"]
    assert matches("light.living_room", "brightness_pct", 71, s)  # 180/255 = 70.6%
    assert not matches("light.living_room", "brightness_pct", 40, s)
    assert matches("light.living_room", "color_temp_kelvin", 3020, s)
    assert not matches("light.living_room", "rgb_color", [255, 167, 87], s)  # in color_temp mode
    assert not matches("light.porch", "brightness_pct", 30, ENTITIES["light.porch"])


# --- other domains ---------------------------------------------------------------


def test_fan() -> None:
    assert calls("fan.ceiling", state="off", percentage=10) == [("turn_off", {})]
    assert calls("fan.ceiling", percentage=40) == [("set_percentage", {"percentage": 33})]
    assert calls("fan.ceiling", preset_mode="sleep", percentage=40) == [
        ("set_preset_mode", {"preset_mode": "sleep"})
    ]
    assert calls("fan.ceiling", state="on", percentage=100, oscillating=True) == [
        ("turn_on", {"percentage": 100}),
        ("oscillate", {"oscillating": True}),
    ]


def test_cover() -> None:
    assert calls("cover.living_room_window", position=25, tilt_position=10) == [
        ("set_cover_position", {"position": 25}),
        ("set_cover_tilt_position", {"tilt_position": 10}),
    ]
    assert calls("cover.garage_door", position=25) == [("open_cover", {})]
    assert calls("cover.garage_door", state="closed") == [("close_cover", {})]
    assert skipped("cover.garage_door", tilt_position=10) == ["tilt_position"]
    assert matches("cover.garage_door", "position", 0, ENTITIES["cover.garage_door"])


def test_media_player() -> None:
    assert calls("media_player.living_room", state="on", source="TV", volume_level=0.5) == [
        ("turn_on", {}),
        ("select_source", {"source": "TV"}),
        ("volume_set", {"volume_level": 0.5}),
    ]
    assert calls("media_player.living_room", state="off", source="TV") == [("turn_off", {})]
    assert matches("media_player.living_room", "state", "on", ENTITIES["media_player.living_room"])


def test_water_heater() -> None:
    assert calls(
        "water_heater.demo", operation_mode="electric", temperature=150, away_mode=True
    ) == [
        ("set_operation_mode", {"operation_mode": "electric"}),
        ("set_temperature", {"temperature": 140}),
        ("set_away_mode", {"away_mode": True}),
    ]
    assert matches("water_heater.demo", "away_mode", False, ENTITIES["water_heater.demo"])


def test_humidifier() -> None:
    assert calls("humidifier.dehumidifier", state="on", mode="eco", humidity=45.4) == [
        ("turn_on", {}),
        ("set_mode", {"mode": "eco"}),
        ("set_humidity", {"humidity": 45}),
    ]


def test_number_select_lock_switch() -> None:
    assert calls("input_number.setpoint", value=99) == [("set_value", {"value": 85})]
    assert calls("input_number.setpoint", value=68.4) == [("set_value", {"value": 68.5})]
    assert matches("number.volume", "value", 42, ENTITIES["number.volume"])
    assert calls("select.speed", option="ludicrous_speed") == [
        ("select_option", {"option": "ludicrous_speed"})
    ]
    assert skipped("select.speed", option="plaid") == ["option"]
    assert calls("lock.front_door", state="unlocked") == [("unlock", {})]
    assert calls("switch.decorative_lights", state="off") == [("turn_off", {})]


def test_unavailable_never_matches() -> None:
    assert not matches("switch.x", "state", "on", StateView("unavailable"))
    assert not matches("switch.x", "state", "on", None)


def test_plan_service() -> None:
    assert plan_service("script.turn_on", {"entity_id": ["script.a"]}, {"x": 1}) == ServiceCall(
        "script", "turn_on", {"x": 1}, {"entity_id": ["script.a"]}
    )
