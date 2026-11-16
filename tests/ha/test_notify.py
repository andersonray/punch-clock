"""Phone notifications about values Punch Clock couldn't set.

Home Assistant's test time zone is US/Pacific. 2026-10-12 is a Monday (day 0),
and 14:00 UTC is 07:00 PDT.
"""

from datetime import datetime, timedelta
from typing import Any

import pytest
from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import Event, HomeAssistant, ServiceCall
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    async_capture_events,
    async_fire_time_changed,
)

from custom_components.punch_clock.const import EVENT_LOGBOOK_ENTRY, STORAGE_KEY_CONFIG

from helpers import block, condition, entity_action, setup_integration, stored_config, tab

START = datetime.fromisoformat("2026-10-12T14:00:00+00:00")  # Monday 07:00 PDT
CLIMATE = "climate.hall"
MASTER = "switch.punch_clock_enabled"
CLIMATE_ATTRS = {
    "friendly_name": "Hall",
    "hvac_modes": ["off", "heat"],
    "min_temp": 7,
    "max_temp": 35,
    "temperature": 15,
}


@pytest.fixture(autouse=True)
def start_time(freezer: FrozenDateTimeFactory) -> None:
    freezer.move_to(START)


async def move_to(hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    await hass.async_block_till_done()


def phones(hass: HomeAssistant, *names: str) -> list[tuple[str, dict[str, Any]]]:
    """Fake notify.mobile_app_<name> services that record (service, data)."""
    sent: list[tuple[str, dict[str, Any]]] = []
    for name in names:

        async def handler(call: ServiceCall, service: str = f"mobile_app_{name}") -> None:
            sent.append((service, dict(call.data)))

        hass.services.async_register("notify", f"mobile_app_{name}", handler)
    return sent


def fail(hass: HomeAssistant, domain: str, service: str) -> None:
    async def broken(call: ServiceCall) -> None:
        raise ValueError("device offline")

    hass.services.async_register(domain, service, broken)


def ok(hass: HomeAssistant, *services: str) -> None:
    async def handler(call: ServiceCall) -> None:
        return None

    for full in services:
        domain, name = full.split(".")
        hass.services.async_register(domain, name, handler)


def warm_up(settings: dict[str, Any] | None = None) -> dict[str, Any]:
    """The block "b_1", Monday 08:00 to 09:00, setting the climate entity."""
    settings = settings or {"temperature": 22}
    return block(
        "b_1", day=0, start=8 * 60, duration=60, actions=[entity_action(CLIMATE, **settings)]
    )


def failures(entries: list[Event], entity_id: str = MASTER) -> list[tuple[str, str]]:
    """(name, message) of the Activity entries on Punch Clock's master switch."""
    return [
        (e.data["name"], e.data["message"]) for e in entries if e.data.get("entity_id") == entity_id
    ]


async def test_off_by_default(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()])
    fail(hass, "climate", "set_temperature")
    sent = phones(hass, "pixel")
    entries = async_capture_events(hass, EVENT_LOGBOOK_ENTRY)
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert sent == []
    assert failures(entries) == []
    # The problem is still in the entity's own Activity, after the write, as before.
    assert failures(entries, CLIMATE) == [
        ("Hall", "Punch Clock set 22 °C (b_1)"),
        ("Hall", "Punch Clock had a problem: climate.set_temperature failed: device offline"),
    ]


async def test_failed_write_notifies_every_phone(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    fail(hass, "climate", "set_temperature")
    sent = phones(hass, "pixel", "tablet")
    entries = async_capture_events(hass, EVENT_LOGBOOK_ENTRY)
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))

    # One entry in Punch Clock's Activity, and the problem in the entity's, as before.
    assert failures(entries) == [
        (
            "Punch Clock",
            "couldn't set Hall (climate.hall). b_1 (Week tab, Mon 08:00 to 09:00) wanted 22 °C. "
            "climate.set_temperature failed: device offline.",
        )
    ]
    assert len(failures(entries, CLIMATE)) == 2  # the write, then its problem

    assert sorted(service for service, _ in sent) == ["mobile_app_pixel", "mobile_app_tablet"]
    data = sent[0][1]
    assert data["title"] == "Punch Clock couldn't set Hall"
    assert data["message"] == (
        "b_1 (Week tab, Mon 08:00 to 09:00) wanted 22 °C.\n"
        "climate.set_temperature failed: device offline"
    )
    assert data["data"]["color"] == "#FF9800"
    assert data["data"]["notification_icon"] == "mdi:alert"
    assert data["data"]["tag"] == "punch_clock_climate_hall"
    # High priority by default.
    assert data["data"]["channel"] == "Punch Clock (high priority)"
    assert data["data"]["importance"] == "high"
    assert data["data"]["priority"] == "high"
    assert data["data"]["ttl"] == 0


async def test_one_notification_per_write_to_the_chosen_phone(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "off", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        # "cool" isn't one of the entity's hvac_modes, and the temperature call fails.
        blocks=[warm_up(settings={"hvac_mode": "cool", "temperature": 22})],
        notify_failures=True,
        notify_target="mobile_app_pixel",
        notify_priority="critical",
    )
    fail(hass, "climate", "set_temperature")
    sent = phones(hass, "pixel", "tablet")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))

    assert [service for service, _ in sent] == ["mobile_app_pixel"]
    data = sent[0][1]
    assert data["message"].splitlines() == [
        "b_1 (Week tab, Mon 08:00 to 09:00) wanted cool, 22 °C.",
        "hvac_mode skipped: 'cool' is not in the entity's hvac_modes",
        "climate.set_temperature failed: device offline",
    ]
    assert data["data"]["channel"] == "alarm_stream"
    assert data["data"]["push"]["interruption-level"] == "critical"


