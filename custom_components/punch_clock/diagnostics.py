"""Diagnostics download for Punch Clock."""

from typing import Any

from homeassistant.core import HomeAssistant

from . import PunchClockConfigEntry
from .logic.model import dump_config


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: PunchClockConfigEntry
) -> dict[str, Any]:
    data = entry.runtime_data
    return {
        "version": data.version,
        "options": dict(entry.options),
        "time_zone": hass.config.time_zone,
        "config": dump_config(data.store.config),
        "status": data.engine.status(),
    }
