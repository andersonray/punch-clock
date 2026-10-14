import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { PunchClockApi } from "../api";
import { errorMessage } from "../api";
import type {
  Action,
  Block,
  BlockUpdate,
  Config,
  ExplainNode,
  Group,
  HomeAssistant,
  Status,
} from "../types";
import {
  PALETTE,
  actionProblems,
  behaviorKey,
  blockGroup,
  blockLabel,
  conditionEntities,
  conditionProblems,
  copyBehavior,
  feedbackEntities,
  findConflicts,
  friendlyName,
  groupMembers,
  newEntityAction,
  newId,
  sortWhens,
  weekMinute,
  whenOf,
  type When,
} from "../logic/model";
import {
  MINUTES_PER_DAY,
  dayName,
  displayDays,
  durationBetween,
  formatDuration,
  formatRange,
  stopMinute,
} from "../logic/time";
import type { TemperatureUnits } from "../logic/capabilities";
import { controls } from "../styles";
import {
  icon,
  mdiCallSplit,
  mdiClose,
  mdiContentCopy,
  mdiDelete,
  mdiEyedropper,
  mdiFlash,
  mdiPlus,
} from "../icons";
import "./pc-action-editor";
import "./pc-condition-editor";
import "./pc-confirm-dialog";
import "./pc-time-input";
import type { PcConfirmDialog } from "./pc-confirm-dialog";

const NAME_NEEDED =
  "Give the block a name to save it with more than one time. Blocks are grouped by name and color.";

/** Times added with "Add a time" get a temporary ID until Save creates their blocks. */
const isNew = (id: string): boolean => id.startsWith("new_");

/** The editor's unsaved name, color and times, for showing in the calendar before saving. */
export interface BlockPreview {
  name: string;
  color: string;
  /** Every block of the group, with its (unsaved) day and times; new ones have `new_` IDs. */
  whens: When[];
}

/**
 * Side panel (full screen when narrow) for editing a block and the rest of its group:
 * blocks in the same tab with the same name and color. They share the name, color,
 * actions and conditions, and each has its own day and times. Works on a draft; Save
 * writes every block of the group at once, and creates the times added with "Add a time".
 *
 * Events: `close-editor`, `delete-block` ({ blockIds }: the group), `delete-when`
 * ({ blockId }: one block of the group), `duplicate-block` ({ block }), `split-block`
 * ({ blockId }), `start-eyedropper`, `preview-changed`
 * (BlockPreview: color, days and times as soon as they change, the name once the name
 * field loses focus).
 */
