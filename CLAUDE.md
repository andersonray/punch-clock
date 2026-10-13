# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Punch Clock is a Home Assistant **custom integration** (`custom_components/punch_clock`, domain
`punch_clock`) with its own **sidebar panel** (Lit + TypeScript in `frontend/`). It runs weekly
schedules that set entity values. Users drag time blocks onto a week calendar; each block has entity
actions and nested ALL/ANY conditions, and week "tabs" carry their own conditions and default
values. It's distributed through HACS as a release zip (`hacs.json` uses `zip_release`). The repo
(`andersonray/punch-clock`) is private for now, so HACS can't install it yet.

The runtime rules are specified in `docs/semantics.md`: activity, tab priority, the same-tab
tiebreak, defaults, transitions, DST and temperature units. That file is the contract for
`logic/`, so keep the two in sync. `docs/settings-keys.md` and `docs/websocket-api.md` describe the
per-domain setting keys and the panel's WebSocket API.

## Commands

Home Assistant Core doesn't run on Windows, and Windows Python here has no `tzdata`. Run **all
Python** in WSL, using the uv-managed Python 3.14 venv at `~/.venvs/punch-clock` (created by
`scripts/setup`). From a Windows shell, wrap commands like this:
`wsl -e bash -lc 'cd "/mnt/o/other/Punch Clock" && <command>'`.

```bash
V=~/.venvs/punch-clock/bin
scripts/setup                                   # create/update the venv (needs uv)
scripts/lint                                    # ruff format --check, ruff check, mypy --strict on logic/
$V/ruff format . && $V/ruff check --fix .       # auto-fix
$V/python -m pytest tests/pure -q               # pure logic, no Home Assistant
$V/python -m pytest tests/ha -q                 # against a real HA core (pytest-homeassistant-custom-component)
$V/python -m pytest tests/pure/test_resolver.py::test_leftmost_tab_wins -q   # one test
scripts/develop                                 # dev HA on http://localhost:8123 with the demo integration
```

- Run `tests/pure` and `tests/ha` as **separate** pytest invocations. `tests/pure/conftest.py`
  puts the integration directory on `sys.path` and imports `logic` as a top-level package, so the
  HA-importing `__init__.py` never loads. `tests/ha` imports `custom_components.punch_clock...`.
- mypy is strict and covers only `logic/`. `scripts/lint` runs it from inside
  `custom_components/punch_clock` with `-p logic`; otherwise mypy follows the HA layer and reports
  false positives from HA's implicit re-exports and its voluptuous→probatio aliasing.

Frontend (works in Windows or WSL, Node 24):

```bash
cd frontend
npm ci --ignore-scripts
npm test                                        # vitest (happy-dom)
npx vitest run test/panel.test.ts -t "dial"     # one file / test name pattern
npm run lint && npm run typecheck
npm run build      # -> custom_components/punch_clock/frontend/punch-clock-panel.js (gitignored)
npm run watch      # rebuild on change; refresh the browser (no HA restart needed)
```

Python changes need a dev HA restart. HA's own Restart works, because `scripts/develop` starts
`hass` again when it exits with code 100. The dev instance's config lives in `~/.punch-clock-dev/config`
(override with `PUNCH_CLOCK_HA_CONFIG`) and symlinks back to this repo. **The user also uses this
instance:** never delete or reset tabs, blocks or settings that a script didn't create itself.

## Architecture

### Python: a pure core plus a thin HA layer

`custom_components/punch_clock/logic/` must never import Home Assistant (it uses relative imports
only). Every decision is made there:

- `model.py`: immutable dataclasses (`Config`, `Tab`, `Block`, `Group`/`Condition`,
  `EntityAction`/`ServiceAction`, `Settings`) with `parse_*`, which validates and raises
  `ConfigError(path, msg)`, and `dump_*`. `parse_config(strict=False)` drops bad items instead of
  failing (used when loading storage).
- `mutations.py`: every edit the API can make, as a pure `Config -> Config` function that bumps
  `revision`. Changing `settings.temperature_unit` converts every stored temperature (`units.py`).
- `resolver.py`: config + week minute + state lookup → tab/block activity and the desired value per
  `(entity_id, setting)` key. Generic service actions use synthetic `service:...` keys.
- `transitions.py`: which desired values to actually write, given `last_desired`, in `NORMAL`,
  `STARTUP` or `REENABLE` mode. Values are written only when they change, so manual changes are
  respected.
