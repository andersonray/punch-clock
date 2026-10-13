"""Per-domain setting keys: validation, current-state matching and service-call planning.

An entity action stores ``settings``: a mapping of setting key to desired value, for
example ``{"hvac_mode": "heat", "temperature": 68}``. This module knows, for each
supported domain:

- which keys exist and what values they accept (``validate_settings``),
- whether an entity's current state already satisfies a desired value (``matches``),
- which service calls bring the entity to the desired values, in which order
  (``plan``).

See ``docs/settings-keys.md`` for the user-facing description.
"""

import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .state import StateView

ON_OFF = frozenset({"on", "off"})

# Feature flags (mirrors Home Assistant's IntFlag values).
COVER_SET_POSITION = 4
COVER_SET_TILT_POSITION = 128

type Validator = Callable[[Any], str | None]
"""Return an error message for an invalid value, or None if it's valid."""


@dataclass(frozen=True, slots=True)
class ServiceCall:
    """One Home Assistant service call."""

    domain: str
    service: str
    data: dict[str, Any] = field(default_factory=dict)
    target: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class PlanResult:
    """The service calls for one entity, plus the keys that were skipped and why."""

    calls: list[ServiceCall] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)

    def call(self, entity_id: str, service: str, data: dict[str, Any] | None = None) -> None:
        domain = entity_id.split(".", 1)[0]
        self.calls.append(ServiceCall(domain, service, data or {}, {"entity_id": entity_id}))

    def skip(self, key: str, reason: str) -> None:
        self.skipped.append((key, reason))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _enum(allowed: frozenset[str] | None = None) -> Validator:
    def validate(value: Any) -> str | None:
        if not isinstance(value, str) or not value:
            return "must be a non-empty string"
        if allowed is not None and value not in allowed:
            return f"must be one of {sorted(allowed)}"
        return None

    return validate


def _number(lo: float | None = None, hi: float | None = None) -> Validator:
    def validate(value: Any) -> str | None:
        if not _is_number(value):
            return "must be a number"
        if lo is not None and value < lo:
            return f"must be at least {lo}"
        if hi is not None and value > hi:
            return f"must be at most {hi}"
        return None

    return validate


def _bool(value: Any) -> str | None:
    return None if isinstance(value, bool) else "must be true or false"


def _temp_range(value: Any) -> str | None:
    if not isinstance(value, Mapping) or set(value) != {"low", "high"}:
        return "must be an object with 'low' and 'high'"
    if not _is_number(value["low"]) or not _is_number(value["high"]):
        return "'low' and 'high' must be numbers"
    if value["low"] > value["high"]:
        return "'low' must not be greater than 'high'"
    return None


def _rgb(value: Any) -> str | None:
    if (
        not isinstance(value, list | tuple)
        or len(value) != 3
        or not all(isinstance(c, int) and not isinstance(c, bool) and 0 <= c <= 255 for c in value)
    ):
        return "must be a list of three integers 0-255"
    return None


_ON_OFF_STATE = {"state": _enum(ON_OFF)}

DOMAIN_KEYS: dict[str, dict[str, Validator]] = {
    "climate": {
        "hvac_mode": _enum(),
        "preset_mode": _enum(),
        "temperature": _number(),
        "temp_range": _temp_range,
        "fan_mode": _enum(),
        "swing_mode": _enum(),
        "swing_horizontal_mode": _enum(),
        "humidity": _number(0, 100),
    },
    "water_heater": {
        "state": _enum(ON_OFF),
        "operation_mode": _enum(),
        "temperature": _number(),
        "away_mode": _bool,
    },
    "humidifier": {"state": _enum(ON_OFF), "mode": _enum(), "humidity": _number(0, 100)},
    "fan": {
        "state": _enum(ON_OFF),
        "percentage": _number(0, 100),
        "preset_mode": _enum(),
        "oscillating": _bool,
        "direction": _enum(frozenset({"forward", "reverse"})),
    },
    "light": {
        "state": _enum(ON_OFF),
        "brightness_pct": _number(0, 100),
        "color_temp_kelvin": _number(1000, 20000),
        "rgb_color": _rgb,
        "effect": _enum(),
    },
    "switch": _ON_OFF_STATE,
    "input_boolean": _ON_OFF_STATE,
    "lock": {"state": _enum(frozenset({"locked", "unlocked"}))},
    "number": {"value": _number()},
    "input_number": {"value": _number()},
    "select": {"option": _enum()},
    "input_select": {"option": _enum()},
    "cover": {
        "state": _enum(frozenset({"open", "closed"})),
        "position": _number(0, 100),
        "tilt_position": _number(0, 100),
    },
    "media_player": {
        "state": _enum(ON_OFF),
        "source": _enum(),
        "volume_level": _number(0, 1),
        "is_volume_muted": _bool,
    },
}

