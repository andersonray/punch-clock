# Punch Clock

A weekly scheduler for [Home Assistant](https://www.home-assistant.io/) that sets entity values on
a calendar.

> **Status:** early development. Not ready for use yet.

## What it does

- **Week calendar panel** in the Home Assistant sidebar. Drag on a day to create a time block,
  then click it to edit it at 1-minute resolution.
- **Entity actions.** Each block sets any number of entities to chosen values: thermostat mode,
  temperature and fan mode, light brightness and color, cover position, select options, and more.
  There is also a generic "call any service" action.
- **Conditions.** Blocks run only when their conditions are true. Conditions are nested ALL/ANY
  groups of *entity is / is not / greater than / less than value*.
- **Multiple week tabs.** Each tab is a separate week schedule with its own conditions, such as
  "Workweek", "Vacation" or "Guests". Every tab whose conditions are true runs at the same time,
  and the leftmost tab wins when two tabs conflict.
- **Default values.** Each tab can have per-entity values to fall back to when no block is active.
- **Copying blocks.** *Duplicate* copies a block to other days or tabs. The *eyedropper* applies
  another block's actions and conditions to the selected one.
- **Exposed entities.** A master switch, a switch per tab, and a binary sensor per tab, for use in
  automations and dashboards.

Punch Clock respects manual changes. It only writes a value when the scheduled value changes, so
adjusting the thermostat by hand during a block sticks until the next scheduled change. The exact
rules are in [docs/semantics.md](docs/semantics.md).

## Installation

### HACS (once the repository is public)

1. In HACS, open the menu and choose **Custom repositories**. Add
   `https://github.com/andersonray/punch-clock` with the **Integration** category.
2. Install **Punch Clock**, then restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration** and choose **Punch Clock**.

### Manual

1. Download `punch_clock.zip` from the latest
   [release](https://github.com/andersonray/punch-clock/releases).
2. Extract it into `<config>/custom_components/punch_clock/`. `manifest.json` must end up directly
   inside that folder.
3. Restart Home Assistant and add the integration as described above.

Requires Home Assistant 2026.3 or newer.

## Development

See [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)
