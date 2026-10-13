import pytest

from logic.units import (
    convert_config,
    convert_desired,
    convert_settings,
    convert_temperature,
    convert_value,
)

from builders import act, block, config, svc, tab


def test_convert_temperature() -> None:
    assert convert_temperature(100, "°C", "°F") == pytest.approx(212)
    assert convert_temperature(70, "°F", "°C") == pytest.approx(21.111, abs=1e-3)
    assert convert_temperature(21, "°C", "°C") == 21
    with pytest.raises(ValueError, match="convert"):
        convert_temperature(1, "K", "°C")


def test_only_temperature_keys_convert() -> None:
    assert convert_value("climate.x", "temperature", 70, "°F", "°C", 1) == 21.1
    assert convert_value("climate.x", "temp_range", {"low": 68, "high": 77}, "°F", "°C", 1) == {
        "low": 20.0,
        "high": 25.0,
    }
    assert convert_value("water_heater.x", "temperature", 120, "°F", "°C", 1) == 48.9
    assert convert_value("climate.x", "humidity", 40, "°F", "°C") == 40
    assert convert_value("number.x", "value", 70, "°F", "°C") == 70
    assert convert_settings("climate.x", {"hvac_mode": "heat", "temperature": 20}, "°C", "°F") == {
        "hvac_mode": "heat",
        "temperature": 68,
    }


def test_convert_config_round_trips() -> None:
    cfg = config(
        tabs=(tab("t1", defaults=(act("climate.x", temperature=18.5),)),),
        blocks=(block("b", actions=(act("climate.x", temperature=70), svc("script.turn_on"))),),
    )
    celsius = convert_config(cfg, "°F", "°C")
    assert celsius.blocks[0].actions[0].settings == {"temperature": 21.1}  # type: ignore[union-attr]
    assert celsius.blocks[0].actions[1] == cfg.blocks[0].actions[1]
    assert celsius.tabs[0].defaults[0].settings == {"temperature": -7.5}
    back = convert_config(celsius, "°C", "°F")
    assert back.blocks[0].actions[0].settings == {"temperature": 70.0}  # type: ignore[union-attr]
    assert convert_config(cfg, "°C", "°C") is cfg


def test_convert_desired_matches_the_converted_config() -> None:
    cfg = config(
        blocks=(block("b", actions=(act("climate.x", temperature=71, hvac_mode="heat"),)),)
    )
    desired = {
        ("climate.x", "temperature"): 71,
        ("climate.x", "hvac_mode"): "heat",
        ("climate.x", "temp_range"): {"low": 68, "high": 77},
        ("service:script.turn_on", "call"): {"service": "script.turn_on"},
    }
    converted = convert_desired(desired, "°F", "°C")
    stored = convert_config(cfg, "°F", "°C").blocks[0].actions[0].settings  # type: ignore[union-attr]
    assert converted[("climate.x", "temperature")] == stored["temperature"] == 21.7
    assert converted[("climate.x", "temp_range")] == {"low": 20.0, "high": 25.0}
    assert converted[("climate.x", "hvac_mode")] == "heat"
    assert converted[("service:script.turn_on", "call")] == {"service": "script.turn_on"}
