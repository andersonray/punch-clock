# Punch Clock runtime semantics

This document defines exactly what Punch Clock does at runtime. The pure logic in
`custom_components/punch_clock/logic/` implements it, and the tests in `tests/pure/` check it.

## Concepts

- **Tab**: a full week of time blocks. Tabs are ordered; the leftmost tab has the highest
  priority. Each tab has an *enabled* flag, *conditions*, and *default values*.
- **Block**: a time range on one day of the week (it may run past midnight into the next
  day), with a name, a color, a list of *actions*, and *conditions*.
- **Action**: either an *entity action* (an entity plus the settings to apply, such as
  `{"hvac_mode": "heat", "temperature": 68}`), or a *service action* (a raw service call
  with a target and data).
- **Default values**: entity actions on a tab that apply when no active block in that tab
  sets the same entity and setting.
- **Setting key**: one unit of desired state for an entity, e.g. `climate.house` +
  `temperature`. Some keys are compound (`temp_range: {low, high}`) because their parts must
  be set together. See `settings-keys.md`.

## Time model

- All times are wall-clock times in Home Assistant's configured time zone (not the
  browser's).
- `day` is 0 = Monday … 6 = Sunday (Python's `weekday()`). The *week start* setting only
  changes the display order of the columns; it never changes stored data.
- A block stores `start` (minute of the day, 0–1439) and `duration` (1–1440 minutes). If
  `start + duration > 1440`, the block runs past midnight into the next day. A block that
  starts on Sunday and runs past midnight continues on Monday.
- The *week minute* is `wm = day * 1440 + hour * 60 + minute` (0–10079).
- A block is **in its window** when `(wm − (day * 1440 + start)) mod 10080 < duration`.

### Daylight saving time

Membership is decided by the local wall clock, so:

- **Spring forward** (local times that don't exist): a block starting in the skipped hour
  starts at the moment of the transition. For a block from 02:30 to 04:00 on a day when
  02:00 jumps to 03:00, the block is active from 03:00 to 04:00.
- **Fall back** (local times that happen twice): a block in the repeated hour is active
  during both passes.

## Conditions

A condition tree is a **group** (`all` or `any`) that holds conditions and nested groups,
up to 6 levels deep.

A condition compares one entity's state, or one of its attributes, against a value:

| Operator | Meaning |
|---|---|
| `is` | If both sides parse as finite numbers, they are compared numerically. Otherwise the strings must match exactly. Booleans become `true`/`false`. |
| `is_not` | The negation of `is`, under the same rules. |
| `gt` / `lt` | Both sides must parse as finite numbers; if either doesn't, the condition is **false**. |

**Conditions fail closed.** If the entity doesn't exist, the attribute is missing, or the
state is `unavailable` / `unknown`, the condition is **false** for every operator, including
`is_not`. The exception: `is` / `is_not` with the literal value `unavailable` or `unknown`
compares against the raw state, so you can deliberately test for an unavailable entity.

An **empty group is true** in both modes; the UI labels it "Always".

## Activity

- A tab is **active** when it is enabled and its conditions are true.
- A block is **active** when it is in its window, its tab is active, and its conditions are
  true.
- When the master switch (`switch.punch_clock_enabled`) is off, activity is still computed
  and shown, but nothing is written.

## Desired state

For every setting key used by any action or default, the desired value is:

1. Go through the **active tabs in tab order**, leftmost first. In each tab, look at its
   **active blocks** that set the key. If any exist, the winner is:
   1. the block that **started most recently**, i.e. the smallest
      `(wm − block_start) mod 10080`;
   2. then the **shorter** block;
   3. then the **newer** block (higher `seq`).

   The first tab with a winning block decides the value.
2. Otherwise, take the **default value** from the first active tab (in tab order) that has a
   default for that key.
3. Otherwise there is **no desired value**, and Punch Clock leaves the entity alone.

If two actions in the same block set the same key, the later action in the list wins.

## Writing (transitions)

Punch Clock remembers the last desired value it acted on for every key (`last_desired`,
persisted across restarts).

A key **transitions** when its new desired value is not empty and differs from
`last_desired`. For every entity that has at least one transitioning key, Punch Clock
writes:

- the transitioning keys, and
- every other desired key of that entity whose current value differs from the desired
  value.

So a transition brings the whole entity to its desired state. This matters for thermostats
that load a different setpoint when the mode changes. Between transitions, **manual changes
are respected**: Punch Clock never fights a change somebody made by hand. A key whose
desired value becomes empty is dropped from `last_desired` and causes no write.

### Modes

| Mode | When | Rule |
|---|---|---|
| normal | timer boundary, condition change, config edit, tab switch | Write as described above. |
| startup | Home Assistant start, integration reload | A restart is not a transition. For each key, skip it if its desired value equals the persisted `last_desired`. Otherwise write it only if the entity's current value differs. |
| re-enable | master switch turned back on | Write every desired key whose current value differs. |

**Service actions** have no readable current state. Their desired value is the call itself,
and they fire each time they transition. In practice that is every time their block becomes
the winner.

## Re-evaluation triggers

Desired state is recomputed on:

- the next block start or end boundary (a timer; no polling);
- a state change of any entity used in a condition, filtered to the state or a referenced
  attribute and debounced (2 s by default; the first change is handled immediately, and a
  burst after it is merged);
- configuration edits, and toggling the master switch or a tab switch;
- startup and time zone changes;
- a target entity becoming available while a write to it is pending;
- a 15-minute safety tick, which is idempotent.

## Temperature units

- Scheduled temperatures (climate `temperature` and `temp_range`, water heater `temperature`)
  are stored in the unit chosen in Punch Clock's settings: `settings.temperature_unit`, °C by
  default.
- Entities report and accept temperatures in Home Assistant's unit. When writing and when
  checking whether an entity already has the desired value, Punch Clock converts from the
  schedule's unit to Home Assistant's, then clamps and rounds to the entity's limits and step.
- Changing `settings.temperature_unit` converts every stored temperature, rounded to one
  decimal, so a schedule keeps its meaning. The remembered last-applied values are converted
  the same way, so the unit change itself is not a transition and doesn't undo manual changes.
- Conditions are not converted. They compare against the entity's raw values, which are in
  Home Assistant's unit.

## Errors and safety

- Values are clamped to the entity's live min/max and rounded to its step. Enum values that
  aren't in the entity's current option list are skipped, with a reason recorded.
- If a target entity is unavailable when it should be written, the write is kept as
  *pending* and done as soon as the entity becomes available, provided the value is still
  desired.
- Service call errors are recorded in the status shown in the panel. They are not retried.
- **Write budget:** at most 6 writes per entity per 10 minutes. Above that, writes to that
  entity pause for 10 minutes and a Repairs issue is raised. This contains a schedule whose
  conditions keep flipping.
- The editor warns when a condition references an entity that the schedule itself controls,
  because that can create a feedback loop.

## Entities

| Entity | Meaning |
|---|---|
| `switch.punch_clock_enabled` | Master switch. When off, nothing is written. |
| `switch.punch_clock_<tab>_enabled` | The tab's enabled flag. |
| `binary_sensor.punch_clock_<tab>_active` | On when the tab is enabled and its conditions are true. Attributes: active blocks, conditions met, next change. |
