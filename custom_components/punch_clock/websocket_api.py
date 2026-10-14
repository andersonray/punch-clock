"""WebSocket API used by the Punch Clock panel. See docs/websocket-api.md."""

from collections.abc import Callable
from functools import wraps
from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import (
    CONF_REQUIRE_ADMIN,
    DATA_WS_REGISTERED,
    DEFAULT_REQUIRE_ADMIN,
    DOMAIN,
    SIGNAL_CONFIG_UPDATED,
    SIGNAL_STATUS_UPDATED,
)
from .logic import mutations
from .logic.conditions import explain
from .logic.model import ConfigError, dump_block, dump_config, dump_settings, dump_tab, parse_group
from .logic.transitions import Mode

if TYPE_CHECKING:
    from . import PunchClockData

type Handler = Callable[
    [HomeAssistant, websocket_api.ActiveConnection, dict[str, Any], "PunchClockData"], None
]

ERR_NOT_LOADED = "not_loaded"
ERR_NOT_FOUND = "not_found"
ERR_INVALID = "invalid_format"
ERR_LIMIT = "limit_exceeded"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register all commands. Commands can't be unregistered, so do this once."""
    if hass.data.get(DATA_WS_REGISTERED):
        return
    hass.data[DATA_WS_REGISTERED] = True
    for command in (
        ws_info,
        ws_config_get,
        ws_subscribe,
        ws_settings_update,
        ws_tabs_create,
        ws_tabs_update,
        ws_tabs_delete,
        ws_tabs_duplicate,
        ws_tabs_reorder,
        ws_blocks_create,
        ws_blocks_update,
        ws_blocks_update_many,
        ws_blocks_delete,
        ws_blocks_delete_many,
        ws_conditions_evaluate,
        ws_reapply,
    ):
        websocket_api.async_register_command(hass, command)


def _loaded(hass: HomeAssistant) -> PunchClockData | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None  # type: ignore[no-any-return]


