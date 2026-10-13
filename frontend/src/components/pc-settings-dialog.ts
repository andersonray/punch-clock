import { LitElement, css, html, nothing } from "lit";
import type { Settings, Status } from "../types";
import { dayName, displayDays, formatHour } from "../logic/time";
import { controls } from "../styles";
import "./pc-dialog";

export interface LocalPrefs {
  hourHeight: number;
  /** Hour to scroll to when opening; -1 = an hour before now. */
  initialHour: number;
  /** Width of the block editor beside the calendar, in pixels. */
  editorWidth: number;
}

export const HOUR_HEIGHTS = [32, 48, 64, 96];

/**
 * Settings: week start, units and debounce (stored in Home Assistant), plus display
 * preferences kept in this browser. Fires `settings-change` ({ changes }),
 * `prefs-change` ({ prefs }), `reapply` and `closed`.
 */
export class PcSettingsDialog extends LitElement {
  static override properties = {
    open: { type: Boolean },
    settings: { attribute: false },
    prefs: { attribute: false },
    status: { attribute: false },
    language: {},
    use24h: { type: Boolean },
    version: {},
  };

  declare open: boolean;
  declare settings: Settings;
  declare prefs: LocalPrefs;
  declare status: Status | null;
  declare language: string;
  declare use24h: boolean;
  declare version: string;

  constructor() {
    super();
    this.open = false;
    this.status = null;
    this.language = "en";
    this.use24h = false;
    this.version = "";
  }

  private fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  protected override render() {
    if (!this.settings) return nothing;
    const errors = this.status?.errors ?? [];
    return html`<pc-dialog
      .open=${this.open}
      heading="Settings"
      @closed=${() => this.fire("closed")}
    >
      <div class="form">
        <label
          >First day of the week
          <select
            @change=${(e: Event) =>
              this.fire("settings-change", {
                changes: { week_start: Number((e.target as HTMLSelectElement).value) },
              })}
          >
            ${displayDays(0).map(
              (d) =>
                html`<option value=${d} ?selected=${d === this.settings.week_start}>
                  ${dayName(d, this.language, "long")}
                </option>`,
            )}
          </select>
        </label>
        <label
          >Wait before reacting to condition changes (seconds)
          <input
            type="number"
            min="0"
            max="60"
            step="0.5"
            .value=${String(this.settings.debounce_seconds)}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= 0 && v <= 60)
                this.fire("settings-change", { changes: { debounce_seconds: v } });
            }}
          />
          <span class="muted hint"
            >The first change is handled right away; further changes within this time are
            combined.</span
          >
        </label>

        <h3>Units</h3>
        <label
          >Temperature
          <select
            @change=${(e: Event) =>
              this.fire("settings-change", {
                changes: { temperature_unit: (e.target as HTMLSelectElement).value },
              })}
          >
            <option value="°C" ?selected=${this.settings.temperature_unit === "°C"}>
              Celsius (°C)
            </option>
            <option value="°F" ?selected=${this.settings.temperature_unit === "°F"}>
              Fahrenheit (°F)
            </option>
          </select>
          <span class="muted hint"
            >Unit for the target temperatures you schedule. Changing it converts the temperatures
            already in your schedules.</span
          >
        </label>
        <label
          >Clock
          <select
            @change=${(e: Event) =>
              this.fire("settings-change", {
                changes: { time_format: (e.target as HTMLSelectElement).value },
              })}
          >
            <option value="auto" ?selected=${this.settings.time_format === "auto"}>
              Same as my Home Assistant profile
            </option>
            <option value="12" ?selected=${this.settings.time_format === "12"}>
              12-hour (1:30 PM)
            </option>
            <option value="24" ?selected=${this.settings.time_format === "24"}>
              24-hour (13:30)
            </option>
          </select>
        </label>

        <h3>This browser</h3>
        <label
          >Hour height
          <select
            @change=${(e: Event) =>
              this.fire("prefs-change", {
                prefs: { ...this.prefs, hourHeight: Number((e.target as HTMLSelectElement).value) },
              })}
          >
            ${HOUR_HEIGHTS.map(
              (h) =>
                html`<option value=${h} ?selected=${h === this.prefs.hourHeight}>${h} px</option>`,
            )}
          </select>
        </label>
        <label
          >Scroll to on open
          <select
            @change=${(e: Event) =>
              this.fire("prefs-change", {
                prefs: {
                  ...this.prefs,
                  initialHour: Number((e.target as HTMLSelectElement).value),
                },
              })}
          >
            <option value="-1" ?selected=${this.prefs.initialHour < 0}>An hour before now</option>
            ${Array.from({ length: 24 }, (_, h) => h).map(
              (h) =>
                html`<option value=${h} ?selected=${h === this.prefs.initialHour}>
                  ${formatHour(h, this.use24h)}
                </option>`,
            )}
          </select>
        </label>

        <h3>Troubleshooting</h3>
        <div class="row">
          <button class="btn" @click=${() => this.fire("reapply")}>Apply schedule now</button>
          <span class="muted hint"
            >Sets every scheduled value that an entity doesn't currently have.</span
          >
        </div>
        ${
          errors.length
            ? html`<div class="errors">
                <div class="muted">Recent problems</div>
                <ul>
                  ${errors.slice(0, 20).map(
                    (e) =>
                      html`<li>
                        <span class="muted">${new Date(e.time).toLocaleString(this.language)}</span>
                        <b>${e.entity_id}</b>: ${e.message}
                      </li>`,
                  )}
                </ul>
              </div>`
            : html`<div class="muted">No recent problems.</div>`
        }
        <div class="muted hint">Punch Clock ${this.version}</div>
      </div>
      <button slot="actions" class="btn primary" @click=${() => this.fire("closed")}>Done</button>
    </pc-dialog>`;
  }

  static override styles = [
    controls,
    css`
      .form {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      h3 {
        margin: 8px 0 0;
        font-size: 1em;
        font-weight: 500;
      }
      .hint {
        font-size: 0.8em;
      }
      .errors ul {
        margin: 4px 0 0;
        padding-left: 18px;
        font-size: 0.85em;
        max-height: 200px;
        overflow: auto;
      }
      .errors li {
        margin-bottom: 4px;
      }
    `,
  ];
}
