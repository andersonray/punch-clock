from typing import Any

from logic.resolver import Key
from logic.transitions import Mode, plan_writes

T = "climate.house"
TEMP: Key = (T, "temperature")
MODE: Key = (T, "hvac_mode")
LIGHT: Key = ("light.porch", "state")
SVC: Key = ("service:script.turn_on|{}", "call")


def matcher(current: dict[Key, Any]):  # type: ignore[no-untyped-def]
    return lambda key, value: key in current and current[key] == value


def test_normal_writes_only_transitions() -> None:
    desired = {TEMP: 70, LIGHT: "on"}
    last = {TEMP: 65, LIGHT: "on"}
    current = {TEMP: 65, LIGHT: "off"}  # the light was turned off by hand
    assert plan_writes(desired, last, matcher(current), Mode.NORMAL) == {T: {"temperature": 70}}


def test_normal_no_transition_no_write() -> None:
    desired = {TEMP: 70}
    assert plan_writes(desired, {TEMP: 70}, matcher({TEMP: 66}), Mode.NORMAL) == {}


def test_normal_transition_writes_whole_entity() -> None:
    desired = {TEMP: 70, MODE: "heat"}
    last = {TEMP: 65, MODE: "heat"}
    current = {TEMP: 65, MODE: "off"}
    assert plan_writes(desired, last, matcher(current), Mode.NORMAL) == {
        T: {"temperature": 70, "hvac_mode": "heat"}
    }


def test_normal_transition_writes_even_if_already_matching() -> None:
    desired = {TEMP: 70}
    assert plan_writes(desired, {}, matcher({TEMP: 70}), Mode.NORMAL) == {T: {"temperature": 70}}


def test_normal_desired_disappearing_writes_nothing() -> None:
    assert plan_writes({}, {TEMP: 70}, matcher({}), Mode.NORMAL) == {}


def test_startup_skips_unchanged() -> None:
    desired = {TEMP: 70}
    assert plan_writes(desired, {TEMP: 70}, matcher({TEMP: 60}), Mode.STARTUP) == {}


def test_startup_writes_changed_if_differs() -> None:
    desired = {TEMP: 70, LIGHT: "on"}
    last = {TEMP: 65, LIGHT: "off"}
    current = {TEMP: 65, LIGHT: "on"}
    assert plan_writes(desired, last, matcher(current), Mode.STARTUP) == {T: {"temperature": 70}}


def test_reenable_enforces_entities_but_not_repeat_services() -> None:
    desired = {TEMP: 70, LIGHT: "on", SVC: {"block": "b"}}
    last = {TEMP: 70, LIGHT: "on", SVC: {"block": "b"}}
    current = {TEMP: 60, LIGHT: "on"}
    assert plan_writes(desired, last, matcher(current), Mode.REENABLE) == {T: {"temperature": 70}}


def test_services_fire_on_transition() -> None:
    desired = {SVC: {"block": "b2"}}
    writes = plan_writes(desired, {SVC: {"block": "b1"}}, matcher({}), Mode.NORMAL)
    assert writes == {SVC[0]: {"call": {"block": "b2"}}}
