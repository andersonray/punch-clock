"""Config and options flows for Punch Clock."""

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
    OptionsFlowWithReload,
)
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_REQUIRE_ADMIN,
    CONF_SIDEBAR_ICON,
    CONF_SIDEBAR_TITLE,
    DEFAULT_REQUIRE_ADMIN,
    DOMAIN,
    NAME,
    PANEL_ICON,
)


class PunchClockConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up Punch Clock. Only one instance is allowed (see manifest)."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title=NAME, data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return PunchClockOptionsFlow()


OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_SIDEBAR_TITLE, default=NAME): selector.TextSelector(),
        vol.Optional(CONF_SIDEBAR_ICON, default=PANEL_ICON): selector.IconSelector(),
        vol.Optional(CONF_REQUIRE_ADMIN, default=DEFAULT_REQUIRE_ADMIN): selector.BooleanSelector(),
    }
)


class PunchClockOptionsFlow(OptionsFlowWithReload):
    """Sidebar title/icon and who may use the panel."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(
                OPTIONS_SCHEMA, self.config_entry.options
            ),
        )
