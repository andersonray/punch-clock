# Changelog

## Unreleased

### Added

- Home Assistant's Activity view records everything Punch Clock sets, with the block or tab
  default it came from and why, plus any problem it runs into. The entries also show in each
  entity's own Activity.
- `punch_clock_applied` and `punch_clock_problem` events for automations.

### Changed

- Values left out by a combination rule (for example, off wins over a temperature) are no
  longer reported as problems.

## 0.1.0 (2026-10-13)

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
- A new block color, day or time shows in the calendar right away, and a new name once you
  leave the name field, before you save.
- Start and stop times are picked on a clock dial, like Android's: 12-hour with AM/PM, or
  24-hour with an inner ring for 00 and 13-23. You can also type them.
- The dropdown of suggested condition values always lists every value, with values matching
  what you've typed at the top.
- Blocks that won't run right now are hatched in the calendar: those whose own conditions
  aren't met (also marked with an icon), and every block of a tab that isn't running.
- Leaving a block with unsaved changes offers Save as well as Discard.
