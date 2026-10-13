"""Fixtures for tests that run against a real Home Assistant core.

The `frontend` component pulls in most of Home Assistant, so it's marked as
loaded and panel registration is mocked. `http` and `websocket_api` are real.
"""

from collections.abc import Iterator
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Allow loading custom_components in every test."""


@pytest.fixture(autouse=True)
def mock_panel() -> Iterator[SimpleNamespace]:
    with (
        patch("custom_components.punch_clock.panel._bundle_hash", return_value="0123456789ab"),
        patch(
            "custom_components.punch_clock.panel.panel_custom.async_register_panel",
            new=AsyncMock(),
        ) as register,
        patch("custom_components.punch_clock.panel.frontend.async_remove_panel") as remove,
    ):
        yield SimpleNamespace(register=register, remove=remove)


@pytest.fixture
def mock_media_wait() -> Iterator[MagicMock]:
    with patch(
        "custom_components.punch_clock.engine.PunchClockEngine._async_wait_until_on",
        new=AsyncMock(),
    ) as wait:
        yield wait
