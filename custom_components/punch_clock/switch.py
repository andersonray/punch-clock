"""Switches: the master switch and one enable switch per tab."""

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import PunchClockConfigEntry, PunchClockData
from .const import SIGNAL_CONFIG_UPDATED
from .entity import PunchClockEntity, TabEntity, async_manage_tab_entities
from .logic import mutations


async def async_setup_entry(
    hass: HomeAssistant,
    entry: PunchClockConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities([MasterSwitch(data)])
    async_manage_tab_entities(
        hass, entry, async_add_entities, lambda tab_id: TabEnabledSwitch(data, tab_id)
    )


class _ConfigSwitch(SwitchEntity):
    """Rewrites its state whenever the configuration changes."""

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_CONFIG_UPDATED, self.async_write_ha_state)
        )


class MasterSwitch(PunchClockEntity, _ConfigSwitch):
    """When off, Punch Clock keeps evaluating but writes nothing."""

    _attr_translation_key = "enabled"

    def __init__(self, data: PunchClockData) -> None:
        super().__init__(data, "master")

    @property
    def is_on(self) -> bool:
        return self.data.store.config.settings.enabled

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._set(False)

    def _set(self, enabled: bool) -> None:
        self.data.store.async_mutate(
            lambda c: (mutations.update_settings(c, {"enabled": enabled}), None)
        )


class TabEnabledSwitch(TabEntity, _ConfigSwitch):
    """The tab's enabled flag."""

    _attr_icon = "mdi:calendar-check"

    def __init__(self, data: PunchClockData, tab_id: str) -> None:
        super().__init__(data, tab_id, "enabled")

    @property
    def available(self) -> bool:
        return self.data.store.config.tab(self.tab_id) is not None

    @property
    def is_on(self) -> bool:
        tab = self.data.store.config.tab(self.tab_id)
        return tab is not None and tab.enabled

    async def async_turn_on(self, **kwargs: Any) -> None:
        self._set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self._set(False)

    def _set(self, enabled: bool) -> None:
        self.data.store.async_mutate(
            lambda c: mutations.update_tab(c, self.tab_id, {"enabled": enabled})
        )
