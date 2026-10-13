from types import SimpleNamespace
from unittest.mock import patch

from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.punch_clock.const import DOMAIN

from helpers import setup_integration


async def test_user_flow(hass: HomeAssistant) -> None:
    hass.config.components.update({"frontend", "panel_custom"})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    with patch("custom_components.punch_clock.async_setup_entry", return_value=True):
        result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Punch Clock"


async def test_single_instance(hass: HomeAssistant) -> None:
    hass.config.components.update({"frontend", "panel_custom"})
    MockConfigEntry(domain=DOMAIN).add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_options_flow_reregisters_panel(
    hass: HomeAssistant, mock_panel: SimpleNamespace
) -> None:
    entry = await setup_integration(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"sidebar_title": "Schedules", "sidebar_icon": "mdi:clock", "require_admin": False},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.options == {
        "sidebar_title": "Schedules",
        "sidebar_icon": "mdi:clock",
        "require_admin": False,
    }
    kwargs = mock_panel.register.await_args.kwargs
    assert kwargs["sidebar_title"] == "Schedules"
    assert kwargs["sidebar_icon"] == "mdi:clock"
    assert kwargs["require_admin"] is False
