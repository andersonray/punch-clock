# Entity action settings

An entity action stores the settings to apply as `{key: value}`. Each key is one
unit of desired state. Punch Clock resolves keys independently, so one block can set a
thermostat's temperature while another sets its fan mode. Keys that must change
together are compound, for example `temp_range`.

Before writing, values are clamped to the entity's current min/max and rounded to its
step. Values for option lists (modes, presets, sources, ...) that the entity doesn't
currently offer are skipped, and the skip is reported in the panel's status.

The source of truth is `DOMAIN_KEYS` in
[`logic/actions.py`](../custom_components/punch_clock/logic/actions.py). The panel's
editor mirrors it in [`capabilities.ts`](../frontend/src/logic/capabilities.ts).

| Domain | Key | Value | Service |
|---|---|---|---|
| climate | `hvac_mode` | one of `hvac_modes` | `climate.set_hvac_mode` (always first) |
| | `preset_mode` | one of `preset_modes` | `climate.set_preset_mode` |
| | `temperature` | number | `climate.set_temperature` |
| | `temp_range` | `{"low": n, "high": n}` | `climate.set_temperature` (low/high) |
| | `fan_mode` | one of `fan_modes` | `climate.set_fan_mode` |
| | `swing_mode` | one of `swing_modes` | `climate.set_swing_mode` |
| | `swing_horizontal_mode` | one of `swing_horizontal_modes` | `climate.set_swing_horizontal_mode` |
| | `humidity` | 0–100 | `climate.set_humidity` |
| water_heater | `state` | `on` / `off` | `water_heater.turn_on` / `turn_off` |
| | `operation_mode` | one of `operation_list` | `water_heater.set_operation_mode` |
| | `temperature` | number | `water_heater.set_temperature` |
| | `away_mode` | `true` / `false` | `water_heater.set_away_mode` |
| humidifier | `state` | `on` / `off` | `humidifier.turn_on` / `turn_off` |
| | `mode` | one of `available_modes` | `humidifier.set_mode` |
| | `humidity` | 0–100 | `humidifier.set_humidity` |
| fan | `state` | `on` / `off` | `fan.turn_on` / `turn_off` |
| | `percentage` | 0–100 | `fan.turn_on` or `fan.set_percentage` |
| | `preset_mode` | one of `preset_modes` | `fan.turn_on` or `fan.set_preset_mode` |
| | `oscillating` | `true` / `false` | `fan.oscillate` |
| | `direction` | `forward` / `reverse` | `fan.set_direction` |
| light | `state` | `on` / `off` | `light.turn_on` / `turn_off` |
| | `brightness_pct` | 0–100 | `light.turn_on` |
| | `color_temp_kelvin` | 1000–20000 | `light.turn_on` |
| | `rgb_color` | `[r, g, b]` | `light.turn_on` |
| | `effect` | one of `effect_list` | `light.turn_on` |
| switch, input_boolean | `state` | `on` / `off` | `turn_on` / `turn_off` |
| lock | `state` | `locked` / `unlocked` | `lock.lock` / `lock.unlock` |
| number, input_number | `value` | number | `set_value` |
| select, input_select | `option` | one of `options` | `select_option` |
| cover | `state` | `open` / `closed` | `cover.open_cover` / `close_cover` |
| | `position` | 0–100 | `cover.set_cover_position` (open/close if unsupported) |
| | `tilt_position` | 0–100 | `cover.set_cover_tilt_position` |
| media_player | `state` | `on` / `off` | `media_player.turn_on` / `turn_off` |
| | `source` | one of `source_list` | `media_player.select_source` |
| | `volume_level` | 0–1 | `media_player.volume_set` |
| | `is_volume_muted` | `true` / `false` | `media_player.volume_mute` |

## Combination rules

- **Off wins.** `state: off` (or climate `hvac_mode: off`) sends only the turn-off
  call. Every other key in that write is skipped.
- **Climate.** `set_hvac_mode` is sent first, then preset, temperature, fan, swing and
  humidity. If both `temperature` and `temp_range` are set, the range is used in
  `heat_cool` mode and the single temperature in every other mode.
- **Lights.** A brightness, color or effect setting without `state` still turns the
  light on, in a single `light.turn_on` call. If both `color_temp_kelvin` and
  `rgb_color` are set, the color temperature is used.
- **Fans.** If both `preset_mode` and `percentage` are set, the preset is used.
- **Covers.** If both `position` and `state` are set, the position is used.
- **Media players.** After `turn_on`, Punch Clock waits up to 10 seconds for the player
  to leave `off` before it selects a source or sets the volume.

## Service actions

A service action calls any service with optional target entities and JSON data, for
example `script.turn_on` with `{"variables": {...}}`. A service action has no state to
compare against, so it fires each time its block becomes the winning source for it.
In practice that means once each time the block starts.
