"""Builders for stored configs and integration setup used by the HA tests."""

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.punch_clock.const import DOMAIN, STORAGE_KEY_CONFIG, STORAGE_KEY_RUNTIME

TAB = "t_00000001"


def stored_config(
    *,
    blocks: list[dict[str, Any]] | None = None,
    tabs: list[dict[str, Any]] | None = None,
    **settings: Any,
) -> dict[str, Any]:
    """A storage file payload for the config store."""
    return {
        "version": 1,
        "minor_version": 1,
        "key": STORAGE_KEY_CONFIG,
        "data": {
            "revision": 1,
            "seq": 10,
            "settings": {"temperature_unit": "°C", **settings},
            "tabs": tabs if tabs is not None else [tab()],
            "blocks": blocks or [],
        },
    }


def stored_runtime(last_desired: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "minor_version": 1,
        "key": STORAGE_KEY_RUNTIME,
        "data": {"last_desired": last_desired},
    }


def tab(
    tab_id: str = TAB,
    name: str = "Week",
    *,
    enabled: bool = True,
    conditions: dict[str, Any] | None = None,
    defaults: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": tab_id,
        "name": name,
        "enabled": enabled,
        "conditions": conditions or {"type": "group", "mode": "all", "items": []},
        "defaults": defaults or [],
    }


def block(
    block_id: str,
    *,
    day: int,
    start: int,
    duration: int,
    actions: list[dict[str, Any]],
    conditions: dict[str, Any] | None = None,
    tab_id: str = TAB,
    seq: int = 1,
) -> dict[str, Any]:
    return {
        "id": block_id,
        "tab_id": tab_id,
        "seq": seq,
        "day": day,
        "start": start,
        "duration": duration,
        "name": block_id,
        "color": "#039be5",
        "actions": actions,
        "conditions": conditions or {"type": "group", "mode": "all", "items": []},
    }


def entity_action(entity_id: str, **settings: Any) -> dict[str, Any]:
    return {"type": "entity", "entity_id": entity_id, "settings": settings}


def condition(entity_id: str, operator: str = "is", value: str = "on") -> dict[str, Any]:
    return {
        "type": "group",
        "mode": "all",
        "items": [
            {"type": "condition", "entity_id": entity_id, "operator": operator, "value": value}
        ],
    }


async def setup_integration(
    hass: HomeAssistant,
    options: dict[str, Any] | None = None,
    entry: MockConfigEntry | None = None,
) -> MockConfigEntry:
    hass.config.components.update({"frontend", "panel_custom"})
    assert await async_setup_component(hass, "http", {})
    if entry is None:
        entry = MockConfigEntry(domain=DOMAIN, title="Punch Clock", data={}, options=options or {})
        entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry
