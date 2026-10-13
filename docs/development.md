# Development

Punch Clock has two parts:

- **Backend**: a Home Assistant custom integration in `custom_components/punch_clock/`. The
  scheduling rules live in `custom_components/punch_clock/logic/`, which is pure Python and
  never imports Home Assistant.
- **Frontend**: the sidebar panel, written in TypeScript and Lit and found in `frontend/`. It's
  built with Vite into one file, `custom_components/punch_clock/frontend/punch-clock-panel.js`.
  That file is gitignored; the release workflow builds it and puts it in `punch_clock.zip`.

Home Assistant Core doesn't run natively on Windows. On Windows, run the Python side in WSL
(Ubuntu). The frontend tooling works anywhere Node 24 runs.

## Python environment (Linux or WSL)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # once, if uv isn't installed
scripts/setup                                       # creates ~/.venvs/punch-clock (Python 3.14)
```

The virtual environment lives outside the repo, so it stays on a native Linux filesystem. To
put it somewhere else, set `PUNCH_CLOCK_VENV`.

## Tests and linting

```bash
V=~/.venvs/punch-clock/bin
$V/python -m pytest tests/pure      # pure logic: fast, no Home Assistant needed
$V/python -m pytest tests/ha        # integration tests against a real Home Assistant core
scripts/lint                        # ruff format check, ruff lint, mypy --strict on logic/
```

Run the two pytest suites separately. `tests/pure` imports `logic` as a top-level package, so
it never loads the Home Assistant parts of the integration.

Frontend:

```bash
cd frontend
npm ci
npm test          # vitest
npm run lint
npm run build     # writes custom_components/punch_clock/frontend/punch-clock-panel.js
```

## Running a local Home Assistant

```bash
(cd frontend && npm run watch)   # rebuilds the panel on change (can run on Windows)
scripts/develop                  # Home Assistant at http://localhost:8123
```

`scripts/develop` creates the config directory `~/.punch-clock-dev/config`, which you can
override with `PUNCH_CLOCK_HA_CONFIG`. The directory symlinks to this repo's integration and to
[`dev/config/configuration.yaml`](../dev/config/configuration.yaml). That configuration loads
the `demo` integration, which provides entities for every supported domain, plus a few
`input_*` helpers for testing conditions.

On the first run, finish Home Assistant onboarding. Then add the integration under
**Settings → Devices & services → Add integration → Punch Clock**. After you change Python
code, restart `scripts/develop`. After a frontend rebuild, a browser refresh is enough.

## Testing on a real Home Assistant

The repository is private for now, so HACS can't install it. Install it by hand:

1. Build the bundle (`npm run build` in `frontend/`), or download `punch_clock.zip` from a
   release (`gh release download -p punch_clock.zip`).
2. Copy `custom_components/punch_clock/` (or the contents of the zip) to
   `<config>/custom_components/punch_clock/` on the Home Assistant host.
3. Restart Home Assistant.

## Releasing

1. Bump `version` in `custom_components/punch_clock/manifest.json`. This is the single source
   of truth; the frontend reads it at build time.
2. Update `CHANGELOG.md`.
3. Create a GitHub release tagged `vX.Y.Z`. The release workflow checks that the tag matches
   the manifest, builds the frontend, and attaches `punch_clock.zip`.
