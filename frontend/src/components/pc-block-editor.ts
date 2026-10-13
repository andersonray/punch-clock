import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { PunchClockApi } from "../api";
import { errorMessage } from "../api";
import type { Action, Block, Config, ExplainNode, Group, HomeAssistant, Status } from "../types";
import {
  PALETTE,
  actionProblems,
  blockLabel,
  conditionEntities,
  conditionProblems,
  copyBehavior,
  feedbackEntities,
  findConflicts,
  friendlyName,
  newEntityAction,
  newId,
} from "../logic/model";
import {
  MINUTES_PER_DAY,
  dayName,
  displayDays,
  durationBetween,
  formatDuration,
  formatRange,
  parseTimeInput,
  stopMinute,
  toTimeInput,
} from "../logic/time";
import { controls } from "../styles";
import {
  icon,
  mdiClose,
  mdiContentCopy,
  mdiDelete,
  mdiEyedropper,
  mdiFlash,
  mdiPlus,
} from "../icons";
import "./pc-action-editor";
import "./pc-condition-editor";

/**
 * Side panel (full screen when narrow) for editing one block. Works on a draft;
 * Save writes it. Events: `close-editor`, `delete-block`, `duplicate-block`
 * ({ block }), `start-eyedropper`.
 */
export class PcBlockEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    block: { attribute: false },
    config: { attribute: false },
    status: { attribute: false },
    api: { attribute: false },
    temperatureUnit: {},
    use24h: { type: Boolean },
    language: {},
    picking: { type: Boolean },
    _draft: { state: true },
    _saving: { state: true },
    _error: { state: true },
    _explain: { state: true },
  };

  declare hass: HomeAssistant;
  declare block: Block;
  declare config: Config;
  declare status: Status | null;
  declare api: PunchClockApi;
  declare temperatureUnit: string;
  declare use24h: boolean;
  declare language: string;
  declare picking: boolean;
  declare _draft: Block;
  declare _saving: boolean;
  declare _error: string;
  declare _explain: ExplainNode | null;

  private baseline = "";
  private evaluateTimer = 0;

  constructor() {
    super();
    this.status = null;
    this.temperatureUnit = "°C";
    this.use24h = false;
    this.language = "en";
    this.picking = false;
    this._saving = false;
    this._error = "";
    this._explain = null;
  }

  /** True if the draft differs from the last saved version. */
  get dirty(): boolean {
    return !!this._draft && JSON.stringify(this._draft) !== this.baseline;
  }

  /** Replace the draft's actions and conditions with copies from another block. */
  applyBehavior(source: Block): void {
    this.patch({ ...copyBehavior(source) });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.evaluateTimer);
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("block") && this.block) {
      const previous = changed.get("block") as Block | undefined;
      const switched = !previous || previous.id !== this.block.id;
      if (!this._draft || switched || !this.dirty) {
        this._draft = structuredClone(this.block);
        this.baseline = JSON.stringify(this.block);
        this._error = "";
        if (switched) this._explain = null;
        this.scheduleEvaluate();
      }
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    // Re-evaluate the conditions when an entity they use changes state.
    const oldHass = changed.get("hass") as HomeAssistant | undefined;
    if (oldHass && this._draft) {
      for (const entityId of conditionEntities(this._draft.conditions)) {
        if (oldHass.states[entityId] !== this.hass.states[entityId]) {
          this.scheduleEvaluate();
          break;
        }
      }
    }
  }

  private patch(changes: Partial<Block>): void {
    this._draft = { ...this._draft, ...changes };
    this._error = "";
    if ("conditions" in changes) this.scheduleEvaluate();
  }

  private scheduleEvaluate(): void {
    window.clearTimeout(this.evaluateTimer);
    this.evaluateTimer = window.setTimeout(() => void this.evaluate(), 300);
  }

  private async evaluate(): Promise<void> {
    const conditions = this._draft?.conditions;
    if (!conditions || conditionProblems(conditions).length) return;
    try {
      this._explain = await this.api.evaluate(conditions);
    } catch {
      this._explain = null;
    }
  }

  private fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private async save(): Promise<void> {
    const draft = this._draft;
    const problems = [...actionProblems(draft.actions), ...conditionProblems(draft.conditions)];
    if (problems.length) {
      this._error = problems.join(" ");
      return;
    }
    this._saving = true;
    try {
      await this.api.updateBlock(draft.id, {
        name: draft.name.trim(),
        color: draft.color,
        day: draft.day,
        start: draft.start,
        duration: draft.duration,
        actions: draft.actions,
        conditions: draft.conditions,
      });
      this.baseline = JSON.stringify(draft);
      this._error = "";
    } catch (err) {
      this._error = errorMessage(err);
    } finally {
      this._saving = false;
    }
  }

  private revert(): void {
    this._draft = structuredClone(this.block);
    this._error = "";
    this.scheduleEvaluate();
  }

  // --- Sections ----------------------------------------------------------------

  private statusLine(): TemplateResult {
    const tab = this.config.tabs.find((t) => t.id === this._draft.tab_id);
    const tabState = this.status?.tabs[this._draft.tab_id];
    const state = this.status?.blocks[this.block.id];
    let text = "Not running now.";
    let kind = "idle";
    if (!this.config.settings.enabled) {
      text = "Punch Clock is paused, so nothing is being set.";
      kind = "warn";
    } else if (tab && !tab.enabled) {
      text = `The "${tab.name}" tab is turned off.`;
      kind = "warn";
    } else if (state?.active) {
      text = "Running now.";
      kind = "on";
    } else if (state?.in_window && tabState && !tabState.conditions_met) {
      text = "In its time window, but the tab's conditions are false.";
      kind = "warn";
    } else if (state?.in_window) {
      text = "In its time window, but its conditions are false.";
      kind = "warn";
    }
    return html`<div class="status ${kind}">${text}</div>`;
  }

  private renderWhen(): TemplateResult {
    const d = this._draft;
    const days = displayDays(this.config.settings.week_start);
    const stop = stopMinute(d.start, d.duration);
    const nextDay = d.start + d.duration > MINUTES_PER_DAY;
    return html`<section>
      <h3>When</h3>
      <div class="when">
        <label
          >Day
          <select
            @change=${(e: Event) => this.patch({ day: Number((e.target as HTMLSelectElement).value) })}
          >
            ${days.map(
              (day) =>
                html`<option value=${day} ?selected=${day === d.day}>
                  ${dayName(day, this.language, "long")}
                </option>`,
            )}
          </select>
        </label>
        <label
          >Start
          <input
            type="time"
            step="60"
            .value=${toTimeInput(d.start)}
            @change=${(e: Event) => {
              const start = parseTimeInput((e.target as HTMLInputElement).value);
              if (start !== null) this.patch({ start, duration: durationBetween(start, stop) });
            }}
          />
        </label>
        <label
          >Stop
          <input
            type="time"
            step="60"
            .value=${toTimeInput(stop)}
            @change=${(e: Event) => {
              const value = parseTimeInput((e.target as HTMLInputElement).value);
              if (value !== null) this.patch({ duration: durationBetween(d.start, value) });
            }}
          />
        </label>
      </div>
      <div class="muted small">
        ${formatDuration(d.duration)}${
          nextDay ? html` · <span class="chip">ends the next day</span>` : nothing
        }
        ${d.duration === MINUTES_PER_DAY ? " · a stop time equal to the start means 24 hours" : nothing}
      </div>
    </section>`;
  }

  private renderAppearance(): TemplateResult {
    const d = this._draft;
    return html`<div class="swatches" role="radiogroup" aria-label="Color">
      ${PALETTE.map(
        (color) =>
          html`<button
            class="swatch ${color === d.color ? "selected" : ""}"
            style="--swatch:${color}"
            role="radio"
            aria-checked=${color === d.color ? "true" : "false"}
            aria-label=${color}
            @click=${() => this.patch({ color })}
          ></button>`,
      )}
      <input
        type="color"
        aria-label="Custom color"
        .value=${d.color}
        @change=${(e: Event) => this.patch({ color: (e.target as HTMLInputElement).value })}
      />
    </div>`;
  }

  private renderActions(): TemplateResult {
    const d = this._draft;
    const setAction = (i: number, action: Action | null) => {
      const actions = [...d.actions];
      if (action) actions[i] = action;
      else actions.splice(i, 1);
      this.patch({ actions });
    };
    const conflicts = findConflicts(this.config.blocks.map((b) => (b.id === d.id ? d : b))).get(
      d.id,
    );
    return html`<section>
      <h3>${icon(mdiFlash, 18)} Actions</h3>
      <p class="muted small">What to set while this block is running.</p>
      ${d.actions.map(
        (action, i) =>
          html`<pc-action-editor
            .hass=${this.hass}
            .action=${action}
            .temperatureUnit=${this.temperatureUnit}
            @action-changed=${(e: CustomEvent<{ action: Action }>) => setAction(i, e.detail.action)}
            @remove=${() => setAction(i, null)}
          ></pc-action-editor>`,
      )}
      <div class="row wrap">
        <button
          class="btn"
          @click=${() => this.patch({ actions: [...d.actions, newEntityAction()] })}
        >
          ${icon(mdiPlus, 18)} Entity action
        </button>
        <button
          class="btn"
          @click=${() =>
            this.patch({
              actions: [
                ...d.actions,
                { id: newId("a"), type: "service", service: "", target: {}, data: {} },
              ],
            })}
        >
          ${icon(mdiPlus, 18)} Service call
        </button>
      </div>
      ${conflicts?.map((c) => {
        const other = this.config.blocks.find((b) => b.id === c.otherId);
        if (!other) return nothing;
        const what = c.keys
          .map((k) => {
            const [entity, key] = k.split("|");
            return k.startsWith("service:")
              ? "the same service"
              : `${friendlyName(entity ?? "", this.hass.states)} ${key}`;
          })
          .join(", ");
        return html`<div class="warning-text">
          Overlaps with "${blockLabel(other, this.hass.states)}"
          (${dayName(other.day, this.language)}
          ${formatRange(other.start, other.duration, this.use24h)}), and both set ${what}. While
          both run, the one that started most recently wins.
        </div>`;
      })}
    </section>`;
  }

  private renderConditions(): TemplateResult {
    const d = this._draft;
    const feedback = feedbackEntities(d.conditions, this.config);
    return html`<section>
      <h3>Conditions</h3>
      <p class="muted small">This block only runs while these are true.</p>
      <pc-condition-editor
        .hass=${this.hass}
        .group=${d.conditions}
        .explain=${this._explain}
        @group-changed=${(e: CustomEvent<{ group: Group }>) => this.patch({ conditions: e.detail.group })}
      ></pc-condition-editor>
      ${
        feedback.length
          ? html`<div class="warning-text">
              ${feedback.map((e) => friendlyName(e, this.hass.states)).join(", ")}
              ${feedback.length === 1 ? "is" : "are"} also set by this schedule. Conditions on
              entities the schedule controls can make blocks switch on and off repeatedly.
            </div>`
          : nothing
      }
    </section>`;
  }

  protected override render() {
    if (!this._draft) return nothing;
    const d = this._draft;
    const dirty = this.dirty;
    return html`<div class="editor" style="--block-color:${d.color}">
      <header>
        <input
          class="name grow"
          aria-label="Block name"
          placeholder=${blockLabel({ ...d, name: "" }, this.hass.states)}
          .value=${d.name}
          @input=${(e: Event) => this.patch({ name: (e.target as HTMLInputElement).value })}
        />
        <button class="icon-btn" aria-label="Close" @click=${() => this.fire("close-editor")}>
          ${icon(mdiClose)}
        </button>
      </header>
      <div class="body">
        ${this.statusLine()} ${this.renderAppearance()} ${this.renderWhen()} ${this.renderActions()}
        ${this.renderConditions()}
      </div>
      <footer>
        ${this._error ? html`<div class="error-text full">${this._error}</div>` : nothing}
        <button
          class="icon-btn"
          aria-label="Delete block"
          title="Delete block"
          @click=${() => this.fire("delete-block")}
        >
          ${icon(mdiDelete)}
        </button>
        <button
          class="icon-btn"
          aria-label="Duplicate"
          title="Duplicate to other days"
          @click=${() => this.fire("duplicate-block", { block: this._draft })}
        >
          ${icon(mdiContentCopy)}
        </button>
        <button
          class="icon-btn ${this.picking ? "picking" : ""}"
          aria-label="Copy actions and conditions from another block"
          aria-pressed=${this.picking ? "true" : "false"}
          title="Copy actions and conditions from another block"
          @click=${() => this.fire("start-eyedropper")}
        >
          ${icon(mdiEyedropper)}
        </button>
        <span class="grow"></span>
        ${
          dirty ? html`<button class="btn" @click=${() => this.revert()}>Discard</button>` : nothing
        }
        <button
          class="btn primary"
          ?disabled=${!dirty || this._saving}
          @click=${() => void this.save()}
        >
          ${this._saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </footer>
    </div>`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        height: 100%;
        background: var(--pc-card);
      }
      .editor {
        display: flex;
        flex-direction: column;
        height: 100%;
        border-top: 4px solid var(--block-color);
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 8px 6px 16px;
      }
      .name {
        font-size: 1.15em;
        font-weight: 500;
        border-color: transparent;
      }
      .name:hover,
      .name:focus {
        border-color: var(--pc-divider);
      }
      .body {
        flex: 1;
        overflow: auto;
        padding: 0 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      h3 {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        font-size: 1em;
        font-weight: 500;
      }
      p {
        margin: 0;
      }
      .small {
        font-size: 0.85em;
      }
      .status {
        padding: 8px 12px;
        border-radius: var(--pc-radius-sm);
        background: var(--pc-bg-2);
        font-size: 0.9em;
      }
      .status.on {
        background: color-mix(in srgb, var(--pc-success) 15%, transparent);
      }
      .status.warn {
        background: color-mix(in srgb, var(--pc-warning) 15%, transparent);
      }
      .when {
        display: grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        gap: 8px;
      }
      .when label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .swatches {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .swatch {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        background: var(--swatch);
        cursor: pointer;
      }
      .swatch.selected {
        border-color: var(--pc-text);
        box-shadow: inset 0 0 0 2px var(--pc-card);
      }
      input[type="color"] {
        width: 32px;
        height: 28px;
        padding: 0;
        border: none;
        background: none;
      }
      .wrap {
        flex-wrap: wrap;
      }
      footer {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 10px 12px;
        border-top: 1px solid var(--pc-divider);
      }
      .full {
        flex-basis: 100%;
        padding: 0 4px 6px;
      }
      .icon-btn.picking {
        background: color-mix(in srgb, var(--pc-primary) 20%, transparent);
        color: var(--pc-primary);
      }
      @media (max-width: 480px) {
        .when {
          grid-template-columns: 1fr 1fr;
        }
        .when label:first-child {
          grid-column: 1 / -1;
        }
      }
    `,
  ];
}
