"""Condition evaluation. See docs/semantics.md, "Conditions"."""

import math
from typing import Any

from .model import Condition, Group
from .state import SPECIAL_STATES, UNAVAILABLE, Lookup

_TOLERANCE = 1e-9


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            result = float(value.strip())
        except ValueError:
            return None
        return result if math.isfinite(result) else None
    return None


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "none"
    return str(value)


def _equals(actual: Any, expected: str) -> bool:
    a, e = _number(actual), _number(expected)
    if a is not None and e is not None:
        return abs(a - e) <= _TOLERANCE
    return _text(actual) == expected.strip()


def actual_value(condition: Condition, lookup: Lookup) -> tuple[bool, Any]:
    """Return (known, value) for the state or attribute the condition looks at."""
    state = lookup(condition.entity_id)
    if state is None:
        return False, None
    if condition.attribute is None:
        if state.state in SPECIAL_STATES:
            return False, state.state
        return True, state.state
    if condition.attribute not in state.attributes:
        return False, None
    return True, state.attributes[condition.attribute]


def evaluate_condition(condition: Condition, lookup: Lookup) -> bool:
    op = condition.operator
    expected = condition.value.strip()

    # Explicit checks for unavailable/unknown compare against the raw state.
    # A missing entity counts as unavailable.
    if op in ("is", "is_not") and condition.attribute is None and expected in SPECIAL_STATES:
        state = lookup(condition.entity_id)
        raw = state.state if state is not None else UNAVAILABLE
        return (raw == expected) == (op == "is")

    known, actual = actual_value(condition, lookup)
    if not known:
        return False
    match op:
        case "is":
            return _equals(actual, expected)
        case "is_not":
            return not _equals(actual, expected)
        case "gt" | "lt":
            a, e = _number(actual), _number(expected)
            if a is None or e is None:
                return False
            return a > e if op == "gt" else a < e


def evaluate(group: Group, lookup: Lookup) -> bool:
    """Evaluate a condition tree. An empty group is true."""
    if not group.items:
        return True
    results = (
        evaluate(item, lookup) if isinstance(item, Group) else evaluate_condition(item, lookup)
        for item in group.items
    )
    return all(results) if group.mode == "all" else any(results)


def explain(group: Group, lookup: Lookup) -> dict[str, Any]:
    """Evaluate every node (no short-circuit) and report results, for the editor preview."""
    items: list[dict[str, Any]] = []
    for item in group.items:
        if isinstance(item, Group):
            items.append(explain(item, lookup))
        else:
            known, actual = actual_value(item, lookup)
            items.append(
                {
                    "id": item.id,
                    "type": "condition",
                    "result": evaluate_condition(item, lookup),
                    "known": known,
                    "actual": actual if isinstance(actual, str | int | float | bool) else None,
                }
            )
    if not items:
        result = True
    elif group.mode == "all":
        result = all(i["result"] for i in items)
    else:
        result = any(i["result"] for i in items)
    return {"id": group.id, "type": "group", "result": result, "items": items}


def referenced(group: Group) -> dict[str, set[str | None]]:
    """Entities used by a condition tree, with the attributes read (None = the state)."""
    refs: dict[str, set[str | None]] = {}
    _collect(group, refs)
    return refs


def _collect(group: Group, refs: dict[str, set[str | None]]) -> None:
    for item in group.items:
        if isinstance(item, Group):
            _collect(item, refs)
        else:
            refs.setdefault(item.entity_id, set()).add(item.attribute)
