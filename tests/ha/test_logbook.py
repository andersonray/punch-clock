"""Punch Clock's entries in Home Assistant's Activity view (the logbook), end to end.

Runs a real recorder and logbook and reads entries back the way the frontend does.
"""

from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from homeassistant.components.recorder import Recorder
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.components.recorder.common import (
    async_wait_recording_done,
)
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from custom_components.punch_clock.const import STORAGE_KEY_CONFIG

from helpers import entity_action, setup_integration, stored_config, tab

CLIMATE = "climate.hall"
ATTRS = {
    "friendly_name": "Hall",
    "hvac_modes": ["off", "heat"],
    "min_temp": 7,
    "max_temp": 35,
    "temperature": 15,
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(
    recorder_mock: Recorder, enable_custom_integrations: None
) -> None:
    """Overrides conftest's: the recorder fixtures must be set up before `hass`."""


@pytest.fixture(autouse=True)
def no_logbook_panel() -> Iterator[None]:
    """The frontend is only marked as loaded (see conftest), so skip the logbook's panel."""
    with patch("homeassistant.components.logbook.frontend.async_register_built_in_panel"):
        yield


def fake_climate(hass: HomeAssistant) -> None:
    """Climate services that update the entity in the caller's context, like a real one."""

    async def set_hvac_mode(call: ServiceCall) -> None:
        state = hass.states.get(CLIMATE)
        hass.states.async_set(
            CLIMATE, call.data["hvac_mode"], state.attributes, context=call.context
        )

    async def set_temperature(call: ServiceCall) -> None:
        state = hass.states.get(CLIMATE)
        attrs = {**state.attributes, "temperature": call.data["temperature"]}
        hass.states.async_set(CLIMATE, state.state, attrs, context=call.context)

    hass.services.async_register("climate", "set_hvac_mode", set_hvac_mode)
    hass.services.async_register("climate", "set_temperature", set_temperature)


async def activity(
    hass: HomeAssistant, ws_client: WebSocketGenerator, entity_ids: list[str] | None = None
) -> list[dict[str, Any]]:
    """Activity entries as the frontend asks for them (an entity's dialog filters by it)."""
    await async_wait_recording_done(hass)
    client = await ws_client(hass)
    query = {"start_time": (dt_util.utcnow() - timedelta(hours=1)).isoformat()}
    if entity_ids:
        query["entity_ids"] = entity_ids
    await client.send_json_auto_id({"type": "logbook/get_events", **query})
    response = await client.receive_json()
    assert response["success"], response
    return response["result"]


def ours(entries: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(e["name"], e["message"]) for e in entries if e.get("domain") == "punch_clock"]


async def start(
    hass: HomeAssistant, hass_storage: dict[str, Any], defaults: list[dict[str, Any]]
) -> None:
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(tabs=[tab(name="Winter", defaults=defaults)])
    hass.config.components.update({"frontend", "panel_custom"})
    assert await async_setup_component(hass, "logbook", {})
    await setup_integration(hass)


async def test_write_shows_in_the_entitys_activity(
    recorder_mock: Recorder,
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    hass.states.async_set(CLIMATE, "off", ATTRS)
    fake_climate(hass)
    await start(hass, hass_storage, [entity_action(CLIMATE, hvac_mode="heat", temperature=21)])

    entry = ("Hall", "Punch Clock set heat, 21 °C (default for Winter) when Punch Clock started")
    mine = await activity(hass, hass_ws_client, [CLIMATE])
    assert ours(mine) == [entry]
    # The resulting state change is listed right after it. Its first event in the context
    # is the entry, so it isn't credited to the bare climate.set_hvac_mode call.
    assert mine[-1]["state"] == "heat"
    assert "context_service" not in mine[-1]

    # Once in the main Activity view as well, not twice.
    assert ours(await activity(hass, hass_ws_client)) == [entry]


async def test_setpoint_only_write_still_shows(
    recorder_mock: Recorder,
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    """A new setpoint doesn't change the entity's state, so HA lists no change for it."""
    hass.states.async_set(CLIMATE, "heat", ATTRS)
    fake_climate(hass)
    await start(hass, hass_storage, [entity_action(CLIMATE, temperature=19.5)])
    assert ours(await activity(hass, hass_ws_client, [CLIMATE])) == [
        ("Hall", "Punch Clock set 19.5 °C (default for Winter) when Punch Clock started")
    ]


async def test_problems_show_in_activity(
    recorder_mock: Recorder,
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
) -> None:
    hass.states.async_set(CLIMATE, "heat", ATTRS)
    fake_climate(hass)
    await start(hass, hass_storage, [entity_action(CLIMATE, hvac_mode="cool")])
    problem = "hvac_mode skipped: 'cool' is not in the entity's hvac_modes"
    assert ours(await activity(hass, hass_ws_client, [CLIMATE])) == [
        ("Hall", f"Punch Clock had a problem: {problem}")
    ]
