"""Sends Punch Clock's phone notifications with the Companion app's notify services.

The mobile_app integration registers a ``notify.mobile_app_<phone>`` service for each phone.
It has notify entities too, but those take only a title and a message, and the services also
take the ``data`` that carries the color, icon and priority (see logic/notifications.py).
"""

import asyncio
import logging
from copy import deepcopy
from typing import Any

from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.util import slugify

from .const import SERVICE_TIMEOUT

_LOGGER = logging.getLogger(__name__)

NOTIFY = "notify"
MOBILE_APP = "mobile_app"
_PREFIX = f"{MOBILE_APP}_"


@callback
def _phone_services(hass: HomeAssistant) -> list[str]:
    return sorted(
        s for s in hass.services.async_services_for_domain(NOTIFY) if s.startswith(_PREFIX)
    )


@callback
def phones(hass: HomeAssistant) -> list[dict[str, str]]:
    """Every phone's notify service (``service``) and the phone's name (``name``), by name.

    mobile_app names each service after the name the phone registered with, as
    ``slugify("mobile_app_<name>")``. The name shown is the device's, so renaming the device
    in Home Assistant shows up here; it doesn't change the service.
    """
    devices = dr.async_get(hass)
    names: dict[str, str] = {}
    for entry in hass.config_entries.async_entries(MOBILE_APP):
        registered = entry.data.get("device_name")
        if not isinstance(registered, str):
            continue
        device = next(iter(dr.async_entries_for_config_entry(devices, entry.entry_id)), None)
        name = (device.name_by_user or device.name) if device is not None else None
        names[slugify(f"{_PREFIX}{registered}")] = name or entry.title or registered
    found = [
        {"service": s, "name": names.get(s) or s.removeprefix(_PREFIX).replace("_", " ")}
        for s in _phone_services(hass)
    ]
    return sorted(found, key=lambda p: (p["name"].casefold(), p["service"]))


@callback
def services_for(hass: HomeAssistant, target: str | None) -> list[str]:
    """The notify services to use: ``target`` if it exists, or every phone's when it's None."""
    if target is None:
        return _phone_services(hass)
    return [target] if hass.services.has_service(NOTIFY, target) else []


async def async_send(
    hass: HomeAssistant,
    services: list[str],
    payload: dict[str, Any],
    context: Context | None = None,
) -> dict[str, str]:
    """Send ``payload`` with each service, all at once. Returns each failed service's error.

    Failures are only logged: they aren't Punch Clock problems, which would notify again.
    """

    async def send(service: str) -> str | None:
        try:
            async with asyncio.timeout(SERVICE_TIMEOUT):
                await hass.services.async_call(
                    NOTIFY, service, deepcopy(payload), blocking=True, context=context
                )
        except Exception as err:
            detail = str(err) or type(err).__name__
            _LOGGER.warning("Couldn't send a notification with notify.%s: %s", service, detail)
            return detail
        return None

    results = await asyncio.gather(*(send(s) for s in services))
    return {s: err for s, err in zip(services, results, strict=True) if err is not None}