async def test_value_the_entity_doesnt_offer(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "off", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[warm_up(settings={"hvac_mode": "cool"})], notify_failures=True
    )
    sent = phones(hass, "pixel")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert [data["message"] for _, data in sent] == [
        "b_1 (Week tab, Mon 08:00 to 09:00) wanted cool.\n"
        "hvac_mode skipped: 'cool' is not in the entity's hvac_modes"
    ]


async def test_successful_write_doesnt_notify(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    ok(hass, "climate.set_temperature")
    sent = phones(hass, "pixel")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert sent == []


async def test_unavailable_entity_notifies_right_away(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "unavailable", {"friendly_name": "Hall"})
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    ok(hass, "climate.set_temperature")
    sent = phones(hass, "pixel")
    entries = async_capture_events(hass, EVENT_LOGBOOK_ENTRY)
    entry = await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert [(data["title"], data["message"]) for _, data in sent] == [
        (
            "Punch Clock couldn't set Hall",
            "b_1 (Week tab, Mon 08:00 to 09:00) wanted 22 °C.\n"
            "It's unavailable, so Punch Clock will set it when it's available again.",
        )
    ]
    assert failures(entries) == [
        (
            "Punch Clock",
            "couldn't set Hall (climate.hall). b_1 (Week tab, Mon 08:00 to 09:00) wanted 22 °C. "
            "It's unavailable, so Punch Clock will set it when it's available again.",
        )
    ]
    # The write still waits for the entity, and is made without another notification.
    assert entry.runtime_data.engine.status()["pending"] == [CLIMATE]
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    await hass.async_block_till_done()
    assert entry.runtime_data.engine.status()["pending"] == []
    assert len(sent) == 1
    assert len(failures(entries)) == 1


async def test_missing_entity_notifies(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    sent = phones(hass, "pixel")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert [(data["title"], data["message"].splitlines()[-1]) for _, data in sent] == [
        (
            "Punch Clock couldn't set climate.hall",
            "It doesn't exist, so Punch Clock will set it if it appears.",
        )
    ]


async def test_paused_writes_notify_once(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass.states.async_set("input_boolean.flap", "off")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        tabs=[tab(defaults=[entity_action(CLIMATE, temperature=18)])],
        blocks=[
            block(
                "b_1",
                day=0,
                start=6 * 60,
                duration=180,
                actions=[entity_action(CLIMATE, temperature=22)],
                conditions=condition("input_boolean.flap", "is", "on"),
            )
        ],
        debounce_seconds=0,
        notify_failures=True,
    )
    ok(hass, "climate.set_temperature")
    sent = phones(hass, "pixel")
    await setup_integration(hass)
    for i in range(10):
        hass.states.async_set("input_boolean.flap", "on" if i % 2 == 0 else "off")
        await hass.async_block_till_done()
        await move_to(hass, freezer, dt_util.utcnow() + timedelta(seconds=1))
    assert [data["message"].splitlines()[-1] for _, data in sent] == [
        "more than 6 writes in 10 minutes; writes paused for 10 minutes"
    ]


async def test_failed_service_action(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set("script.bedtime", "off", {"friendly_name": "Bedtime"})
    action = {
        "type": "service",
        "service": "script.turn_on",
        "target": {"entity_id": ["script.bedtime"]},
        "data": {},
    }
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[block("b_1", day=0, start=8 * 60, duration=60, actions=[action])],
        notify_failures=True,
    )
    fail(hass, "script", "turn_on")
    sent = phones(hass, "pixel")
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert [(data["title"], data["message"]) for _, data in sent] == [
        (
            "Punch Clock couldn't call script.turn_on",
            "b_1 (Week tab, Mon 08:00 to 09:00) scheduled it for Bedtime.\n"
            "script.turn_on failed: device offline",
        )
    ]


async def test_missing_phone_is_logged(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[warm_up()], notify_failures=True, notify_target="mobile_app_gone"
    )
    fail(hass, "climate", "set_temperature")
    sent = phones(hass, "pixel")
    entries = async_capture_events(hass, EVENT_LOGBOOK_ENTRY)
    await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert sent == []
    assert "notify.mobile_app_gone not found" in caplog.text
    # Activity keeps the history even when no phone gets the notification.
    assert len(failures(entries)) == 1


async def test_activity_follows_a_renamed_master_switch(
    hass: HomeAssistant, hass_storage: dict[str, Any], freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set(CLIMATE, "unavailable")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    entries = async_capture_events(hass, EVENT_LOGBOOK_ENTRY)
    await setup_integration(hass)
    er.async_get(hass).async_update_entity(MASTER, new_entity_id="switch.schedules")
    await hass.async_block_till_done()
    await move_to(hass, freezer, START + timedelta(hours=1))
    assert len(failures(entries, "switch.schedules")) == 1


async def test_failed_notification_is_only_logged(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    freezer: FrozenDateTimeFactory,
    caplog: pytest.LogCaptureFixture,
) -> None:
    hass.states.async_set(CLIMATE, "heat", CLIMATE_ATTRS)
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[warm_up()], notify_failures=True)
    fail(hass, "climate", "set_temperature")
    fail(hass, "notify", "mobile_app_pixel")
    entry = await setup_integration(hass)
    await move_to(hass, freezer, START + timedelta(hours=1))
    errors = entry.runtime_data.engine.status()["errors"]
    assert [e["message"] for e in errors] == ["climate.set_temperature failed: device offline"]
    assert "Couldn't send a notification with notify.mobile_app_pixel" in caplog.text
