import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import type { Block, BlockInput, Tab } from "../types";
import { copyBehavior, toInput } from "../logic/model";
import {
  MINUTES_PER_DAY,
  dayName,
  displayDays,
  durationBetween,
  formatDuration,
  stopMinute,
} from "../logic/time";
import { controls } from "../styles";
import "./pc-dialog";
import "./pc-time-input";

/**
 * Duplicate a block to one or more days, optionally into another tab. Fires
 * `duplicate` ({ blocks: BlockInput[] }) and `closed`.
 */
export class PcDuplicateDialog extends LitElement {
  static override properties = {
    open: { type: Boolean },
    source: { attribute: false },
    tabs: { attribute: false },
    weekStart: { type: Number },
    language: {},
    use24h: { type: Boolean },
    _days: { state: true },
    _start: { state: true },
    _stop: { state: true },
    _tabId: { state: true },
  };

  declare open: boolean;
  declare source: Block | null;
  declare tabs: Tab[];
  declare weekStart: number;
  declare language: string;
  declare use24h: boolean;
  declare _days: Set<number>;
  declare _start: number;
  declare _stop: number;
  declare _tabId: string;

  constructor() {
    super();
    this.open = false;
    this.source = null;
    this.tabs = [];
    this.weekStart = 6;
    this.language = "en";
    this.use24h = false;
    this._days = new Set();
    this._start = 0;
    this._stop = 60;
    this._tabId = "";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if ((changed.has("open") || changed.has("source")) && this.open && this.source) {
      this._days = new Set();
      this._start = this.source.start;
      this._stop = stopMinute(this.source.start, this.source.duration);
      this._tabId = this.source.tab_id;
    }
  }

  private toggleDay(day: number): void {
    const days = new Set(this._days);
    if (days.has(day)) days.delete(day);
    else days.add(day);
    this._days = days;
  }

  private confirm(): void {
    const source = this.source;
    if (!source || !this._days.size) return;
    const duration = durationBetween(this._start, this._stop);
    const order = displayDays(this.weekStart);
    const blocks: BlockInput[] = order
      .filter((day) => this._days.has(day))
      .map((day) => ({
        ...toInput(source),
        ...copyBehavior(source),
        tab_id: this._tabId,
        day,
        start: this._start,
        duration,
      }));
    this.dispatchEvent(new CustomEvent("duplicate", { detail: { blocks } }));
  }

  protected override render() {
    const duration = durationBetween(this._start, this._stop);
    const count = this._days.size;
    return html`<pc-dialog
      .open=${this.open}
      heading="Duplicate block"
      @closed=${() => this.dispatchEvent(new CustomEvent("closed"))}
    >
      <p class="muted">
        Copies the name, color, actions and conditions to new blocks on the days you pick.
      </p>
      <fieldset>
        <legend>Days</legend>
        <div class="days">
          ${displayDays(this.weekStart).map(
            (day) =>
              html`<label class="day ${this._days.has(day) ? "on" : ""}">
                <input
                  type="checkbox"
                  .checked=${this._days.has(day)}
                  @change=${() => this.toggleDay(day)}
                />
                ${dayName(day, this.language, "short")}
              </label>`,
          )}
        </div>
      </fieldset>
      <div class="times">
        <label
          >Start
          <pc-time-input
            label="Start"
            .value=${this._start}
            ?use24h=${this.use24h}
            @value-changed=${(e: CustomEvent<{ value: number }>) => (this._start = e.detail.value)}
          ></pc-time-input>
        </label>
        <label
          >Stop
          <pc-time-input
            label="Stop"
            .value=${this._stop}
            ?use24h=${this.use24h}
            @value-changed=${(e: CustomEvent<{ value: number }>) => (this._stop = e.detail.value)}
          ></pc-time-input>
        </label>
        ${
          this.tabs.length > 1
            ? html`<label
                >Tab
                <select
                  @change=${(e: Event) => (this._tabId = (e.target as HTMLSelectElement).value)}
                >
                  ${this.tabs.map(
                    (t) =>
                      html`<option value=${t.id} ?selected=${t.id === this._tabId}>
                        ${t.name}
                      </option>`,
                  )}
                </select>
              </label>`
            : nothing
        }
      </div>
      <div class="muted">
        ${formatDuration(duration)}${this._start + duration > MINUTES_PER_DAY ? " · ends the next day" : ""}
      </div>
      <button
        slot="actions"
        class="btn"
        @click=${() => this.dispatchEvent(new CustomEvent("closed"))}
      >
        Cancel
      </button>
      <button slot="actions" class="btn primary" ?disabled=${!count} @click=${() => this.confirm()}>
        ${count > 1 ? `Create ${count} blocks` : "Create block"}
      </button>
    </pc-dialog>`;
  }

  static override styles = [
    controls,
    css`
      p {
        margin: 0 0 12px;
      }
      fieldset {
        border: none;
        padding: 0;
        margin: 0 0 12px;
      }
      legend {
        padding: 0;
        margin-bottom: 6px;
        color: var(--pc-text-2);
        font-size: 0.85em;
      }
      .days {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .day {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px 10px;
        border: 1px solid var(--pc-divider);
        border-radius: 16px;
        color: var(--pc-text);
        font-size: 0.95em;
        cursor: pointer;
      }
      .day.on {
        border-color: var(--pc-primary);
        background: color-mix(in srgb, var(--pc-primary) 14%, transparent);
      }
      .day input {
        margin: 0;
      }
      .times {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 8px;
        margin-bottom: 8px;
      }
      .times label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `,
  ];
}