- `actions.py`: per-domain setting keys (`DOMAIN_KEYS`), whether an entity already matches a value,
  and ordered service-call plans (e.g. climate `set_hvac_mode` before `set_temperature`; "off"
  suppresses the rest).
- `timemath.py`: wall-clock "minute of the week" (Monday 00:00 = 0) in HA's time zone, midnight
  and week wrap, and DST-aware boundary instants.

The HA layer wires that core to Home Assistant:

- `store.py`: two `Store`s, the config and the runtime `last_desired`. `async_mutate(fn)` applies a
  pure mutation, saves, and sends `SIGNAL_CONFIG_UPDATED`.
- `engine.py`: on the boundary timer, filtered and debounced state changes of condition entities,
  config changes, startup and a 15-minute safety tick, it resolves, plans the writes and calls
  services. Scheduled temperatures are converted from the schedule's unit to HA's unit right before
  matching and planning. It also keeps pending writes (for unavailable entities), a per-entity write
  budget (with a Repairs issue), recent errors, and the status published on
  `SIGNAL_STATUS_UPDATED`.
- `websocket_api.py`: the `punch_clock/*` commands. They're registered once in `async_setup`,
  because commands can't be unregistered; each handler looks up the loaded entry and enforces the
  `require_admin` option. `subscribe` pushes config and status snapshots.
- `panel.py` serves the bundle as a static path (registered once per HA run) and registers the
  panel with a content hash in `module_url`. `switch.py` and `binary_sensor.py` provide the master
  switch plus per-tab entities, which are created and removed as tabs change (`entity.py`).

The flow of a change: WS command → `store.async_mutate(pure mutation)` → `SIGNAL_CONFIG_UPDATED` →
the engine re-evaluates, the tab entities sync, and subscribers get the new config → the engine
sends `SIGNAL_STATUS_UPDATED` → subscribers get the status.

### Frontend (`frontend/src`)

- **No decorators.** Components use `static properties` with `declare` fields and initialize them in
  the constructor. **No `ha-*` elements**, because they're lazy-loaded HA internals. The panel
  relies only on the `hass` object, HA's theme CSS variables (mapped to `--pc-*` in `styles.ts`) and
  the `hass-toggle-menu` event.
- `main.ts` defines every custom element, guarded with `customElements.get`. A new component must
  be added there (and to `HTMLElementTagNameMap` if tests query it).
- `panel/punch-clock-panel.ts` owns the state: config and status from the subscription, the active
  tab, the selection, eyedropper mode, dialogs and local prefs such as the editor width. The block
  editor edits a **draft** and emits `preview-changed` (name, color, day, times); the panel overlays
  that on the config it passes to the calendar (`viewConfig`, memoized), so unsaved edits show live.
  The week view ignores updates where only `hass` changed.
- `src/logic/` mirrors parts of the backend: `capabilities.ts` ↔ `actions.DOMAIN_KEYS` (which
  settings the editor offers per domain), `time.segments` ↔ `timemath.segments`, and
  `model.findConflicts` ↔ the resolver's same-tab rules. `tests/fixtures/entities.json` is shared
  by pytest and vitest.
- `test/panel.test.ts` mounts the whole panel against a fake `hass` (`fakeHass`, `mount`) and
  drives real flows; extend it for UI behavior.

Adding a per-domain setting means changing `actions.py` (validator, matcher, planner),
`capabilities.ts`, `docs/settings-keys.md`, and the tests on both sides.

## Conventions and constraints

- `custom_components/punch_clock/manifest.json` `version` is the single source of truth. Vite
  injects it as `__PC_VERSION__`, and `release.yml` fails if the release tag `vX.Y.Z` doesn't match.
  Publishing a GitHub release builds the panel and attaches `punch_clock.zip`; the built bundle is
  never committed.
- The minimum HA version is 2026.3 (`hacs.json`), which requires Python ≥ 3.14.2. Code may rely on
  3.14 (deferred annotations, PEP 695 syntax), and ruff targets `py314`.
- Keep `import voluptuous as vol`. HA ≥ 2026.9 aliases it to probatio at runtime, and older
  versions use real voluptuous. Don't assert on validation error text in tests.
- CI (`.github/workflows`): `ci.yml` runs lint, mypy, both pytest suites and the frontend checks
  and build; `validate.yml` runs hassfest and the HACS action (non-blocking until the repo is
  public and has a release).
- Git: branch names use the `rca/` prefix. This repo's local `user.email` is the GitHub noreply
  address; don't change it.
- Headless Chrome screenshots of the panel are a useful visual check. Note that headless windows
  are at least 500 px wide, so test phone widths inside an iframe.
