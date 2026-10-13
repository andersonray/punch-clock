"""End-to-end engine behavior with real timers, state events and service calls.

Home Assistant's test time zone is US/Pacific. 2026-10-12 is a Monday (day 0),
and 14:00 UTC is 07:00 PDT.
"""

from datetime import datetime, timedelta
from typing import Any

import pytest
from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import issue_registry as ir
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed

from custom_components.punch_clock.const import DOMAIN, STORAGE_KEY_CONFIG, STORAGE_KEY_RUNTIME

from helpers import (
    block,
    condition,
    entity_action,
    setup_integration,
    stored_config,
    stored_runtime,
    tab,
)

START = datetime.fromisoformat("2026-10-12T14:00:00+00:00")  # Monday 07:00 PDT
CLIMATE = "climate.test"
CLIMATE_ATTRS = {"hvac_modes": ["off", "heat"], "min_temp": 7, "max_temp": 35, "temperature": 15}


def hm(hours: int, minutes: int = 0) -> int:
    return hours * 60 + minutes


def record(hass: HomeAssistant, *services: str) -> list[tuple[str, dict[str, Any]]]:
    """Register fake services that record (service, data) in call order."""
    calls: list[tuple[str, dict[str, Any]]] = []
    for full in services:
        domain, name = full.split(".")

        async def handler(call: ServiceCall, full: str = full) -> None:
            calls.append((full, dict(call.data)))

        hass.services.async_register(domain, name, handler)
    return calls


async def move_to(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    await hass.async_block_till_done()


@pytest.fixture(autouse=True)
def start_time(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(START)


def climate_block(**kwargs: Any) -> dict[str, Any]:
    return block(
        "b_1",
        day=0,
        start=kwargs.pop("start", hm(8)),
        duration=kwargs.pop("duration", 60),
        actions=[entity_action(CLIMATE, temperature=kwargs.pop("temperature", 22))],
        **kwargs,
    )


def temps(calls: list[tuple[str, dict[str, Any]]]) -> list[float]:
    return [data["temperature"] for service, data in calls if service == "climate.set_temperature"]


async def test_block_applies_then_default_returns(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        tabs=[tab(defaults=[entity_action(CLIMATE, temperature=18)])], blocks=[climate_block()]
    )
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    assert calls == [("climate.set_temperature", {"entity_id": CLIMATE, "temperature": 18})]

    await move_to(hass, freezer, START + timedelta(hours=1))  # 08:00
    assert temps(calls) == [18, 22]
    sensor = hass.states.get("binary_sensor.punch_clock_week_active")
    assert sensor.attributes["active_blocks"] == ["b_1"]

    await move_to(hass, freezer, START + timedelta(hours=2))  # 09:00
    assert temps(calls) == [18, 22, 18]
    assert (
        hass.states.get("binary_sensor.punch_clock_week_active").attributes["active_blocks"] == []
    )


async def test_fahrenheit_schedule_is_converted_for_a_celsius_home(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        temperature_unit="°F", blocks=[climate_block(temperature=70)]
    )
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert temps(calls) == [21.1]  # 70 °F, rounded to the default 0.1 step

    # Once the entity reports the converted value, it counts as matching (no rewrite).
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 21.1})
    await hass.services.async_call(
        "switch", "turn_off", {"entity_id": "switch.punch_clock_enabled"}, blocking=True
    )
    await hass.services.async_call(
        "switch", "turn_on", {"entity_id": "switch.punch_clock_enabled"}, blocking=True
    )
    await hass.async_block_till_done()
    assert temps(calls) == [21.1]


async def test_climate_mode_is_set_before_temperature(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "off", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[
            block(
                "b_1",
                day=0,
                start=hm(8),
                duration=60,
                actions=[entity_action(CLIMATE, temperature=21, hvac_mode="heat")],
            )
        ]
    )
    calls = record(hass, "climate.set_temperature", "climate.set_hvac_mode")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert [service for service, _ in calls] == ["climate.set_hvac_mode", "climate.set_temperature"]


async def test_manual_change_is_respected(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 22})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[climate_block(start=hm(6), duration=180)]
    )
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    assert calls == []  # the entity already had the desired value

    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 25})
    await move_to(hass, freezer, START + timedelta(minutes=30))  # safety tick re-evaluates
    assert calls == []


async def test_restart_mid_block_is_not_a_transition(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 25})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[climate_block(start=hm(6), duration=180)]
    )
    hass_storage[STORAGE_KEY_RUNTIME] = stored_runtime({f"{CLIMATE}|temperature": 22})
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    assert calls == []


async def test_change_while_down_is_applied_on_startup(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 18})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[climate_block(start=hm(6), duration=180)]
    )
    hass_storage[STORAGE_KEY_RUNTIME] = stored_runtime({f"{CLIMATE}|temperature": 18})
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    assert temps(calls) == [22]


async def test_block_condition_change(hass: HomeAssistant, hass_storage: dict[str, Any]) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass.states.async_set("input_boolean.guests", "off")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        tabs=[tab(defaults=[entity_action(CLIMATE, temperature=18)])],
        blocks=[
            climate_block(
                start=hm(6), duration=180, conditions=condition("input_boolean.guests", "is", "on")
            )
        ],
    )
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    assert temps(calls) == [18]

    hass.states.async_set("input_boolean.guests", "on")
    await hass.async_block_till_done()
    assert temps(calls) == [18, 22]


