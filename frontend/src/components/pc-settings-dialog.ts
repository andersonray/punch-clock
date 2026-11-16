import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import type { NotifyPhone, NotifyPriority, NotifyTestResult, Settings, Status } from "../types";
import { errorMessage, type PunchClockApi } from "../api";
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

const PRIORITIES: { value: NotifyPriority; label: string; hint: string }[] = [
  { value: "low", label: "Low", hint: "Arrives silently, without a sound or a pop-up." },
  { value: "normal", label: "Normal", hint: "Arrives like the app's other notifications." },
  {
    value: "high",
    label: "High",
    hint: "Pops up on the screen right away. On an iPhone it also breaks through Focus.",
  },
];

/** "Sent to Pixel 6. Couldn't send to Tablet: not connected." */
export function testSummary(result: NotifyTestResult, phones: NotifyPhone[]): string {
  const name = (service: string) => phones.find((p) => p.service === service)?.name ?? service;
  const parts: string[] = [];
  if (result.sent.length) parts.push(`Sent to ${result.sent.map(name).join(", ")}.`);
  for (const f of result.failed) parts.push(`Couldn't send to ${name(f.service)}: ${f.error}.`);
  return parts.join(" ");
}

/**
 * Settings: week start, units, debounce and failure notifications (stored in Home
 * Assistant), plus display preferences kept in this browser. Fires `settings-change`
 * ({ changes }), `prefs-change` ({ prefs }), `reapply` and `closed`. Lists the phones and
 * sends test notifications itself, with `api`.
 */
export class PcSettingsDialog extends LitElement {
  static override properties = {
    open: { type: Boolean },
    settings: { attribute: false },
    prefs: { attribute: false },
    status: { attribute: false },
    api: { attribute: false },
    language: {},
    use24h: { type: Boolean },
    version: {},
    _phones: { state: true },
    _testing: { state: true },
    _testResult: { state: true },
  };

  declare open: boolean;
  declare settings: Settings;
  declare prefs: LocalPrefs;
  declare status: Status | null;
  declare api: PunchClockApi | null;
  declare language: string;
  declare use24h: boolean;
  declare version: string;
  /** The phones that notifications can go to; null until they're loaded. */
  declare _phones: NotifyPhone[] | null;
  declare _testing: boolean;
  declare _testResult: string;

  constructor() {
    super();
    this.open = false;
    this.status = null;
    this.api = null;
    this.language = "en";
    this.use24h = false;
    this.version = "";
    this._phones = null;
    this._testing = false;
    this._testResult = "";
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) {
      this._testResult = "";
      void this.loadPhones();
    }
  }

  private async loadPhones(): Promise<void> {
    if (!this.api) return;
    try {
      this._phones = (await this.api.notifyPhones()).phones;
    } catch {
      this._phones = null;
    }
  }

  private async sendTest(): Promise<void> {
    if (!this.api) return;
    this._testing = true;
    this._testResult = "";
    try {
      this._testResult = testSummary(await this.api.notifyTest(), this._phones ?? []);
    } catch (err) {
      this._testResult = errorMessage(err);
    } finally {
      this._testing = false;
    }
  }

  private fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private change(changes: Partial<Settings>): void {
    this._testResult = "";
    this.fire("settings-change", { changes });
  }

  private renderNotifications() {
    const s = this.settings;
    const phones = this._phones ?? [];
    const gone = s.notify_target !== null && !phones.some((p) => p.service === s.notify_target);
    const priority = PRIORITIES.find((p) => p.value === s.notify_priority) ?? PRIORITIES[1]!;
    return html`<h3>Notifications</h3>
      <label class="toggle">
        <span class="switch">
          <input
            type="checkbox"
            class="notify-failures"
            .checked=${s.notify_failures}
            @change=${(e: Event) =>
              this.change({ notify_failures: (e.target as HTMLInputElement).checked })}
          />
          <span></span>
        </span>
        Notify a phone when a scheduled value can't be set
      </label>
      <span class="muted hint"
        >The notification names the entity, the block or tab default behind the value, and what went
        wrong.</span
      >
      ${
        s.notify_failures
          ? html`<label
                >Send to
                <select
                  class="notify-target"
                  @change=${(e: Event) => {
                    const value = (e.target as HTMLSelectElement).value;
                    this.change({ notify_target: value || null });
                  }}
                >
                  <option value="" ?selected=${s.notify_target === null}>Every phone</option>
                  ${phones.map(
                    (p) =>
                      html`<option value=${p.service} ?selected=${p.service === s.notify_target}>
                        ${p.name}
                      </option>`,
                  )}
                  ${
                    gone
                      ? html`<option value=${s.notify_target!} selected>
                          ${s.notify_target}${this._phones ? " (not found)" : ""}
                        </option>`
                      : nothing
                  }
                </select>
                <span class="muted hint"
                  >${
                    this._phones?.length === 0
                      ? "No phone has the Home Assistant app."
                      : "Phones with the Home Assistant app."
                  }</span
                >
              </label>
              <label
                >Priority
                <select
                  class="notify-priority"
                  @change=${(e: Event) =>
                    this.change({
                      notify_priority: (e.target as HTMLSelectElement).value as NotifyPriority,
                    })}
                >
                  ${PRIORITIES.map(
                    (p) =>
                      html`<option value=${p.value} ?selected=${p.value === s.notify_priority}>
                        ${p.label}
                      </option>`,
                  )}
                </select>
                <span class="muted hint">${priority.hint}</span>
              </label>
              <div class="row">
                <button
                  class="btn notify-test"
                  ?disabled=${this._testing}
                  @click=${() => void this.sendTest()}
                >
                  Send a test notification
                </button>
                ${
                  this._testResult
                    ? html`<span class="muted hint" role="status">${this._testResult}</span>`
                    : nothing
                }
              </div>`
          : nothing
      }`;
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

        ${this.renderNotifications()}

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
      label.toggle {
        flex-direction: row;
        align-items: center;
        gap: 10px;
        cursor: pointer;
      }
      label.toggle + .hint {
        /* The size of a hint inside a label (0.8em of the label's 0.85em). */
        font-size: 0.68em;
        margin-top: -10px;
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
