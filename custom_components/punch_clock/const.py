"""Constants for Punch Clock."""

from datetime import timedelta
from typing import Final

DOMAIN: Final = "punch_clock"
NAME: Final = "Punch Clock"

PANEL_URL: Final = "punch-clock"
PANEL_COMPONENT: Final = "punch-clock-panel"
PANEL_ICON: Final = "mdi:calendar-clock"
STATIC_URL: Final = "/punch_clock_static"
FRONTEND_DIR: Final = "frontend"
FRONTEND_FILE: Final = "punch-clock-panel.js"
DATA_STATIC_REGISTERED: Final = f"{DOMAIN}_static_registered"
DATA_WS_REGISTERED: Final = f"{DOMAIN}_ws_registered"

STORAGE_KEY_CONFIG: Final = f"{DOMAIN}.config"
STORAGE_KEY_RUNTIME: Final = f"{DOMAIN}.runtime"
STORAGE_VERSION: Final = 1
STORAGE_MINOR_VERSION: Final = 1
CONFIG_SAVE_DELAY: Final = 0.5
RUNTIME_SAVE_DELAY: Final = 10

CONF_SIDEBAR_TITLE: Final = "sidebar_title"
CONF_SIDEBAR_ICON: Final = "sidebar_icon"
CONF_REQUIRE_ADMIN: Final = "require_admin"
DEFAULT_REQUIRE_ADMIN: Final = True

SIGNAL_CONFIG_UPDATED: Final = f"{DOMAIN}_config_updated"
SIGNAL_STATUS_UPDATED: Final = f"{DOMAIN}_status_updated"
EVENT_APPLIED: Final = f"{DOMAIN}_applied"
EVENT_PROBLEM: Final = f"{DOMAIN}_problem"
# The logbook's event for an Activity entry (homeassistant.components.logbook.async_log_entry
# fires it). Fired directly, so Punch Clock doesn't depend on the logbook integration.
EVENT_LOGBOOK_ENTRY: Final = "logbook_entry"

SAFETY_INTERVAL: Final = timedelta(minutes=15)
SERVICE_TIMEOUT: Final = 30.0
MEDIA_PLAYER_ON_TIMEOUT: Final = 10.0
WRITE_BUDGET: Final = 6
WRITE_BUDGET_WINDOW: Final = 600.0
WRITE_SUPPRESS_SECONDS: Final = 600.0
MAX_ERRORS: Final = 50

ISSUE_WRITE_BUDGET: Final = "write_budget"