async def test_irrelevant_attribute_changes_are_ignored(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    hass.states.async_set("sensor.outside", "10", {"battery": 90})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[climate_block(start=hm(6), conditions=condition("sensor.outside", "lt", "15"))]
    )
    entry = await setup_integration(hass)
    engine = entry.runtime_data.engine
    before = engine.evaluated_at
    hass.states.async_set("sensor.outside", "10", {"battery": 80})
    await hass.async_block_till_done()
    assert engine.evaluated_at == before


async def test_tab_conditions_and_sensor(hass: HomeAssistant, hass_storage: dict[str, Any]) -> None:
    hass.states.async_set("input_boolean.vacation", "off")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        tabs=[tab(conditions=condition("input_boolean.vacation", "is", "on"))]
    )
    await setup_integration(hass)
    sensor = "binary_sensor.punch_clock_week_active"
    assert hass.states.get(sensor).state == "off"
    assert hass.states.get(sensor).attributes["conditions_met"] is False

    hass.states.async_set("input_boolean.vacation", "on")
    await hass.async_block_till_done()
    assert hass.states.get(sensor).state == "on"


async def test_master_switch(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)

    await hass.services.async_call(
        "switch", "turn_off", {"entity_id": "switch.punch_clock_enabled"}, blocking=True
    )
    await move_to(hass, freezer, START + timedelta(hours=1))  # block starts while paused
    assert calls == []

    await hass.services.async_call(
        "switch", "turn_on", {"entity_id": "switch.punch_clock_enabled"}, blocking=True
    )
    await hass.async_block_till_done()
    assert temps(calls) == [22]


async def test_tab_switch_disables_tab(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    await hass.services.async_call(
        "switch", "turn_off", {"entity_id": "switch.punch_clock_week_enabled"}, blocking=True
    )
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert calls == []


async def test_unavailable_target_is_written_when_it_returns(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "unavailable")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])
    calls = record(hass, "climate.set_temperature")
    entry = await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert calls == []
    assert entry.runtime_data.engine.status()["pending"] == [CLIMATE]

    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    await hass.async_block_till_done()
    assert temps(calls) == [22]
    assert entry.runtime_data.engine.status()["pending"] == []


async def test_pending_write_dropped_when_no_longer_desired(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "unavailable")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    await move_to(hass, freezer, START + timedelta(hours=2))  # block over before it returns
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    await hass.async_block_till_done()
    assert calls == []


async def test_service_action_fires_once_per_activation(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    action = {"type": "service", "service": "test.ping", "data": {"x": 1}}
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[block("b_1", day=0, start=hm(8), duration=60, actions=[action])]
    )
    calls = record(hass, "test.ping")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    await move_to(hass, freezer, START + timedelta(hours=1, minutes=20))  # safety tick
    assert calls == [("test.ping", {"x": 1})]
    await move_to(hass, freezer, START + timedelta(hours=2))  # block ends
    await move_to(hass, freezer, START + timedelta(days=7, hours=1))  # next week
    assert len(calls) == 2


async def test_failing_service_is_recorded(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])

    async def broken(call: ServiceCall) -> None:
        raise ValueError("device offline")

    hass.services.async_register("climate", "set_temperature", broken)
    entry = await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    errors = entry.runtime_data.engine.status()["errors"]
    assert errors[0]["entity_id"] == CLIMATE
    assert "device offline" in errors[0]["message"]


async def test_write_budget(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass.states.async_set("input_boolean.flap", "off")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        tabs=[tab(defaults=[entity_action(CLIMATE, temperature=18)])],
        blocks=[
            climate_block(
                start=hm(6), duration=180, conditions=condition("input_boolean.flap", "is", "on")
            )
        ],
        debounce_seconds=0,
    )
    calls = record(hass, "climate.set_temperature")
    entry = await setup_integration(hass)
    for i in range(10):
        hass.states.async_set("input_boolean.flap", "on" if i % 2 == 0 else "off")
        await hass.async_block_till_done()
        # Let the debounce cooldown expire so the next change is evaluated on its own.
        await move_to(hass, freezer, dt_util.utcnow() + timedelta(seconds=1))
    assert len(temps(calls)) == 6
    status = entry.runtime_data.engine.status()
    assert [s["entity_id"] for s in status["suppressed"]] == [CLIMATE]
    assert ir.async_get(hass).async_get_issue(DOMAIN, f"write_budget_{CLIMATE.replace('.', '_')}")


async def test_reapply(
    hass: HomeAssistant, hass_storage: dict[str, Any], hass_ws_client: Any
) -> None:
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 22})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[climate_block(start=hm(6), duration=180)]
    )
    calls = record(hass, "climate.set_temperature")
    await setup_integration(hass)
    hass.states.async_set(CLIMATE, "heat", {**CLIMATE_ATTRS, "temperature": 25})
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "punch_clock/reapply"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert temps(calls) == [22]


async def test_next_boundary_in_status(hass: HomeAssistant, hass_storage: dict[str, Any]) -> None:
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[climate_block()])
    entry = await setup_integration(hass)
    status = entry.runtime_data.engine.status()
    assert dt_util.parse_datetime(status["next_boundary"]) == START + timedelta(hours=1)
