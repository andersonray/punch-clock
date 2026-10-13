"""Registers the Punch Clock sidebar panel and serves its JavaScript bundle."""

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback

from .const import (
    CONF_REQUIRE_ADMIN,
    CONF_SIDEBAR_ICON,
    CONF_SIDEBAR_TITLE,
    DATA_STATIC_REGISTERED,
    DEFAULT_REQUIRE_ADMIN,
    FRONTEND_DIR,
    FRONTEND_FILE,
    NAME,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_URL,
    STATIC_URL,
)

_LOGGER = logging.getLogger(__name__)

BUNDLE_DIR = Path(__file__).parent / FRONTEND_DIR


def _bundle_hash() -> str | None:
    """Short content hash of the bundle, used to bust browser caches."""
    try:
        return hashlib.sha256((BUNDLE_DIR / FRONTEND_FILE).read_bytes()).hexdigest()[:12]
    except FileNotFoundError:
        return None


async def async_register_panel(hass: HomeAssistant, entry: ConfigEntry, version: str) -> None:
    digest = await hass.async_add_executor_job(_bundle_hash)
    if digest is None:
        _LOGGER.error(
            "The Punch Clock panel bundle is missing (%s). Install a release zip, or run "
            "'npm run build' in frontend/ when developing",
            BUNDLE_DIR / FRONTEND_FILE,
        )
        return
    if not hass.data.get(DATA_STATIC_REGISTERED):
        # Static routes can't be removed, so register once per Home Assistant run.
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(BUNDLE_DIR), cache_headers=False)]
        )
        hass.data[DATA_STATIC_REGISTERED] = True

    options = entry.options
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title=options.get(CONF_SIDEBAR_TITLE) or NAME,
        sidebar_icon=options.get(CONF_SIDEBAR_ICON) or PANEL_ICON,
        module_url=f"{STATIC_URL}/{FRONTEND_FILE}?v={digest}",
        embed_iframe=False,
        require_admin=options.get(CONF_REQUIRE_ADMIN, DEFAULT_REQUIRE_ADMIN),
        config={"version": version},
    )


@callback
def async_unregister_panel(hass: HomeAssistant) -> None:
    frontend.async_remove_panel(hass, PANEL_URL, warn_if_unknown=False)
