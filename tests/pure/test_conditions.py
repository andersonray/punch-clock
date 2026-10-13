import pytest

from logic.conditions import evaluate, evaluate_condition, explain, referenced

from builders import all_of, any_of, cond, lookup

STATES = lookup(
    {
        "sensor.temp": ("21.5", {"unit_of_measurement": "°C"}),
        "sensor.text": "cloudy",
        "sensor.int": "70",
        "binary_sensor.door": "on",
        "sensor.down": "unavailable",
        "sensor.unknown": "unknown",
        "climate.house": ("heat", {"temperature": 68, "fan_mode": "auto", "boost": True}),
    }
)


@pytest.mark.parametrize(
    ("entity", "op", "value", "attribute", "expected"),
    [
        # Text equality.
        ("sensor.text", "is", "cloudy", None, True),
        ("sensor.text", "is", "Cloudy", None, False),
        ("sensor.text", "is_not", "sunny", None, True),
        ("binary_sensor.door", "is", "on", None, True),
        # Numeric equality.
        ("sensor.int", "is", "70.0", None, True),
        ("sensor.int", "is_not", "70", None, False),
        ("sensor.temp", "is", "21.5", None, True),
        # Comparisons.
        ("sensor.temp", "gt", "21", None, True),
        ("sensor.temp", "gt", "21.5", None, False),
        ("sensor.temp", "lt", "22", None, True),
        ("sensor.text", "gt", "1", None, False),  # non-numeric state
        ("sensor.temp", "lt", "abc", None, False),  # non-numeric value
        # Attributes.
        ("climate.house", "is", "68", "temperature", True),
        ("climate.house", "gt", "65", "temperature", True),
        ("climate.house", "is", "auto", "fan_mode", True),
        ("climate.house", "is", "true", "boost", True),
        ("climate.house", "gt", "0", "boost", False),  # booleans aren't numbers
        ("climate.house", "is", "x", "missing", False),
        ("climate.house", "is_not", "x", "missing", False),  # fail closed
        # Missing / unavailable entities fail closed for every operator...
        ("sensor.nope", "is", "on", None, False),
        ("sensor.nope", "is_not", "on", None, False),
        ("sensor.down", "is_not", "on", None, False),
        ("sensor.down", "lt", "5", None, False),
        ("sensor.unknown", "is_not", "x", None, False),
        # ...except explicit checks for unavailable/unknown.
        ("sensor.down", "is", "unavailable", None, True),
        ("sensor.down", "is_not", "unavailable", None, False),
        ("sensor.unknown", "is", "unknown", None, True),
        ("sensor.text", "is_not", "unavailable", None, True),
        ("sensor.nope", "is", "unavailable", None, True),  # missing counts as unavailable
    ],
)
def test_condition(entity: str, op: str, value: str, attribute: str | None, expected: bool) -> None:
    assert evaluate_condition(cond(entity, op, value, attribute), STATES) is expected


def test_empty_group_is_true() -> None:
    assert evaluate(all_of(), STATES)
    assert evaluate(any_of(), STATES)


def test_nested_groups() -> None:
    door_on = cond("binary_sensor.door", "is", "on")
    warm = cond("sensor.temp", "gt", "30")
    cloudy = cond("sensor.text", "is", "cloudy")
    assert not evaluate(all_of(door_on, warm), STATES)
    assert evaluate(any_of(door_on, warm), STATES)
    assert evaluate(all_of(cloudy, any_of(warm, door_on)), STATES)
    assert not evaluate(all_of(cloudy, any_of(warm)), STATES)


def test_explain_reports_every_node() -> None:
    tree = any_of(cond("sensor.temp", "gt", "21"), all_of(cond("sensor.down", "is", "on")))
    result = explain(tree, STATES)
    assert result["result"] is True
    first, nested = result["items"]
    assert first == {
        "id": first["id"],
        "type": "condition",
        "result": True,
        "known": True,
        "actual": "21.5",
    }
    assert nested["result"] is False
    assert nested["items"][0]["known"] is False


def test_referenced() -> None:
    tree = all_of(
        cond("sensor.temp", "gt", "1"),
        any_of(cond("climate.house", "is", "1", "temperature"), cond("sensor.temp", "lt", "5")),
    )
    assert referenced(tree) == {"sensor.temp": {None}, "climate.house": {"temperature"}}
