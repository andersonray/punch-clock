from logic.resolver import (
    Source,
    block_values,
    controlled_entities,
    entity_settings,
    key_from_str,
    key_to_str,
    resolve,
    service_key,
)

from builders import act, all_of, block, cond, config, hm, lookup, svc, tab, wm

NO_STATES = lookup({})
T = "climate.house"


def value(res, key):  # type: ignore[no-untyped-def]
    return res.desired[key].value if key in res.desired else None


def test_single_active_block() -> None:
    cfg = config(
        blocks=(block("b1", start=hm(6), duration=120, actions=(act(T, temperature=70),)),)
    )
    res = resolve(cfg, wm(0, 7), NO_STATES)
    assert value(res, (T, "temperature")) == 70
    assert res.desired[(T, "temperature")].source == Source("block", "t1", "b1")
    assert res.blocks["b1"].active
    assert resolve(cfg, wm(0, 8), NO_STATES).desired == {}


def test_leftmost_tab_wins() -> None:
    cfg = config(
        tabs=(tab("left"), tab("right")),
        blocks=(
            block("r", "right", start=hm(6), duration=180, actions=(act(T, temperature=60),)),
            block("l", "left", start=hm(5), duration=300, actions=(act(T, temperature=70),)),
        ),
    )
    assert value(resolve(cfg, wm(0, 7), NO_STATES), (T, "temperature")) == 70


def test_same_tab_most_recent_start_wins() -> None:
    cfg = config(
        blocks=(
            block("long", start=hm(6), duration=600, actions=(act(T, temperature=70),)),
            block("late", start=hm(9), duration=60, actions=(act(T, temperature=65),)),
        )
    )
    assert value(resolve(cfg, wm(0, 9, 30), NO_STATES), (T, "temperature")) == 65
    assert value(resolve(cfg, wm(0, 10, 30), NO_STATES), (T, "temperature")) == 70


def test_same_tab_tiebreak_shorter_then_newer() -> None:
    short = block("short", start=hm(6), duration=60, actions=(act(T, temperature=1),), seq=1)
    long = block("long", start=hm(6), duration=120, actions=(act(T, temperature=2),), seq=2)
    assert (
        value(resolve(config(blocks=(short, long)), wm(0, 6), NO_STATES), (T, "temperature")) == 1
    )

    older = block("older", start=hm(6), duration=60, actions=(act(T, temperature=1),), seq=1)
    newer = block("newer", start=hm(6), duration=60, actions=(act(T, temperature=2),), seq=2)
    cfg = config(blocks=(newer, older))
    assert value(resolve(cfg, wm(0, 6), NO_STATES), (T, "temperature")) == 2


def test_keys_resolve_independently() -> None:
    cfg = config(
        blocks=(
            block(
                "a", start=hm(6), duration=600, actions=(act(T, temperature=70, fan_mode="auto"),)
            ),
            block("b", start=hm(9), duration=60, actions=(act(T, temperature=65),)),
        )
    )
    res = resolve(cfg, wm(0, 9, 30), NO_STATES)
    assert value(res, (T, "temperature")) == 65
    assert value(res, (T, "fan_mode")) == "auto"


def test_defaults_apply_when_no_block() -> None:
    cfg = config(
        tabs=(tab("t1", defaults=(act(T, temperature=62),)),),
        blocks=(block("b", start=hm(6), duration=60, actions=(act(T, temperature=70),)),),
    )
    assert value(resolve(cfg, wm(0, 6, 30), NO_STATES), (T, "temperature")) == 70
    res = resolve(cfg, wm(0, 7), NO_STATES)
    assert value(res, (T, "temperature")) == 62
    assert res.desired[(T, "temperature")].source == Source("default", "t1")


def test_block_in_lower_tab_beats_default_in_higher_tab() -> None:
    cfg = config(
        tabs=(tab("high", defaults=(act(T, temperature=62),)), tab("low")),
        blocks=(block("b", "low", start=hm(6), duration=60, actions=(act(T, temperature=70),)),),
    )
    assert value(resolve(cfg, wm(0, 6, 30), NO_STATES), (T, "temperature")) == 70


def test_defaults_follow_tab_priority() -> None:
    cfg = config(
        tabs=(
            tab("a", defaults=(act(T, temperature=1),)),
            tab("b", defaults=(act(T, temperature=2),)),
        )
    )
    assert value(resolve(cfg, wm(0, 0), NO_STATES), (T, "temperature")) == 1


def test_disabled_tab_is_ignored() -> None:
    cfg = config(
        tabs=(tab("t1", enabled=False, defaults=(act(T, temperature=62),)),),
        blocks=(block("b", start=0, duration=600, actions=(act(T, temperature=70),)),),
    )
    res = resolve(cfg, wm(0, 1), NO_STATES)
    assert res.desired == {}
    assert not res.tabs["t1"].active
    assert res.blocks["b"].in_window
    assert not res.blocks["b"].active


def test_tab_conditions() -> None:
    away = cond("input_boolean.away", "is", "on")
    cfg = config(
        tabs=(tab("t1", conditions=all_of(away), defaults=(act(T, temperature=55),)),),
    )
    assert resolve(cfg, 0, lookup({"input_boolean.away": "off"})).desired == {}
    res = resolve(cfg, 0, lookup({"input_boolean.away": "on"}))
    assert value(res, (T, "temperature")) == 55
    assert res.tabs["t1"].conditions_met


def test_block_conditions() -> None:
    guests = cond("input_boolean.guests", "is", "on")
    cfg = config(
        blocks=(
            block(
                "b",
                start=0,
                duration=60,
                conditions=all_of(guests),
                actions=(act(T, temperature=72),),
            ),
        )
    )
    res = resolve(cfg, 10, lookup({"input_boolean.guests": "off"}))
    assert res.desired == {}
    assert res.blocks["b"].in_window
    assert not res.blocks["b"].conditions_met
    assert value(resolve(cfg, 10, lookup({"input_boolean.guests": "on"})), (T, "temperature")) == 72


def test_later_action_in_block_overrides() -> None:
    b = block("b", actions=(act(T, temperature=70, fan_mode="on"), act(T, temperature=71)))
    assert block_values(b) == {(T, "temperature"): 71, (T, "fan_mode"): "on"}


def test_service_actions() -> None:
    action = svc("script.turn_on", "script.morning", variables={"x": 1})
    cfg = config(blocks=(block("b", start=0, duration=60, actions=(action,)),))
    res = resolve(cfg, 10, NO_STATES)
    key = service_key(action)
    assert res.desired[key].value == {
        "block": "b",
        "service": "script.turn_on",
        "target": {"entity_id": ["script.morning"]},
        "data": {"variables": {"x": 1}},
    }


def test_key_string_round_trip() -> None:
    key = service_key(svc("light.turn_on", "light.a"))
    assert key_from_str(key_to_str(key)) == key
    assert key_from_str(key_to_str((T, "temperature"))) == (T, "temperature")


def test_controlled_entities_and_grouping() -> None:
    cfg = config(
        tabs=(tab("t1", defaults=(act("light.porch", state="off"),)),),
        blocks=(block("b", actions=(act(T, temperature=70), svc("script.turn_on"))),),
    )
    assert controlled_entities(cfg) == {"light.porch", T}
    assert entity_settings({(T, "temperature"): 70, (T, "fan_mode"): "auto"}) == {
        T: {"temperature": 70, "fan_mode": "auto"}
    }
