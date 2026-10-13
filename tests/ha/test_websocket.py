from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from helpers import setup_integration


class Client:
    """Small wrapper: send a command, return the result or raise with the error."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self.events: list[dict[str, Any]] = []

    async def call(self, type_: str, **payload: Any) -> Any:
        """Send a command and return its result; pushed events are collected in `events`."""
        await self.ws.send_json_auto_id({"type": f"punch_clock/{type_}", **payload})
        msg = await self.ws.receive_json()
        while msg["type"] == "event":
            self.events.append(msg["event"])
            msg = await self.ws.receive_json()
        if not msg["success"]:
            raise CommandError(msg["error"]["code"], msg["error"]["message"])
        return msg["result"]


class CommandError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@pytest.fixture
async def client(hass: HomeAssistant, hass_ws_client: WebSocketGenerator) -> Client:
    await setup_integration(hass)
    return Client(await hass_ws_client(hass))


async def test_info_and_config(client: Client) -> None:
    info = await client.call("info")
    assert info["version"] == "0.1.0"
    assert info["time_zone"] == "US/Pacific"
    config = await client.call("config/get")
    assert [t["name"] for t in config["tabs"]] == ["Schedule"]
    assert config["settings"]["week_start"] == 6


async def test_tab_crud(client: Client, hass: HomeAssistant) -> None:
    first = (await client.call("config/get"))["tabs"][0]["id"]
    tab = (await client.call("tabs/create", tab={"name": "Vacation"}))["tab"]
    await hass.async_block_till_done()
    assert hass.states.get("switch.punch_clock_vacation_enabled").state == "on"

    tab = (await client.call("tabs/update", tab_id=tab["id"], changes={"enabled": False}))["tab"]
    assert tab["enabled"] is False
    await hass.async_block_till_done()
    assert hass.states.get("switch.punch_clock_vacation_enabled").state == "off"
    assert hass.states.get("binary_sensor.punch_clock_vacation_active").state == "off"

    await client.call("tabs/reorder", order=[tab["id"], first])
    assert [t["id"] for t in (await client.call("config/get"))["tabs"]] == [tab["id"], first]

    await client.call("tabs/delete", tab_id=tab["id"])
    await hass.async_block_till_done()
    assert hass.states.get("switch.punch_clock_vacation_enabled") is None
    assert hass.states.get("binary_sensor.punch_clock_vacation_active") is None


async def test_block_crud(client: Client) -> None:
    tab_id = (await client.call("config/get"))["tabs"][0]["id"]
    source = {
        "tab_id": tab_id,
        "day": 1,
        "start": 390,
        "duration": 120,
        "name": "Morning",
        "actions": [{"entity_id": "climate.house", "settings": {"temperature": 20}}],
    }
    blocks = (await client.call("blocks/create", blocks=[source, {**source, "day": 3}]))["blocks"]
    assert [b["day"] for b in blocks] == [1, 3]

    updated = (
        await client.call("blocks/update", block_id=blocks[0]["id"], changes={"start": 391})
    )["block"]
    assert updated["start"] == 391

    await client.call("blocks/delete", block_id=blocks[1]["id"])
    config = await client.call("config/get")
    assert [b["id"] for b in config["blocks"]] == [blocks[0]["id"]]
    assert config["revision"] >= 3


@pytest.mark.parametrize(
    ("command", "payload", "code"),
    [
        ("blocks/update", {"block_id": "b_nope", "changes": {}}, "not_found"),
        ("tabs/update", {"tab_id": "t_nope", "changes": {}}, "not_found"),
        ("tabs/create", {"tab": {"name": ""}}, "invalid_format"),
        ("tabs/create", {"tab": {"name": "x", "color": "red"}}, "invalid_format"),
        ("settings/update", {"changes": {"week_start": 9}}, "invalid_format"),
        ("blocks/create", {"blocks": []}, "invalid_format"),
    ],
)
async def test_errors(client: Client, command: str, payload: dict[str, Any], code: str) -> None:
    with pytest.raises(CommandError) as err:
        await client.call(command, **payload)
    assert err.value.code == code


async def test_invalid_block_is_rejected_atomically(client: Client) -> None:
    tab_id = (await client.call("config/get"))["tabs"][0]["id"]
    good = {"tab_id": tab_id, "day": 1, "start": 0, "duration": 60}
    with pytest.raises(CommandError):
        await client.call("blocks/create", blocks=[good, {**good, "duration": 0}])
    assert (await client.call("config/get"))["blocks"] == []


async def receive_events(client: Client, count: int) -> list[dict[str, Any]]:
    while len(client.events) < count:
        msg = await client.ws.receive_json()
        assert msg["type"] == "event"
        client.events.append(msg["event"])
    events, client.events = client.events[:count], client.events[count:]
    return events


async def test_subscribe(client: Client, hass: HomeAssistant) -> None:
    await client.call("subscribe")
    initial = {e["kind"]: e for e in await receive_events(client, 2)}
    assert initial["config"]["config"]["tabs"][0]["name"] == "Schedule"
    assert initial["status"]["status"]["started"] is True

    await client.call("settings/update", changes={"week_start": 1})
    pushed = {e["kind"]: e for e in await receive_events(client, 2)}
    assert pushed["config"]["config"]["settings"]["week_start"] == 1
    assert "status" in pushed


async def test_conditions_evaluate(client: Client, hass: HomeAssistant) -> None:
    hass.states.async_set("input_boolean.guests", "on")
    result = await client.call(
        "conditions/evaluate",
        conditions={
            "mode": "all",
            "items": [{"entity_id": "input_boolean.guests", "operator": "is", "value": "on"}],
        },
    )
    assert result["result"] is True
    assert result["items"][0]["actual"] == "on"


async def test_non_admin_rejected(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_read_only_access_token: str
) -> None:
    await setup_integration(hass)
    client = Client(await hass_ws_client(hass, hass_read_only_access_token))
    with pytest.raises(CommandError) as err:
        await client.call("config/get")
    assert err.value.code == "unauthorized"


async def test_non_admin_allowed_when_option_off(
    hass: HomeAssistant, hass_ws_client: WebSocketGenerator, hass_read_only_access_token: str
) -> None:
    await setup_integration(hass, options={"require_admin": False})
    client = Client(await hass_ws_client(hass, hass_read_only_access_token))
    assert (await client.call("config/get"))["tabs"]
