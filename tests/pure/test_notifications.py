from dataclasses import replace

import pytest

from logic.describe import source_data
from logic.notifications import (
    COLOR,
    ICON,
    entity_failure,
    payload,
    sample_notification,
    service_failure,
    unavailable_problem,
)
from logic.resolver import Source

from builders import block, config, hm, tab

CFG = config(
    tabs=(tab("t1", name="Winter"),),
    blocks=(
        replace(block("b1", day=0, start=hm(6, 30), duration=90), name="Morning warm-up"),
        replace(block("b2", day=4, start=hm(22), duration=240), name=" "),  # Fri 22:00 -> 02:00
    ),
)


def test_entity_failure_names_the_block_its_tab_and_times() -> None:
    sources = [source_data(CFG, Source("block", "t1", "b1"), ["hvac_mode", "temperature"])]
    settings = {"temperature": 21, "hvac_mode": "heat"}
    problems = ["climate.set_temperature failed: device offline"]
    assert entity_failure(CFG, "climate.hall", "Hall", settings, sources, problems) == (
        "Punch Clock couldn't set Hall",
        "Morning warm-up (Winter tab, Mon 06:30 to 08:00) wanted heat, 21 °C.\n"
        "climate.set_temperature failed: device offline",
    )


def test_entity_failure_with_several_sources_and_problems() -> None:
    cfg = replace(CFG, settings=replace(CFG.settings, time_format="12"))
    sources = [
        source_data(cfg, Source("block", "t1", "b2"), ["hvac_mode"]),
        source_data(cfg, Source("default", "t1"), ["fan_mode"]),
    ]
    settings = {"hvac_mode": "cool", "fan_mode": "low"}
    problems = ["hvac_mode skipped: 'cool' is not in the entity's hvac_modes", "boom"]
    title, message = entity_failure(cfg, "climate.hall", None, settings, sources, problems)
    assert title == "Punch Clock couldn't set climate.hall"
    assert message.splitlines() == [
        "An unnamed block (Winter tab, Fri 10:00 PM to 2:00 AM) wanted cool.",
        "The default for Winter wanted fan low.",
        *problems,
    ]


def test_entity_failure_without_a_known_source() -> None:
    sources = [source_data(CFG, Source("block", "t1", "gone"), ["state"])]
    _, message = entity_failure(CFG, "light.desk", "Desk", {"state": "on"}, sources, ["x"])
    assert message == "A deleted block wanted on.\nx"
    _, message = entity_failure(CFG, "light.desk", "Desk", {"state": "on"}, [], ["x"])
    assert message == "The schedule wanted on.\nx"


def test_service_failure() -> None:
    sources = [source_data(CFG, Source("block", "t1", "b1"), ["call"])]
    assert service_failure(CFG, "script.turn_on", ["Bedtime"], sources, ["failed: boom"]) == (
        "Punch Clock couldn't call script.turn_on",
        "Morning warm-up (Winter tab, Mon 06:30 to 08:00) scheduled it for Bedtime.\nfailed: boom",
    )
    assert service_failure(CFG, "test.ping", [], [], ["boom"])[1] == "boom"


@pytest.mark.parametrize(
    ("priority", "expected"),
    [
        ("low", {"channel": "Punch Clock (low priority)", "importance": "low"}),
        ("normal", {"channel": "Punch Clock", "importance": "default"}),
        (
            "high",
            {
                "channel": "Punch Clock (high priority)",
                "importance": "high",
                "priority": "high",
                "ttl": 0,
            },
        ),
        ("critical", {"channel": "alarm_stream", "priority": "high", "ttl": 0}),
    ],
)
def test_payload_priorities(priority: str, expected: dict[str, object]) -> None:
    data = payload("T", "M", "punch_clock_climate_hall", priority)  # type: ignore[arg-type]
    assert data["title"] == "T"
    assert data["message"] == "M"
    extra = data["data"]
    assert extra["color"] == COLOR == "#FF9800"
    assert extra["notification_icon"] == ICON == "mdi:alert"
    assert extra["tag"] == "punch_clock_climate_hall"
    assert extra["clickAction"] == extra["url"] == "/punch-clock"
    assert {k: extra[k] for k in expected} == expected
    assert ("priority" in extra) == (priority in {"high", "critical"})
    levels = {
        "low": "passive",
        "normal": "active",
        "high": "time-sensitive",
        "critical": "critical",
    }
    assert extra["push"]["interruption-level"] == levels[priority]
    if priority == "critical":
        assert extra["push"]["sound"] == {"name": "default", "critical": 1, "volume": 1.0}


def test_payloads_dont_share_nested_data() -> None:
    first = payload("T", "M", "tag", "high")
    first["data"]["push"]["sound"] = "x"
    assert "sound" not in payload("T", "M", "tag", "high")["data"]["push"]


def test_unavailable_problem() -> None:
    assert unavailable_problem("unavailable") == (
        "It's unavailable, so Punch Clock will set it when it's available again."
    )
    assert unavailable_problem("unknown") == (
        "Its state is unknown, so Punch Clock will set it when it's available again."
    )
    assert (
        unavailable_problem(None) == "It doesn't exist, so Punch Clock will set it if it appears."
    )


def test_sample_notification() -> None:
    title, message = sample_notification()
    assert title == "Punch Clock test notification"
    assert message.startswith("When Punch Clock can't set a scheduled value")
