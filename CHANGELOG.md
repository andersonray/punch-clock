# Changelog

## Unreleased

### Added

- Block groups: blocks in a tab with the same name and color share their actions and
  conditions. Selecting one highlights the group, and the editor lists every block's day and
  times, so one edit changes them all. *Add a time* adds another block to the group, on the day
  after the selected one. A split icon on each row takes a block out of the group
  under a numbered name and a new color, and the eyedropper adds the block you're editing to the group it copies
  from. Saving a block with another group's name and color asks whether to take that group's
  actions and conditions and join it. Deleting a grouped block offers to delete just it or the
  whole group, and a trash icon on each row (under the split icon) deletes that block, after
  asking.
- `punch_clock/blocks/update_many` and `punch_clock/blocks/delete_many` WebSocket commands, which
  change several blocks in one revision.
- Clicking the background of a block's row in a group's When list selects that block: the
  row and the block in the calendar are highlighted, the calendar scrolls to it, and the
  one-day view switches to its day.
- **Duplicate tab** in a tab's ⋮ menu copies the tab and all its blocks into a new tab right
  after it. The copy starts turned off, so it changes nothing until you turn it on.
- `punch_clock/tabs/duplicate` WebSocket command, which does that in one revision.
- A row of entity chips above the calendar filters it: pick one or more entities to show only
  the blocks that set them or target them with a service call.
- Drag a block's top or bottom edge in the calendar to change its start or stop time.
- While drawing out a new block or dragging a block's edge, move into the next or previous day's
  column to make the block run past midnight.
- Click a day's name in the calendar to show only that day, with arrows (or Shift+scroll) for
  the previous and next day.
- Adding a default value to a tab opens the entity list right away, with the entities that the
  tab's blocks set (and that don't have a default yet) at the top.

### Changed

- The clock-dial time picker opens over the block editor instead of in the middle of the window,
  so it's closer to the start and stop fields.

### Fixed

- Changing the temperature unit no longer re-sends the temperatures of running blocks, which
  undid manual changes.
- The tab dialog's description of default values now says that a running block in any tab
  overrides them, not only the tab's own blocks.
- Back-to-back blocks no longer run together in the calendar: a small gap separates them.

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