SUPPORTED_DOMAINS = frozenset(DOMAIN_KEYS)


def domain_of(entity_id: str) -> str:
    return entity_id.split(".", 1)[0]


def validate_settings(entity_id: str, settings: Mapping[str, Any]) -> None:
    """Raise ValueError if a setting key or value isn't valid for the entity's domain."""
    domain = domain_of(entity_id)
    keys = DOMAIN_KEYS.get(domain)
    if keys is None:
        raise ValueError(f"domain '{domain}' is not supported for entity actions")
    for key, value in settings.items():
        validator = keys.get(key)
        if validator is None:
            raise ValueError(f"'{key}' is not a setting of {domain} entities")
        if (error := validator(value)) is not None:
            raise ValueError(f"'{key}' {error}")


# ---------------------------------------------------------------------------
# Normalization helpers (shared by matching and planning)
# ---------------------------------------------------------------------------


def _num(value: Any) -> float | None:
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


def _eq(actual: Any, desired: Any) -> bool:
    return bool(actual == desired)


def _close(actual: Any, desired: Any, tolerance: float = 0.01) -> bool:
    a, d = _num(actual), _num(desired)
    return a is not None and d is not None and abs(a - d) <= tolerance


def _fit(
    value: float,
    attrs: Mapping[str, Any],
    min_attr: str | None,
    max_attr: str | None,
    step_attr: str | None,
    default_step: float = 0.0,
) -> float:
    """Clamp a number to the entity's min/max attributes and round it to its step."""
    lo = _num(attrs.get(min_attr)) if min_attr else None
    hi = _num(attrs.get(max_attr)) if max_attr else None
    step = (_num(attrs.get(step_attr)) if step_attr else None) or default_step
    if lo is not None:
        value = max(value, lo)
    if hi is not None:
        value = min(value, hi)
    if step > 0:
        base = lo if lo is not None else 0.0
        value = base + round((value - base) / step) * step
        if hi is not None and value > hi:
            value -= step
        value = round(value, 6)
    return int(value) if float(value).is_integer() else value


def _allowed(value: Any, options: Any) -> bool:
    """True if value is in the entity's option list (or the entity doesn't publish one)."""
    if isinstance(options, list | tuple):
        return value in options
    return True


def _norm_temperature(value: float, attrs: Mapping[str, Any]) -> float:
    return _fit(value, attrs, "min_temp", "max_temp", "target_temp_step", 0.1)


def _norm_percentage(value: float, attrs: Mapping[str, Any]) -> int:
    return round(_fit(value, {"min": 0, "max": 100, **attrs}, "min", "max", "percentage_step", 1.0))


# ---------------------------------------------------------------------------
# Matching: does the entity's current state already satisfy a desired value?
# ---------------------------------------------------------------------------

type Matcher = Callable[[str, Any, StateView], bool]