def _handler(func: Handler) -> websocket_api.WebSocketCommandHandler:
    """Resolve the loaded entry, enforce the admin option and map ConfigError to errors."""

    @wraps(func)
    @callback
    def wrapper(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        data = _loaded(hass)
        if data is None:
            connection.send_error(msg["id"], ERR_NOT_LOADED, "Punch Clock is not loaded")
            return
        require_admin = data.entry.options.get(CONF_REQUIRE_ADMIN, DEFAULT_REQUIRE_ADMIN)
        if require_admin and not connection.user.is_admin:
            connection.send_error(
                msg["id"], websocket_api.ERR_UNAUTHORIZED, "Admin access required"
            )
            return
        try:
            func(hass, connection, msg, data)
        except mutations.NotFoundError as err:
            connection.send_error(msg["id"], ERR_NOT_FOUND, str(err))
        except mutations.LimitError as err:
            connection.send_error(msg["id"], ERR_LIMIT, str(err))
        except ConfigError as err:
            connection.send_error(msg["id"], ERR_INVALID, str(err))

    return wrapper


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/info"})
@_handler
def ws_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    connection.send_result(
        msg["id"],
        {
            "version": data.version,
            "time_zone": hass.config.time_zone,
            "temperature_unit": hass.config.units.temperature_unit,
        },
    )


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config/get"})
@_handler
def ws_config_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    connection.send_result(msg["id"], dump_config(data.store.config))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@_handler
def ws_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    """Stream config and status snapshots. Both are sent right after subscribing."""
    msg_id = msg["id"]

    @callback
    def send_config() -> None:
        if (current := _loaded(hass)) is not None:
            payload = {"kind": "config", "config": dump_config(current.store.config)}
            connection.send_message(websocket_api.event_message(msg_id, payload))

    @callback
    def send_status() -> None:
        if (current := _loaded(hass)) is not None:
            payload = {"kind": "status", "status": current.engine.status()}
            connection.send_message(websocket_api.event_message(msg_id, payload))

    unsubs = [
        async_dispatcher_connect(hass, SIGNAL_CONFIG_UPDATED, send_config),
        async_dispatcher_connect(hass, SIGNAL_STATUS_UPDATED, send_status),
    ]

    @callback
    def unsubscribe() -> None:
        for unsub in unsubs:
            unsub()

    connection.subscriptions[msg_id] = unsubscribe
    connection.send_result(msg_id)
    send_config()
    send_status()


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/settings/update", vol.Required("changes"): dict}
)
@_handler
def ws_settings_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    def mutate(config: Any) -> tuple[Any, None]:
        return mutations.update_settings(config, msg["changes"]), None

    data.store.async_mutate(mutate)
    connection.send_result(msg["id"], {"settings": dump_settings(data.store.config.settings)})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/tabs/create", vol.Required("tab"): dict}
)
@_handler
def ws_tabs_create(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    tab = data.store.async_mutate(lambda c: mutations.create_tab(c, msg["tab"]))
    connection.send_result(msg["id"], {"tab": dump_tab(tab)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/tabs/update",
        vol.Required("tab_id"): str,
        vol.Required("changes"): dict,
    }
)
@_handler
def ws_tabs_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    tab = data.store.async_mutate(lambda c: mutations.update_tab(c, msg["tab_id"], msg["changes"]))
    connection.send_result(msg["id"], {"tab": dump_tab(tab)})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/tabs/delete", vol.Required("tab_id"): str}
)
@_handler
def ws_tabs_delete(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    data.store.async_mutate(lambda c: (mutations.delete_tab(c, msg["tab_id"]), None))
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/tabs/duplicate", vol.Required("tab_id"): str}
)
@_handler
def ws_tabs_duplicate(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    """Copy a tab and its blocks into a new tab, turned off, right after it."""
    tab, blocks = data.store.async_mutate(lambda c: mutations.duplicate_tab(c, msg["tab_id"]))
    connection.send_result(
        msg["id"], {"tab": dump_tab(tab), "blocks": [dump_block(b) for b in blocks]}
    )


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/tabs/reorder", vol.Required("order"): [str]}
)
@_handler
def ws_tabs_reorder(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    data.store.async_mutate(lambda c: (mutations.reorder_tabs(c, msg["order"]), None))
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/blocks/create", vol.Required("blocks"): [dict]}
)
@_handler
def ws_blocks_create(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    blocks = data.store.async_mutate(lambda c: mutations.create_blocks(c, msg["blocks"]))
    connection.send_result(msg["id"], {"blocks": [dump_block(b) for b in blocks]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/blocks/update",
        vol.Required("block_id"): str,
        vol.Required("changes"): dict,
    }
)
@_handler
def ws_blocks_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    block = data.store.async_mutate(
        lambda c: mutations.update_block(c, msg["block_id"], msg["changes"])
    )
    connection.send_result(msg["id"], {"block": dump_block(block)})


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/blocks/update_many",
        vol.Required("updates"): [
            vol.Schema({vol.Required("block_id"): str, vol.Required("changes"): dict})
        ],
    }
)
@_handler
def ws_blocks_update_many(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    """Update several blocks at once (all or nothing), e.g. every block of a group."""
    updates = [(u["block_id"], u["changes"]) for u in msg["updates"]]
    blocks = data.store.async_mutate(lambda c: mutations.update_blocks(c, updates))
    connection.send_result(msg["id"], {"blocks": [dump_block(b) for b in blocks]})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/blocks/delete", vol.Required("block_id"): str}
)
@_handler
def ws_blocks_delete(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    data.store.async_mutate(lambda c: (mutations.delete_block(c, msg["block_id"]), None))
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/blocks/delete_many", vol.Required("block_ids"): [str]}
)
@_handler
def ws_blocks_delete_many(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    data.store.async_mutate(lambda c: (mutations.delete_blocks(c, msg["block_ids"]), None))
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/conditions/evaluate", vol.Required("conditions"): dict}
)
@_handler
def ws_conditions_evaluate(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    """Evaluate a (possibly unsaved) condition tree against the current states."""
    group = parse_group(msg["conditions"])
    connection.send_result(msg["id"], explain(group, data.engine.lookup))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/reapply"})
@_handler
def ws_reapply(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    data: PunchClockData,
) -> None:
    """Write every desired value that the entity doesn't currently have."""
    data.engine.evaluate(Mode.REENABLE, "reapply")
    connection.send_result(msg["id"], {})
