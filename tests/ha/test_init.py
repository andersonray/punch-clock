from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er, issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.punch_clock.const import DOMAIN, STORAGE_KEY_CONFIG

from helpers import TAB, block, entity_action, setup_integration, stored_config


async def test_setup_registers_panel_and_entities(
    hass: HomeAssistant, mock_panel: SimpleNamespace
) -> None:
    entry = await setup_integration(hass)
    assert entry.state is ConfigEntryState.LOADED

    kwargs = mock_panel.register.await_args.kwargs
    assert kwargs["frontend_url_path"] == "punch-clock"
    assert kwargs["webcomponent_name"] == "punch-clock-panel"
    assert kwargs["module_url"] == "/punch_clock_static/punch-clock-panel.js?v=0123456789ab"
    assert kwargs["require_admin"] is True
    assert kwargs["sidebar_title"] == "Punch Clock"

    assert hass.states.get("switch.punch_clock_enabled").state == "on"
    assert hass.states.get("switch.punch_clock_schedule_enabled").state == "on"
    assert hass.states.get("binary_sensor.punch_clock_schedule_active").state == "on"


async def test_unload_and_reload(hass: HomeAssistant, mock_panel: SimpleNamespace) -> None:
    entry = await setup_integration(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert entry.state is ConfigEntryState.NOT_LOADED
    mock_panel.remove.assert_called_once()

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert mock_panel.register.await_count == 2


async def test_missing_bundle_still_loads(hass: HomeAssistant, mock_panel: SimpleNamespace) -> None:
    with patch("custom_components.punch_clock.panel._bundle_hash", return_value=None):
        entry = await setup_integration(hass)
    assert entry.state is ConfigEntryState.LOADED
    mock_panel.register.assert_not_awaited()


async def test_orphaned_tab_entities_removed(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN, entry_id="entry1")
    entry.add_to_hass(hass)
    registry = er.async_get(hass)
    orphan = registry.async_get_or_create(
        "switch", DOMAIN, "entry1_tab_t_gone_enabled", config_entry=entry
    )
    hass_storage[STORAGE_KEY_CONFIG] = stored_config()
    await setup_integration(hass, entry=entry)
    assert registry.async_get(orphan.entity_id) is None
    assert registry.async_get_entity_id("switch", DOMAIN, f"entry1_tab_{TAB}_enabled")


async def test_entity_rename_updates_references(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    registry = er.async_get(hass)
    registry.async_get_or_create("climate", "demo", "thermostat", suggested_object_id="old")
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(
        blocks=[
            block(
                "b_1",
                day=0,
                start=0,
                duration=60,
                actions=[entity_action("climate.old", temperature=20)],
            )
        ]
    )
    entry = await setup_integration(hass)

    registry.async_update_entity("climate.old", new_entity_id="climate.new")
    await hass.async_block_till_done()

    action = entry.runtime_data.store.config.blocks[0].actions[0]
    assert action.entity_id == "climate.new"


async def test_schedule_temperature_unit_is_kept(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    """The schedule's unit is independent of Home Assistant's (metric in tests)."""
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(temperature_unit="°F")
    entry = await setup_integration(hass)
    assert entry.runtime_data.store.config.settings.temperature_unit == "°F"
    assert not ir.async_get(hass).issues


async def test_new_install_defaults_to_celsius(hass: HomeAssistant) -> None:
    entry = await setup_integration(hass)
    settings = entry.runtime_data.store.config.settings
    assert settings.temperature_unit == "°C"
    assert settings.time_format == "auto"


async def test_invalid_stored_items_are_dropped(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    good = block("b_good", day=0, start=0, duration=60, actions=[])
    bad = block("b_bad", day=9, start=0, duration=60, actions=[])
    hass_storage[STORAGE_KEY_CONFIG] = stored_config(blocks=[good, bad])
    entry = await setup_integration(hass)
    assert [b.id for b in entry.runtime_data.store.config.blocks] == ["b_good"]
    assert any(key.startswith(f"{STORAGE_KEY_CONFIG}.bak-") for key in hass_storage)