def _match_climate(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    match key:
        case "hvac_mode":
            return _eq(s.state, value)
        case "temperature":
            return _close(attrs.get("temperature"), _norm_temperature(value, attrs))
        case "temp_range":
            return _close(
                attrs.get("target_temp_low"), _norm_temperature(value["low"], attrs)
            ) and (_close(attrs.get("target_temp_high"), _norm_temperature(value["high"], attrs)))
        case "humidity":
            return _close(attrs.get("humidity"), value, 0.5)
        case _:
            return _eq(attrs.get(key), value)


def _match_water_heater(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    match key:
        case "state":
            return (s.state == "off") == _eq(value, "off")
        case "operation_mode":
            return _eq(attrs.get("operation_mode", s.state), value)
        case "temperature":
            return _close(attrs.get("temperature"), _norm_temperature(value, attrs))
        case "away_mode":
            return attrs.get("away_mode") == ("on" if value else "off")
        case _:
            return False


def _match_humidifier(key: str, value: Any, s: StateView) -> bool:
    match key:
        case "state":
            return _eq(s.state, value)
        case "humidity":
            return _close(s.attributes.get("humidity"), value, 0.5)
        case _:
            return _eq(s.attributes.get(key), value)


def _match_fan(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    match key:
        case "state":
            return _eq(s.state, value)
        case "percentage":
            return _close(attrs.get("percentage"), _norm_percentage(value, attrs), 0.5)
        case _:
            return _eq(attrs.get(key), value)


def _match_light(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    if key == "state":
        return _eq(s.state, value)
    if s.state != "on":
        return False
    match key:
        case "brightness_pct":
            brightness = _num(attrs.get("brightness"))
            return brightness is not None and abs(round(brightness * 100 / 255) - value) <= 1
        case "color_temp_kelvin":
            return attrs.get("color_mode") == "color_temp" and _close(
                attrs.get("color_temp_kelvin"), value, 50
            )
        case "rgb_color":
            current = attrs.get("rgb_color")
            return (
                attrs.get("color_mode") != "color_temp"
                and isinstance(current, list | tuple)
                and len(current) == 3
                and all(abs(int(c) - int(d)) <= 3 for c, d in zip(current, value, strict=True))
            )
        case _:
            return _eq(attrs.get(key), value)


def _match_state(key: str, value: Any, s: StateView) -> bool:
    return key == "state" and s.state == value


def _match_number(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    return key == "value" and _close(s.state, _fit(value, attrs, "min", "max", "step"), 1e-6)


def _match_select(key: str, value: Any, s: StateView) -> bool:
    return key == "option" and s.state == value


def _match_cover(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    match key:
        case "state":
            return _eq(s.state, value)
        case "position":
            if "current_position" in attrs:
                return _close(attrs["current_position"], value, 1)
            return s.state == ("open" if value > 0 else "closed")
        case "tilt_position":
            return _close(attrs.get("current_tilt_position"), value, 1)
        case _:
            return False


def _match_media_player(key: str, value: Any, s: StateView) -> bool:
    attrs = s.attributes
    match key:
        case "state":
            is_off = s.state in ("off", "standby")
            return is_off == _eq(value, "off")
        case "volume_level":
            return _close(attrs.get("volume_level"), value, 0.01)
        case _:
            return _eq(attrs.get(key), value)


_MATCHERS: dict[str, Matcher] = {
    "climate": _match_climate,
    "water_heater": _match_water_heater,
    "humidifier": _match_humidifier,
    "fan": _match_fan,
    "light": _match_light,
    "switch": _match_state,
    "input_boolean": _match_state,
    "lock": _match_state,
    "number": _match_number,
    "input_number": _match_number,
    "select": _match_select,
    "input_select": _match_select,
    "cover": _match_cover,
    "media_player": _match_media_player,
}


def matches(entity_id: str, key: str, value: Any, state: StateView | None) -> bool:
    """True if the entity's current state already satisfies the desired value.

    Unknown or unavailable state never matches, so a write is attempted.
    """
    if state is None or not state.available:
        return False
    matcher = _MATCHERS.get(domain_of(entity_id))
    return matcher(key, value, state) if matcher else False


# ---------------------------------------------------------------------------
# Planning: settings -> ordered service calls
# ---------------------------------------------------------------------------

type Planner = Callable[[str, Mapping[str, Any], StateView], PlanResult]


def _enum_call(
    r: PlanResult,
    entity_id: str,
    settings: Mapping[str, Any],
    key: str,
    options_attr: str,
    service: str,
    attrs: Mapping[str, Any],
) -> None:
    if key not in settings:
        return
    value = settings[key]
    if _allowed(value, attrs.get(options_attr)):
        r.call(entity_id, service, {key: value})
    else:
        r.skip(key, f"'{value}' is not in the entity's {options_attr}")


def _skip_rest(r: PlanResult, settings: Mapping[str, Any], keep: str, reason: str) -> None:
    for key in settings:
        if key != keep:
            r.skip(key, reason)


def _plan_climate(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    mode = settings.get("hvac_mode")
    effective_mode = s.state
    if mode is not None:
        if _allowed(mode, attrs.get("hvac_modes")):
            r.call(entity_id, "set_hvac_mode", {"hvac_mode": mode})
            effective_mode = mode
            if mode == "off":
                _skip_rest(r, settings, "hvac_mode", "hvac_mode is off")
                return r
        else:
            r.skip("hvac_mode", f"'{mode}' is not in the entity's hvac_modes")

    _enum_call(r, entity_id, settings, "preset_mode", "preset_modes", "set_preset_mode", attrs)

    use_range = "temp_range" in settings
    use_single = "temperature" in settings
    if use_range and use_single:
        if effective_mode == "heat_cool":
            use_single = False
            r.skip("temperature", "temp_range is used in heat_cool mode")
        else:
            use_range = False
            r.skip("temp_range", "a single temperature is used outside heat_cool mode")
    if use_single:
        temperature = _norm_temperature(settings["temperature"], attrs)
        r.call(entity_id, "set_temperature", {"temperature": temperature})
    elif use_range:
        low = _norm_temperature(settings["temp_range"]["low"], attrs)
        high = _norm_temperature(settings["temp_range"]["high"], attrs)
        r.call(entity_id, "set_temperature", {"target_temp_low": low, "target_temp_high": high})

    _enum_call(r, entity_id, settings, "fan_mode", "fan_modes", "set_fan_mode", attrs)
    _enum_call(r, entity_id, settings, "swing_mode", "swing_modes", "set_swing_mode", attrs)
    _enum_call(
        r,
        entity_id,
        settings,
        "swing_horizontal_mode",
        "swing_horizontal_modes",
        "set_swing_horizontal_mode",
        attrs,
    )
    if "humidity" in settings:
        humidity = _fit(settings["humidity"], attrs, "min_humidity", "max_humidity", None, 1.0)
        r.call(entity_id, "set_humidity", {"humidity": humidity})
    return r


def _plan_water_heater(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    state = settings.get("state")
    if state == "off":
        r.call(entity_id, "turn_off")
        _skip_rest(r, settings, "state", "state is off")
        return r
    if state == "on":
        r.call(entity_id, "turn_on")
    _enum_call(
        r, entity_id, settings, "operation_mode", "operation_list", "set_operation_mode", attrs
    )
    if "temperature" in settings:
        temperature = _norm_temperature(settings["temperature"], attrs)
        r.call(entity_id, "set_temperature", {"temperature": temperature})
    if "away_mode" in settings:
        r.call(entity_id, "set_away_mode", {"away_mode": settings["away_mode"]})
    return r


def _plan_humidifier(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    state = settings.get("state")
    if state == "off":
        r.call(entity_id, "turn_off")
        _skip_rest(r, settings, "state", "state is off")
        return r
    if state == "on":
        r.call(entity_id, "turn_on")
    _enum_call(r, entity_id, settings, "mode", "available_modes", "set_mode", attrs)
    if "humidity" in settings:
        humidity = _fit(settings["humidity"], attrs, "min_humidity", "max_humidity", None, 1.0)
        r.call(entity_id, "set_humidity", {"humidity": humidity})
    return r


def _plan_fan(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    state = settings.get("state")
    if state == "off":
        r.call(entity_id, "turn_off")
        _skip_rest(r, settings, "state", "state is off")
        return r

    speed: dict[str, Any] = {}
    if "preset_mode" in settings:
        preset = settings["preset_mode"]
        if _allowed(preset, attrs.get("preset_modes")):
            speed["preset_mode"] = preset
        else:
            r.skip("preset_mode", f"'{preset}' is not in the entity's preset_modes")
    if "percentage" in settings:
        if speed:
            r.skip("percentage", "preset_mode is used instead")
        else:
            speed["percentage"] = _norm_percentage(settings["percentage"], attrs)

    if state == "on" or (speed and s.state == "off"):
        r.call(entity_id, "turn_on", speed)
    elif "preset_mode" in speed:
        r.call(entity_id, "set_preset_mode", speed)
    elif "percentage" in speed:
        r.call(entity_id, "set_percentage", speed)

    if "oscillating" in settings:
        r.call(entity_id, "oscillate", {"oscillating": settings["oscillating"]})
    if "direction" in settings:
        r.call(entity_id, "set_direction", {"direction": settings["direction"]})
    return r


def _plan_light(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    state = settings.get("state")
    if state == "off":
        r.call(entity_id, "turn_off")
        _skip_rest(r, settings, "state", "state is off")
        return r

    data: dict[str, Any] = {}
    if "brightness_pct" in settings:
        data["brightness_pct"] = round(settings["brightness_pct"])
    if "color_temp_kelvin" in settings:
        data["color_temp_kelvin"] = round(
            _fit(
                settings["color_temp_kelvin"],
                attrs,
                "min_color_temp_kelvin",
                "max_color_temp_kelvin",
                None,
            )
        )
        if "rgb_color" in settings:
            r.skip("rgb_color", "color_temp_kelvin is used instead")
    elif "rgb_color" in settings:
        data["rgb_color"] = list(settings["rgb_color"])
    if "effect" in settings:
        effect = settings["effect"]
        if _allowed(effect, attrs.get("effect_list")):
            data["effect"] = effect
        else:
            r.skip("effect", f"'{effect}' is not in the entity's effect_list")

    if state == "on" or data:
        r.call(entity_id, "turn_on", data)
    return r


def _plan_on_off(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    if "state" in settings:
        r.call(entity_id, "turn_on" if settings["state"] == "on" else "turn_off")
    return r


def _plan_lock(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    if "state" in settings:
        r.call(entity_id, "lock" if settings["state"] == "locked" else "unlock")
    return r


def _plan_number(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    if "value" in settings:
        value = _fit(settings["value"], s.attributes, "min", "max", "step")
        r.call(entity_id, "set_value", {"value": value})
    return r


def _plan_select(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    _enum_call(r, entity_id, settings, "option", "options", "select_option", s.attributes)
    return r


def _plan_cover(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    features = int(_num(s.attributes.get("supported_features")) or 0)
    if "position" in settings:
        position = round(settings["position"])
        if features & COVER_SET_POSITION:
            r.call(entity_id, "set_cover_position", {"position": position})
        else:
            r.call(entity_id, "open_cover" if position > 0 else "close_cover")
        if "state" in settings:
            r.skip("state", "position is used instead")
    elif "state" in settings:
        r.call(entity_id, "open_cover" if settings["state"] == "open" else "close_cover")
    if "tilt_position" in settings:
        if features & COVER_SET_TILT_POSITION:
            tilt = round(settings["tilt_position"])
            r.call(entity_id, "set_cover_tilt_position", {"tilt_position": tilt})
        else:
            r.skip("tilt_position", "the cover doesn't support setting tilt position")
    return r


def _plan_media_player(entity_id: str, settings: Mapping[str, Any], s: StateView) -> PlanResult:
    r = PlanResult()
    attrs = s.attributes
    state = settings.get("state")
    if state == "off":
        r.call(entity_id, "turn_off")
        _skip_rest(r, settings, "state", "state is off")
        return r
    if state == "on":
        r.call(entity_id, "turn_on")
    _enum_call(r, entity_id, settings, "source", "source_list", "select_source", attrs)
    if "volume_level" in settings:
        r.call(entity_id, "volume_set", {"volume_level": settings["volume_level"]})
    if "is_volume_muted" in settings:
        r.call(entity_id, "volume_mute", {"is_volume_muted": settings["is_volume_muted"]})
    return r


_PLANNERS: dict[str, Planner] = {
    "climate": _plan_climate,
    "water_heater": _plan_water_heater,
    "humidifier": _plan_humidifier,
    "fan": _plan_fan,
    "light": _plan_light,
    "switch": _plan_on_off,
    "input_boolean": _plan_on_off,
    "lock": _plan_lock,
    "number": _plan_number,
    "input_number": _plan_number,
    "select": _plan_select,
    "input_select": _plan_select,
    "cover": _plan_cover,
    "media_player": _plan_media_player,
}


def plan(entity_id: str, settings: Mapping[str, Any], state: StateView) -> PlanResult:
    """Return the ordered service calls that apply ``settings`` to the entity.

    ``state`` must be the entity's current, available state.
    """
    planner = _PLANNERS.get(domain_of(entity_id))
    if planner is None:
        result = PlanResult()
        for key in settings:
            result.skip(key, f"domain '{domain_of(entity_id)}' is not supported")
        return result
    return planner(entity_id, settings, state)


def plan_service(service: str, target: Mapping[str, Any], data: Mapping[str, Any]) -> ServiceCall:
    """Return the call for a generic service action."""
    domain, name = service.split(".", 1)
    return ServiceCall(domain, name, dict(data), dict(target))
