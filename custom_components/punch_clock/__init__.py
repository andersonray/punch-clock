"""Punch Clock: a weekly calendar scheduler that sets entity values."""

import logging
from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import (
    config_validation as cv,
    entity_registry as er,
    issue_registry as ir,
)
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from . import websocket_api
from .const import DOMAIN, ISSUE_UNIT_CHANGED
from .engine import PunchClockEngine
from .logic import mutations
from .logic.refs import entity_references, rename_entity
from .panel import async_register_panel, async_unregister_panel
from .store import PunchClockStore

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
PLATFORMS = [Platform.BINARY_SENSOR, Platform.SWITCH]


@dataclass(slots=True)
class PunchClockData:
    entry: ConfigEntry[PunchClockData]
    store: PunchClockStore
    engine: PunchClockEngine
    version: str


type PunchClockConfigEntry = ConfigEntry[PunchClockData]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    websocket_api.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: PunchClockConfigEntry) -> bool:
    integration = await async_get_integration(hass, DOMAIN)
    store = PunchClockStore(hass)
    await store.async_load()
    _check_temperature_unit(hass, store)

    engine = PunchClockEngine(hass, store)
    entry.runtime_data = PunchClockData(entry, store, engine, str(integration.version))

    await async_register_panel(hass, entry, str(integration.version))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _remove_orphaned_entities(hass, entry, store)

    entry.async_on_unload(engine.async_stop)
    entry.async_on_unload(async_at_started(hass, engine.async_start))

    @callback
    def on_registry_updated(event: Event[er.EventEntityRegistryUpdatedData]) -> None:
        _on_entity_renamed(store, event)

    entry.async_on_unload(
        hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, on_registry_updated)
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PunchClockConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        async_unregister_panel(hass)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: PunchClockConfigEntry) -> None:
    await PunchClockStore(hass).async_remove()


@callback
def _on_entity_renamed(
    store: PunchClockStore, event: Event[er.EventEntityRegistryUpdatedData]
) -> None:
    """Follow entity ID changes so schedules keep pointing at the right entity."""
    data: dict[str, Any] = dict(event.data)
    if data.get("action") != "update" or "old_entity_id" not in data:
        return
    old, new = data["old_entity_id"], data["entity_id"]
    if old not in entity_references(store.config):
        return
    _LOGGER.info("Updating Punch Clock references from %s to %s", old, new)
    store.async_mutate(lambda c: (mutations.bump(rename_entity(c, old, new)), None))


@callback
def _remove_orphaned_entities(
    hass: HomeAssistant, entry: PunchClockConfigEntry, store: PunchClockStore
) -> None:
    """Remove registry entries of tabs that no longer exist."""
    registry = er.async_get(hass)
    tab_ids = {t.id for t in store.config.tabs}
    for entity in er.async_entries_for_config_entry(registry, entry.entry_id):
        tab_id = _tab_id_from_unique_id(entry.entry_id, entity.unique_id)
        if tab_id is not None and tab_id not in tab_ids:
            registry.async_remove(entity.entity_id)


def _tab_id_from_unique_id(entry_id: str, unique_id: str) -> str | None:
    prefix = f"{entry_id}_tab_"
    if not unique_id.startswith(prefix):
        return None
    return unique_id[len(prefix) :].rsplit("_", 1)[0]


@callback
def _check_temperature_unit(hass: HomeAssistant, store: PunchClockStore) -> None:
    """Warn once if Home Assistant's temperature unit changed since schedules were made."""
    unit = hass.config.units.temperature_unit
    saved = store.config.settings.temperature_unit
    if saved == unit:
        return
    if saved is not None:
        ir.async_create_issue(
            hass,
            DOMAIN,
            ISSUE_UNIT_CHANGED,
            is_fixable=False,
            is_persistent=True,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_UNIT_CHANGED,
            translation_placeholders={"old": saved, "new": unit},
        )
    store.async_mutate(lambda c: (mutations.update_settings(c, {"temperature_unit": unit}), None))
