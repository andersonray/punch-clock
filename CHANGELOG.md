# Changelog

## 0.1.0 (unreleased)

First version.

- Week calendar panel in the sidebar, with drag-to-create blocks, an overlap layout, and
  blocks that can run past midnight.
- Entity actions for climate, water heater, humidifier, fan, light, switch, input_boolean,
  lock, number, input_number, select, input_select, cover and media_player, plus generic
  service calls.
- Nested ALL/ANY conditions on blocks and tabs, with live evaluation in the editor.
- Multiple week tabs with priority order and per-entity default values.
- Duplicate a block to several days and tabs; the eyedropper copies another block's name,
  color, actions and conditions.
- Master switch, per-tab enable switches and per-tab active binary sensors.
- Respects manual changes, picks up correctly after restarts, waits for entities that are
  unavailable, and limits how often one entity is written.
- Settings for units: Celsius or Fahrenheit for scheduled temperatures (converted to Home
  Assistant's unit when written; Celsius by default), and a 12- or 24-hour clock (by default,
  the one in your Home Assistant profile).
- Drag the divider between the calendar and the block editor to resize the editor.
- A new block color shows in the calendar right away, and a new name once you leave the name
  field, before you save.
