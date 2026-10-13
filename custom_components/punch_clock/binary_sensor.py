"""Binary sensors: one per tab, on while the tab is enabled and its conditions are met."""

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import PunchClockConfigEntry, PunchClockData
from .const import SIGNAL_CONFIG_UPDATED, SIGNAL_STATUS_UPDATED
from .entity import TabEntity, async_manage_tab_entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: PunchClockConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_manage_tab_entities(
        hass, entry, async_add_entities, lambda tab_id: TabActiveSensor(data, tab_id)
    )


class TabActiveSensor(TabEntity, BinarySensorEntity):
    _attr_icon = "mdi:calendar-clock"
    _unrecorded_attributes = frozenset({"active_block_ids", "next_change"})

    def __init__(self, data: PunchClockData, tab_id: str) -> None:
        super().__init__(data, tab_id, "active")

    async def async_added_to_hass(self) -> None:
        for signal in (SIGNAL_CONFIG_UPDATED, SIGNAL_STATUS_UPDATED):
            self.async_on_remove(
                async_dispatcher_connect(self.hass, signal, self.async_write_ha_state)
            )

    @property
    def available(self) -> bool:
        return self.data.engine.started and self.data.store.config.tab(self.tab_id) is not None

    @property
    def is_on(self) -> bool:
        state = self.data.engine.resolution.tabs.get(self.tab_id)
        return state is not None and state.active

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        engine = self.data.engine
        config = self.data.store.config
        tab_state = engine.resolution.tabs.get(self.tab_id)
        active = [
            block
            for block in config.blocks
            if block.tab_id == self.tab_id
            and (state := engine.resolution.blocks.get(block.id)) is not None
            and state.active
        ]
        return {
            "conditions_met": tab_state.conditions_met if tab_state else None,
            "scheduling_paused": not config.settings.enabled,
            "active_blocks": [block.name or block.id for block in active],
            "active_block_ids": [block.id for block in active],
            "next_change": engine.next_boundary.isoformat() if engine.next_boundary else None,
        }