export class PcBlockEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    block: { attribute: false },
    config: { attribute: false },
    status: { attribute: false },
    api: { attribute: false },
    units: { attribute: false },
    use24h: { type: Boolean },
    language: {},
    picking: { type: Boolean },
    _draft: { state: true },
    _whens: { state: true },
    _saving: { state: true },
    _error: { state: true },
    _explain: { state: true },
  };

  declare hass: HomeAssistant;
  declare block: Block;
  declare config: Config;
  declare status: Status | null;
  declare api: PunchClockApi;
  declare units: TemperatureUnits;
  declare use24h: boolean;
  declare language: string;
  declare picking: boolean;
  /** The block being edited, with the group's unsaved name, color, actions and conditions. */
  declare _draft: Block;
  /** When each block of the group runs, in calendar order; includes the draft's block. */
  declare _whens: When[];
  declare _saving: boolean;
  declare _error: string;
  declare _explain: ExplainNode | null;

  private baseline = "";
  /** The group as it was opened. Its blocks stay in it when the name or color changes. */
  private originalIds = new Set<string>();
  /** Blocks that joined the group since: by the eyedropper, or by saving with their name. */
  private joinedIds = new Set<string>();
  /** The actions and conditions the group's blocks are expected to share (see behaviorKey). */
  private reference = "";
  private evaluateTimer = 0;
  /** The name shown in the calendar; follows the name field when it loses focus. */
  private previewName = "";
  private lastPreview = "";

  constructor() {
    super();
    this.status = null;
    this.units = { schedule: "°C", ha: "°C" };
    this.use24h = false;
    this.language = "en";
    this.picking = false;
    this._whens = [];
    this._saving = false;
    this._error = "";
    this._explain = null;
  }

  /** True if the draft differs from the last saved version. */
  get dirty(): boolean {
    return !!this._draft && this.snapshot() !== this.baseline;
  }

  /**
   * Replace the draft's name, color, actions and conditions with copies from another
   * block. That block's group (if it's in the same tab) then joins this one, replacing
   * any group an earlier copy joined.
   */
  applyFrom(source: Block): void {
    this.copyFrom(source);
    const sameTab = source.tab_id === this._draft.tab_id;
    const group = sameTab
      ? groupMembers(this.config.blocks, source.tab_id, source.name, source.color)
      : [];
    this.setJoined(group.map((b) => b.id));
  }

  /** Forget a block of the group that's being deleted, keeping any unsaved changes. */
  removeWhen(blockId: string): void {
    const remove = (whens: When[]) => whens.filter((w) => w.id !== blockId);
    this.originalIds.delete(blockId);
    this.joinedIds.delete(blockId);
    const [shared, whens] = JSON.parse(this.baseline) as [unknown, When[]];
    this.baseline = JSON.stringify([shared, remove(whens)]);
    this._whens = remove(this._whens);
  }

  /** Throw away unsaved changes. */
  discard(): void {
    this.load();
    this.scheduleEvaluate();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.evaluateTimer);
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!(changed.has("block") || changed.has("config")) || !this.block || !this.config) return;
    const switched = this._draft?.id !== this.block.id;
    const inGroup = this._whens.some((w) => w.id === this.block.id);
    if (this.dirty && (!switched || inGroup)) {
      // Keep the unsaved changes. Another block of the group just becomes the current one.
      if (switched) this._draft = { ...this._draft, ...this.whenFor(this.block.id) };
      return;
    }
    this.load();
    if (switched && !inGroup) this._explain = null;
    this.scheduleEvaluate();
  }

  /** Start editing the selected block and its group as saved. */
  private load(): void {
    const group = blockGroup(this.config.blocks, this.block);
    this._draft = structuredClone(this.block);
    this._whens = sortWhens(group.map(whenOf), this.config.settings.week_start);
    this.originalIds = new Set(group.map((b) => b.id));
    this.joinedIds = new Set();
    this.reference = behaviorKey(this.block);
    this.previewName = this.block.name;
    this.baseline = this.snapshot();
    this._error = "";
  }

  /** Everything Save would write. The draft's own day and times are also in `whens`. */
  private snapshot(draft = this._draft, whens = this._whens): string {
    const { id: _id, seq: _seq, day: _day, start: _start, duration: _duration, ...shared } = draft;
    return JSON.stringify([shared, whens]);
  }

  private whenFor(blockId: string): When {
    return this._whens.find((w) => w.id === blockId)!;
  }

  private get confirm(): PcConfirmDialog {
    return this.renderRoot.querySelector("pc-confirm-dialog") as PcConfirmDialog;
  }

  private copyFrom(source: Block): void {
    this.previewName = source.name;
    this.reference = behaviorKey(source);
    this.patch({ ...copyBehavior(source), name: source.name, color: source.color });
  }

  /** Set the blocks that joined the group, on top of the ones it was opened with. */
  private setJoined(joined: Iterable<string>): void {
    this.joinedIds = new Set(joined);
    const blocks = this.config.blocks;
    const added = this._whens.filter((w) => isNew(w.id)).map((w) => w.id);
    const ids = new Set([this._draft.id, ...this.originalIds, ...this.joinedIds, ...added]);
    if (ids.size === this._whens.length && this._whens.every((w) => ids.has(w.id))) return;
    const current = new Map(this._whens.map((w) => [w.id, w]));
    const whens: When[] = [];
    for (const blockId of ids) {
      const saved = blocks.find((b) => b.id === blockId);
      const when = current.get(blockId) ?? (saved && whenOf(saved));
      if (when) whens.push(when);
    }
    this._whens = sortWhens(whens, this.config.settings.week_start);
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
    if (this._draft) {
      const preview: BlockPreview = {
        name: this.previewName,
        color: this._draft.color,
        whens: this._whens,
      };
      const key = JSON.stringify(preview);
      if (key !== this.lastPreview) {
        this.lastPreview = key;
        this.fire("preview-changed", preview);
      }
    }
  }

  private patch(changes: Partial<Block>): void {
    this._draft = { ...this._draft, ...changes };
    this._error = "";
    if ("conditions" in changes) this.scheduleEvaluate();
  }

  /**
   * Add another time to the group: the current row's start and stop, on the next day that
   * doesn't have a time starting then yet (so repeated clicks walk through the week). The
   * row goes in calendar order.
   */
  private addWhen(): void {
    const from = this.whenFor(this._draft.id);
    const days = [1, 2, 3, 4, 5, 6].map((n) => (from.day + n) % 7);
    const free = (day: number) => !this._whens.some((w) => w.day === day && w.start === from.start);
    const when = { ...from, id: newId("new"), day: days.find(free) ?? days[0]! };
    const weekStart = this.config.settings.week_start;
    const at = this._whens.findIndex((w) => weekMinute(w, weekStart) > weekMinute(when, weekStart));
    const whens = [...this._whens];
    whens.splice(at < 0 ? whens.length : at, 0, when);
    this._whens = whens;
    this._error = "";
  }

  private patchWhen(blockId: string, changes: Partial<When>): void {
    this._whens = this._whens.map((w) => (w.id === blockId ? { ...w, ...changes } : w));
    if (blockId === this._draft.id) this._draft = { ...this._draft, ...changes };
    this._error = "";
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

  /**
   * Saving with the name and color of another group in the tab joins that group, whose
   * blocks share their actions and conditions. Unless the draft's are the same already,
   * ask first, then copy that group's from its first block. Returns false if cancelled.
   */
  private async joinMatchingGroup(): Promise<boolean> {
    const { tab_id, name, color } = this._draft;
    const others = groupMembers(this.config.blocks, tab_id, name, color).filter(
      (b) => !this._whens.some((w) => w.id === b.id),
    );
    if (!others.length) return true;
    const behavior = behaviorKey(this._draft);
    if (others.some((b) => behaviorKey(b) !== behavior)) {
      const rest = this._whens.length - 1;
      const choice = await this.confirm.choose({
        heading: `Join the "${name.trim()}" group?`,
        text:
          `${others.length === 1 ? "Another block" : `${others.length} other blocks`} in this ` +
          `tab already ${others.length === 1 ? "has" : "have"} this name and color. Blocks ` +
          `with the same name and color are a group and share their actions and conditions. ` +
          `Replace the actions and conditions of this block` +
          (rest ? ` and the ${rest} other block(s) of its group` : "") +
          ` with the group's, and join it? To keep this block separate, cancel and change its ` +
          `name or color.`,
        choices: [{ value: "join", label: "Replace and join", kind: "danger" }],
      });
      if (choice !== "join") return false;
      this.copyFrom(others[0]!);
    }
    this.setJoined([...this.joinedIds, ...others.map((b) => b.id)]);
    return true;
  }

  /**
   * Save the draft to every block of the group that it changes. Returns false (and shows
   * why in the editor) if it couldn't be saved or saving was cancelled.
   */
  async save(): Promise<boolean> {
    if (!(await this.joinMatchingGroup())) return false;
    const draft = this._draft;
    const name = draft.name.trim();
    const problems = [...actionProblems(draft.actions), ...conditionProblems(draft.conditions)];
    if (this._whens.length > 1 && !name) problems.push(NAME_NEEDED);
    if (problems.length) {
      this._error = problems.join(" ");
      return false;
    }
    const behavior = behaviorKey(draft);
    const whens = this._whens;
    const { tab_id, color, actions, conditions } = draft;
    const added = whens.filter((w) => isNew(w.id));
    const updates: BlockUpdate[] = [];
    for (const when of whens) {
      if (isNew(when.id)) continue;
      const saved = this.config.blocks.find((b) => b.id === when.id);
      if (!saved) continue; // deleted meanwhile
      const unchanged =
        saved.name === name &&
        saved.color.toLowerCase() === draft.color.toLowerCase() &&
        saved.day === when.day &&
        saved.start === when.start &&
        saved.duration === when.duration &&
        behaviorKey(saved) === behavior;
      if (unchanged) continue;
      const { day, start, duration } = when;
      updates.push({
        block_id: when.id,
        changes: { name, color, day, start, duration, actions, conditions },
      });
    }
    this._saving = true;
    try {
      // Update first: if creating then fails, saving again only creates.
      if (updates.length) await this.api.updateBlocks(updates);
      const created = added.length
        ? (
            await this.api.createBlocks(
              added.map(({ day, start, duration }) => ({
                tab_id,
                name,
                color,
                actions,
                conditions,
                day,
                start,
                duration,
              })),
            )
          ).blocks
        : [];
      // The added times are blocks now.
      const ids = new Map(added.map((w, i) => [w.id, created[i]!.id]));
      const withIds = (list: When[]) => list.map((w) => ({ ...w, id: ids.get(w.id) ?? w.id }));
      const savedWhens = withIds(whens);
      this._whens = withIds(this._whens);
      // What was saved is the new baseline; edits made while saving stay unsaved.
      const saved = { ...draft, name };
      if (this._draft === draft) {
        this._draft = saved;
        this.previewName = name;
      }
      this.originalIds = new Set(savedWhens.map((w) => w.id));
      this.joinedIds = new Set();
      this.reference = behavior;
      this.baseline = this.snapshot(saved, savedWhens);
      this._error = "";
      return true;
    } catch (err) {
      this._error = errorMessage(err);
      return false;
    } finally {
      this._saving = false;
    }
  }

  // --- Sections ----------------------------------------------------------------

  private statusLine(): TemplateResult {
    const tab = this.config.tabs.find((t) => t.id === this._draft.tab_id);
    const tabState = this.status?.tabs[this._draft.tab_id];
    const states = this._whens.flatMap((w) => this.status?.blocks[w.id] ?? []);
    const state = states.length
      ? {
          active: states.some((s) => s.active),
          in_window: states.some((s) => s.in_window),
          conditions_met: states.every((s) => s.conditions_met),
        }
      : undefined;
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
    } else if (state && !state.conditions_met) {
      text = "Not running now. Its conditions aren't met right now either, so it wouldn't run.";
      kind = "warn";
    }
    return html`<div class="status ${kind}">${text}</div>`;
  }

  private renderWhen(): TemplateResult {
    const whens = this._whens;
    const multiple = whens.length > 1;
    const splittable = whens.filter((w) => !isNew(w.id)).length > 1;
    const days = displayDays(this.config.settings.week_start);
    return html`<section>
      <h3>When</h3>
      ${
        multiple
          ? html`<p class="muted small">
              Blocks with the same name and color are a group. They share everything here except
              their times. To give one its own, split it off.
            </p>`
          : nothing
      }
      <div class="whens ${multiple ? "multiple" : ""}">
        <div class="when-row head" aria-hidden="true">
          ${multiple ? html`<span></span>` : nothing}<span>Day</span><span>Start</span
          ><span>Stop</span>
        </div>
        ${repeat(
          whens,
          (w) => w.id,
          (w) => this.renderWhenRow(w, days, multiple, splittable),
        )}
      </div>
      ${
        multiple && !this._draft.name.trim()
          ? html`<div class="warning-text">${NAME_NEEDED}</div>`
          : nothing
      }
      <div>
        <button class="btn text" @click=${() => this.addWhen()}>
          ${icon(mdiPlus, 18)} Add a time
        </button>
      </div>
    </section>`;
  }

  private renderWhenRow(
    w: When,
    days: number[],
    multiple: boolean,
    splittable: boolean,
  ): TemplateResult {
    const stop = stopMinute(w.start, w.duration);
    const nextDay = w.start + w.duration > MINUTES_PER_DAY;
    const current = multiple && w.id === this._draft.id;
    const label = `${dayName(w.day, this.language, "long")} ${formatRange(w.start, w.duration, this.use24h)}`;
    let first: TemplateResult | typeof nothing = nothing;
    if (isNew(w.id)) {
      first = html`<button
        class="icon-btn small"
        aria-label=${`Remove ${label}`}
        title="Remove this time"
        @click=${() => (this._whens = this._whens.filter((x) => x.id !== w.id))}
      >
        ${icon(mdiClose, 18)}
      </button>`;
    } else if (splittable) {
      first = html`<div class="row-tools">
        <button
          class="icon-btn small"
          aria-label=${`Split ${label} into its own block`}
          title="Split into its own block"
          @click=${() => this.fire("split-block", { blockId: w.id })}
        >
          ${icon(mdiCallSplit, 18)}
        </button>
        <button
          class="icon-btn small delete"
          aria-label=${`Delete ${label}`}
          title="Delete this block"
          @click=${() => this.fire("delete-when", { blockId: w.id })}
        >
          ${icon(mdiDelete, 18)}
        </button>
      </div>`;
    } else if (multiple) {
      first = html`<span></span>`;
    }
    return html`<div class="when-row ${current ? "current" : ""}">
      ${first}
      <select
        aria-label="Day"
        @change=${(e: Event) =>
          this.patchWhen(w.id, { day: Number((e.target as HTMLSelectElement).value) })}
      >
        ${days.map(
          (day) =>
            html`<option value=${day} ?selected=${day === w.day}>
              ${dayName(day, this.language, "long")}
            </option>`,
        )}
      </select>
      <pc-time-input
        label="Start"
        .value=${w.start}
        ?use24h=${this.use24h}
        @value-changed=${(e: CustomEvent<{ value: number }>) =>
          this.patchWhen(w.id, {
            start: e.detail.value,
            duration: durationBetween(e.detail.value, stop),
          })}
      ></pc-time-input>
      <pc-time-input
        label="Stop"
        .value=${stop}
        ?use24h=${this.use24h}
        @value-changed=${(e: CustomEvent<{ value: number }>) =>
          this.patchWhen(w.id, { duration: durationBetween(w.start, e.detail.value) })}
      ></pc-time-input>
      <div class="when-info muted small">
        ${formatDuration(w.duration)}${
          nextDay ? html` · <span class="chip">ends the next day</span>` : nothing
        }
        ${w.duration === MINUTES_PER_DAY ? " · a stop time equal to the start means 24 hours" : nothing}
      </div>
    </div>`;
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
    const conflicts = this.groupConflicts();
    return html`<section>
      <h3>${icon(mdiFlash, 18)} Actions</h3>
      <p class="muted small">What to set while this block is running.</p>
      ${d.actions.map(
        (action, i) =>
          html`<pc-action-editor
            .hass=${this.hass}
            .action=${action}
            .units=${this.units}
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
      ${conflicts.map((c) => {
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

  /** Blocks outside the group that overlap one of its blocks and set the same things. */
  private groupConflicts(): { otherId: string; keys: string[] }[] {
    const d = this._draft;
    const members = new Map(this._whens.map((w) => [w.id, w]));
    const blocks = this.config.blocks.map((b) => {
      const when = members.get(b.id);
      return when ? { ...b, ...d, ...when, seq: b.seq } : b;
    });
    for (const when of this._whens) if (isNew(when.id)) blocks.push({ ...d, ...when });
    const byOther = new Map<string, Set<string>>();
    for (const [id, list] of findConflicts(blocks)) {
      if (!members.has(id)) continue;
      for (const c of list) {
        if (members.has(c.otherId)) continue;
        const keys = byOther.get(c.otherId) ?? new Set<string>();
        c.keys.forEach((k) => keys.add(k));
        byOther.set(c.otherId, keys);
      }
    }
    return [...byOther].map(([otherId, keys]) => ({ otherId, keys: [...keys] }));
  }

  /** How many other blocks of the group don't do what the draft started from. */
  private differingCount(): number {
    return this._whens.filter((w) => {
      if (w.id === this._draft.id) return false;
      const saved = this.config.blocks.find((b) => b.id === w.id);
      return saved !== undefined && behaviorKey(saved) !== this.reference;
    }).length;
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
    const differing = this.differingCount();
    return html`<div class="editor" style="--block-color:${d.color}">
      <header>
        <input
          class="name grow"
          aria-label="Block name"
          placeholder=${blockLabel({ ...d, name: "" }, this.hass.states)}
          .value=${d.name}
          @input=${(e: Event) => this.patch({ name: (e.target as HTMLInputElement).value })}
          @change=${(e: Event) => {
            this.previewName = (e.target as HTMLInputElement).value;
            this.requestUpdate();
          }}
        />
        <button class="icon-btn" aria-label="Close" @click=${() => this.fire("close-editor")}>
          ${icon(mdiClose)}
        </button>
      </header>
      <div class="body">
        ${this.statusLine()} ${this.renderAppearance()} ${this.renderWhen()}
        ${
          differing
            ? html`<div class="warning-text">
                ${
                  differing === 1
                    ? "One block of this group has different actions or conditions."
                    : `${differing} blocks of this group have different actions or conditions.`
                }
                Saving gives them all the ones shown here.
              </div>`
            : nothing
        }
        ${this.renderActions()} ${this.renderConditions()}
      </div>
      <footer>
        ${this._error ? html`<div class="error-text full">${this._error}</div>` : nothing}
        <button
          class="icon-btn"
          aria-label="Delete block"
          title="Delete block"
          @click=${() => this.fire("delete-block", { blockIds: this._whens.map((w) => w.id) })}
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
          dirty
            ? html`<button class="btn" @click=${() => this.discard()}>Discard</button>`
            : nothing
        }
        <button
          class="btn primary"
          ?disabled=${!dirty || this._saving}
          @click=${() => void this.save()}
        >
          ${this._saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </button>
      </footer>
      <pc-confirm-dialog></pc-confirm-dialog>
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
      .whens {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.85em;
        --columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
      }
      .whens.multiple {
        --columns: 30px minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
      }
      .when-row {
        display: grid;
        grid-template-columns: var(--columns);
        align-items: center;
        gap: 4px 8px;
        border-radius: var(--pc-radius-sm);
      }
      .whens.multiple .when-row:not(.head) {
        padding: 4px 4px 4px 0;
      }
      .when-row.current {
        background: color-mix(in srgb, var(--block-color) 14%, transparent);
      }
      .when-row.head {
        color: var(--pc-text-2);
      }
      .when-info {
        grid-column: 1 / -1;
      }
      .whens.multiple .when-info {
        grid-column: 2 / -1;
      }
      /* Split above delete, next to the row's fields and its duration line. */
      .row-tools {
        grid-row: span 2;
        display: flex;
        flex-direction: column;
        align-self: start;
      }
      .row-tools .delete:hover {
        color: var(--pc-error);
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
        .whens {
          --columns: minmax(0, 1fr) minmax(0, 1fr);
        }
        .whens.multiple {
          --columns: 30px minmax(0, 1fr) minmax(0, 1fr);
        }
        .when-row.head {
          display: none;
        }
        .when-row select {
          grid-column: 1 / -1;
        }
        .whens.multiple .when-row select {
          grid-column: 2 / -1;
        }
        .whens.multiple .when-row pc-time-input:nth-of-type(1) {
          grid-column: 2;
        }
      }
    `,
  ];
}
