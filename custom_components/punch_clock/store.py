"""Persistent storage for the schedule configuration and runtime state."""

import logging
from collections.abc import Callable, Mapping
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONFIG_SAVE_DELAY,
    RUNTIME_SAVE_DELAY,
    SIGNAL_CONFIG_UPDATED,
    STORAGE_KEY_CONFIG,
    STORAGE_KEY_RUNTIME,
    STORAGE_MINOR_VERSION,
    STORAGE_VERSION,
)
from .logic.model import Config, default_config, dump_config, parse_config
from .logic.resolver import Key, key_from_str, key_to_str

_LOGGER = logging.getLogger(__name__)


class _ConfigStore(Store[dict[str, Any]]):
    """Versioned store; add migrations here when the schema changes."""

    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        return old_data


class PunchClockStore:
    """Holds the current configuration and the last-applied desired values."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._config_store = _ConfigStore(
            hass, STORAGE_VERSION, STORAGE_KEY_CONFIG, minor_version=STORAGE_MINOR_VERSION
        )
        self._runtime_store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY_RUNTIME
        )
        self.config: Config = default_config()
        self.last_desired: dict[Key, Any] = {}

    async def async_load(self) -> None:
        data = await self._config_store.async_load()
        if data is None:
            self.config = default_config()
            self._config_store.async_delay_save(self._config_data, 0)
        else:
            self.config, problems = parse_config(data, strict=False)
            if problems:
                await self._async_backup(data, problems)
                self._config_store.async_delay_save(self._config_data, 0)

        runtime = await self._runtime_store.async_load() or {}
        raw = runtime.get("last_desired", {})
        if isinstance(raw, Mapping):
            self.last_desired = {key_from_str(k): v for k, v in raw.items()}

    async def _async_backup(self, data: dict[str, Any], problems: list[str]) -> None:
        stamp = dt_util.utcnow().strftime("%Y%m%d%H%M%S")
        backup: Store[dict[str, Any]] = Store(
            self.hass, STORAGE_VERSION, f"{STORAGE_KEY_CONFIG}.bak-{stamp}"
        )
        await backup.async_save(data)
        _LOGGER.warning(
            "Dropped %d invalid item(s) from the stored schedule (original saved as %s): %s",
            len(problems),
            f"{STORAGE_KEY_CONFIG}.bak-{stamp}",
            "; ".join(problems),
        )

    @callback
    def _config_data(self) -> dict[str, Any]:
        return dump_config(self.config)

    @callback
    def _runtime_data(self) -> dict[str, Any]:
        return {"last_desired": {key_to_str(k): v for k, v in self.last_desired.items()}}

    @callback
    def async_mutate[T](self, mutation: Callable[[Config], tuple[Config, T]]) -> T:
        """Apply a pure mutation, save it, and notify listeners.

        The mutation raises ConfigError without side effects if the edit is invalid.
        """
        config, result = mutation(self.config)
        self.config = config
        self._config_store.async_delay_save(self._config_data, CONFIG_SAVE_DELAY)
        async_dispatcher_send(self.hass, SIGNAL_CONFIG_UPDATED)
        return result

    @callback
    def async_set_last_desired(self, values: Mapping[Key, Any]) -> None:
        if values == self.last_desired:
            return
        self.last_desired = dict(values)
        self._runtime_store.async_delay_save(self._runtime_data, RUNTIME_SAVE_DELAY)

    async def async_remove(self) -> None:
        await self._config_store.async_remove()
        await self._runtime_store.async_remove()
