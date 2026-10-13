"""Base entities for Punch Clock, and management of per-tab entities."""

from collections.abc import Callable
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, NAME, SIGNAL_CONFIG_UPDATED

if TYPE_CHECKING:
    from . import PunchClockConfigEntry, PunchClockData


@callback
def async_manage_tab_entities(
    hass: HomeAssistant,
    entry: PunchClockConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
    factory: Callable[[str], TabEntity],
) -> None:
    """Keep one entity per tab: add entities for new tabs, remove those of deleted tabs."""
    store = entry.runtime_data.store
    known: dict[str, TabEntity] = {}

    @callback
    def sync() -> None:
        tab_ids = {tab.id for tab in store.config.tabs}
        for tab_id in set(known) - tab_ids:
            entity = known.pop(tab_id)
            registry = er.async_get(hass)
            if entity.entity_id and registry.async_get(entity.entity_id):
                registry.async_remove(entity.entity_id)
            else:
                hass.async_create_task(entity.async_remove())
        new = [factory(tab.id) for tab in store.config.tabs if tab.id not in known]
        known.update((entity.tab_id, entity) for entity in new)
        if new:
            async_add_entities(new)

    sync()
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_CONFIG_UPDATED, sync))


class PunchClockEntity(Entity):
    """Entities belong to one service device and never poll."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, data: PunchClockData, unique_suffix: str) -> None:
        self.data = data
        entry_id = data.entry.entry_id
        self._attr_unique_id = f"{entry_id}_{unique_suffix}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name=NAME,
            entry_type=DeviceEntryType.SERVICE,
            sw_version=data.version,
        )


class TabEntity(PunchClockEntity):
    """An entity that represents one tab; its name follows the tab's name."""

    def __init__(self, data: PunchClockData, tab_id: str, kind: str) -> None:
        super().__init__(data, f"tab_{tab_id}_{kind}")
        self.tab_id = tab_id
        self._suffix = kind

    @property
    def name(self) -> str:
        tab = self.data.store.config.tab(self.tab_id)
        return f"{tab.name if tab else self.tab_id} {self._suffix}"
