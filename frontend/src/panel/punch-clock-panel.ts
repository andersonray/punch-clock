import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { PunchClockApi, errorMessage, type PushEvent } from "../api";
import type {
  Block,
  BlockInput,
  Config,
  HomeAssistant,
  Info,
  PanelInfo,
  Settings,
  Status,
  Tab,
} from "../types";
import {
  blockGroup,
  blockLabel,
  countConditions,
  emptyGroup,
  entityCounts,
  nextColor,
  splitColor,
  splitName,
} from "../logic/model";
import { MINUTES_PER_DAY, dayName, formatRange, nowIn, uses24h } from "../logic/time";
import { themeTokens, controls } from "../styles";
import { icon, mdiAlertCircleOutline, mdiCog, mdiMenu, mdiPlus } from "../icons";
import type { TemperatureUnits } from "../logic/capabilities";
import type { PcBlockEditor, BlockPreview } from "../components/pc-block-editor";
import type { PcConfirmDialog } from "../components/pc-confirm-dialog";
import type { CreateBlockDetail, ResizeBlockDetail } from "../components/pc-week-view";
import type { TabMenuAction } from "../components/pc-tab-bar";
import { HOUR_HEIGHTS, type LocalPrefs } from "../components/pc-settings-dialog";

declare const __PC_VERSION__: string;

type BlockTimes = Pick<Block, "day" | "start" | "duration">;

const sameTimes = (a: BlockTimes, b: BlockTimes): boolean =>
  a.day === b.day && a.start === b.start && a.duration === b.duration;

const PREFS_KEY = "punch-clock:prefs";
const DEFAULT_PREFS: LocalPrefs = { hourHeight: 48, initialHour: -1, editorWidth: 460 };
/** The block editor can't get narrower than this... */
const MIN_EDITOR_WIDTH = 340;
/** ...and always leaves at least this much of the calendar visible. */
const MIN_CALENDAR_WIDTH = 160;
const RESIZE_STEP = 32;

function loadPrefs(): LocalPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<LocalPrefs>;
    return {
      hourHeight: HOUR_HEIGHTS.includes(Number(raw.hourHeight))
        ? Number(raw.hourHeight)
        : DEFAULT_PREFS.hourHeight,
      initialHour: Number.isInteger(raw.initialHour)
        ? Number(raw.initialHour)
        : DEFAULT_PREFS.initialHour,
      editorWidth:
        Number(raw.editorWidth) >= MIN_EDITOR_WIDTH
          ? Number(raw.editorWidth)
          : DEFAULT_PREFS.editorWidth,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** The Punch Clock sidebar panel. Home Assistant sets `hass`, `narrow`, `route` and `panel`. */
export class PunchClockPanel extends LitElement {
  static override properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    route: { attribute: false },
    panel: { attribute: false },
    _config: { state: true },
    _status: { state: true },
    _info: { state: true },
    _activeTabId: { state: true },
    _selectedId: { state: true },
    _picking: { state: true },
    _duplicateSource: { state: true },
    _tabDialog: { state: true },
    _settingsOpen: { state: true },
    _toast: { state: true },
    _loadError: { state: true },
    _prefs: { state: true },
    _preview: { state: true },
    _savingTimes: { state: true },
    _resizing: { state: true },
    _filter: { state: true },
  };

  declare hass: HomeAssistant;
  declare narrow: boolean;
  declare route: unknown;
  declare panel: PanelInfo;
  declare _config: Config | null;
  declare _status: Status | null;
  declare _info: Info | null;
  declare _activeTabId: string;
  declare _selectedId: string | null;
  declare _picking: boolean;
  declare _duplicateSource: Block | null;
  declare _tabDialog: { tab: Tab | null } | null;
  declare _settingsOpen: boolean;
  declare _toast: string;
  declare _loadError: string;
  declare _prefs: LocalPrefs;
  /** Unsaved name, color and times of the group being edited, shown in the calendar right away. */
  declare _preview: BlockPreview | null;
  /** New times of blocks dragged in the calendar, shown until the saved config has them. */
  declare _savingTimes: Record<string, BlockTimes>;
  declare _resizing: boolean;
  /**
   * Entities chosen in the filter row: the calendar shows only blocks acting on them. Kept
   * across tabs; a tab whose blocks don't act on any of them shows everything.
   */
  declare _filter: string[];

  private readonly api = new PunchClockApi(() => this.hass);
  private unsubscribe: (() => Promise<void>) | null = null;
  private connecting = false;
  private toastTimer = 0;
  private viewCache: {
    config: Config;
    preview: BlockPreview | null;
    savingTimes: Record<string, BlockTimes>;
    result: Config;
  } | null = null;
  private selectionCache: string[] = [];
  private filterCache: string[] = [];
  private unitsCache: TemperatureUnits = { schedule: "°C", ha: "°C" };

  constructor() {
    super();
    this.narrow = false;
    this._config = null;
    this._status = null;
    this._info = null;
    this._activeTabId = "";
    this._selectedId = null;
    this._picking = false;
    this._duplicateSource = null;
    this._tabDialog = null;
    this._settingsOpen = false;
    this._toast = "";
    this._loadError = "";
    this._prefs = loadPrefs();
    this._preview = null;
    this._savingTimes = {};
    this._resizing = false;
    this._filter = [];
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.onKeyDown);
    if (this.hass && !this.unsubscribe) void this.connect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("keydown", this.onKeyDown);
    void this.unsubscribe?.();
    this.unsubscribe = null;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (
      changed.has("hass") &&
      this.hass &&
      !this.unsubscribe &&
      !this.connecting &&
      this.isConnected
    ) {
      void this.connect();
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    try {
      this._info = await this.api.info();
      this.unsubscribe = await this.api.subscribe((event) => this.onPush(event));
      this._loadError = "";
    } catch (err) {
      this._loadError = errorMessage(err);
    } finally {
      this.connecting = false;
    }
  }

  private onPush(event: PushEvent): void {
    if (event.kind === "status") {
      this._status = event.status;
      return;
    }
    const config = event.config;
    this._config = config;
    const saved = Object.entries(this._savingTimes).filter(([id, times]) => {
      const block = config.blocks.find((b) => b.id === id);
      return !block || sameTimes(block, times);
    });
    if (saved.length) {
      const rest = { ...this._savingTimes };
      for (const [id] of saved) delete rest[id];
      this._savingTimes = rest;
    }
    if (!config.tabs.some((t) => t.id === this._activeTabId)) {
      this._activeTabId = config.tabs[0]?.id ?? "";
    }
    if (this._selectedId && !config.blocks.some((b) => b.id === this._selectedId)) {
      // Deleted (maybe from another browser); a just-created block may not have arrived yet.
      const editor = this.editor;
      if (editor && !editor.dirty) this._selectedId = null;
    }
  }

  // --- Helpers -----------------------------------------------------------------

  private get editor(): PcBlockEditor | null {
    return this.renderRoot.querySelector("pc-block-editor");
  }

  private get confirmDialog(): PcConfirmDialog {
    return this.renderRoot.querySelector("pc-confirm-dialog") as PcConfirmDialog;
  }

  private get selectedBlock(): Block | undefined {
    return this._config?.blocks.find((b) => b.id === this._selectedId);
  }

  private get use24h(): boolean {
    const format = this._config?.settings.time_format ?? "auto";
    if (format !== "auto") return format === "24";
    return uses24h(this.hass.locale ?? { language: this.hass.language });
  }

  private get language(): string {
    return this.hass.locale?.language ?? this.hass.language ?? "en";
  }

  private get timeZone(): string {
    return this._info?.time_zone ?? this.hass.config.time_zone;
  }

  /** The schedule's temperature unit and Home Assistant's (a stable object for Lit). */
  /** The chosen entities that the active tab's blocks act on, as a stable array for Lit. */
  private activeFilter(counts: Map<string, number>): string[] {
    const filter = this._filter.filter((entityId) => counts.has(entityId));
    if (filter.join() !== this.filterCache.join()) this.filterCache = filter;
    return this.filterCache;
  }

  private get units(): TemperatureUnits {
    const schedule = this._config?.settings.temperature_unit ?? "°C";
    const ha = this._info?.temperature_unit ?? this.hass.config.unit_system?.temperature ?? "°C";
    if (this.unitsCache.schedule !== schedule || this.unitsCache.ha !== ha) {
      this.unitsCache = { schedule, ha };
    }
    return this.unitsCache;
  }

  /** The editor's preview, if it's for the selected block. */
  private get preview(): BlockPreview | null {
    const preview = this._preview;
    return preview?.whens.some((w) => w.id === this._selectedId) ? preview : null;
  }

  /**
   * The config shown in the calendar: saved data plus the editor's unsaved changes and the
   * times of blocks dragged in the calendar that are still being saved.
   */
  private viewConfig(config: Config): Config {
    const preview = this.preview;
    const savingTimes = this._savingTimes;
    if (!preview && !Object.keys(savingTimes).length) return config;
    const cache = this.viewCache;
    if (
      cache &&
      cache.config === config &&
      cache.preview === preview &&
      cache.savingTimes === savingTimes
    ) {
      return cache.result;
    }
    const whens = new Map(preview?.whens.map((w) => [w.id, w]));
    const blocks = config.blocks.map((b) => {
      const when = whens.get(b.id);
      whens.delete(b.id);
      const view = when ? { ...b, name: preview!.name, color: preview!.color, ...when } : b;
      // Times dragged in the calendar are newer than the editor's copy of them.
      return savingTimes[b.id] ? { ...view, ...savingTimes[b.id] } : view;
    });
    // Times added in the editor but not saved yet.
    const template = config.blocks.find((b) => b.id === this._selectedId);
    if (preview && template) {
      const { name, color } = preview;
      for (const when of whens.values()) blocks.push({ ...template, name, color, ...when });
    }
    const result = { ...config, blocks };
    this.viewCache = { config, preview, savingTimes, result };
    return result;
  }

  /** The selected block and the rest of its group, as the editor has it. */
  private get selectedIds(): string[] {
    const block = this.selectedBlock;
    const preview = this.preview;
    const ids = preview
      ? preview.whens.map((w) => w.id)
      : block && this._config
        ? blockGroup(this._config.blocks, block).map((b) => b.id)
        : [];
    // Keep the same array while the selection is the same, so the calendar doesn't re-render.
    if (ids.join() !== this.selectionCache.join()) this.selectionCache = ids;
    return this.selectionCache;
  }

  private savePrefs(prefs: LocalPrefs): void {
    this._prefs = prefs;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage can be unavailable (private mode); the preference just won't persist.
    }
  }

  // --- Resizing the editor -----------------------------------------------------

  private clampEditorWidth(width: number): number {
    const total = (this.renderRoot.querySelector(".main") as HTMLElement | null)?.clientWidth ?? 0;
    const max = Math.max(MIN_EDITOR_WIDTH, total - MIN_CALENDAR_WIDTH);
    return Math.round(Math.min(Math.max(width, MIN_EDITOR_WIDTH), max));
  }

  private onSplitterDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this._resizing = true;
  }

  private onSplitterMove(e: PointerEvent): void {
    if (!this._resizing) return;
    const main = this.renderRoot.querySelector(".main") as HTMLElement;
    const width = this.clampEditorWidth(main.getBoundingClientRect().right - e.clientX);
    this._prefs = { ...this._prefs, editorWidth: width };
  }

  private onSplitterUp(): void {
    if (!this._resizing) return;
    this._resizing = false;
    this.savePrefs(this._prefs);
  }

  private onSplitterKey(e: KeyboardEvent): void {
    const steps: Record<string, number> = {
      ArrowLeft: this._prefs.editorWidth + RESIZE_STEP,
      ArrowRight: this._prefs.editorWidth - RESIZE_STEP,
      Home: Infinity,
      End: 0,
    };
    const next = steps[e.key];
    if (next === undefined) return;
    e.preventDefault();
    this.savePrefs({ ...this._prefs, editorWidth: this.clampEditorWidth(next) });
  }

  private toast(message: string): void {
    this._toast = message;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this._toast = ""), 5000);
  }

  private async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (err) {
      this.toast(errorMessage(err));
      return undefined;
    }
  }

  /**
   * Before leaving a block with unsaved edits, offer to save or discard them. Returns
   * false to stay (cancelled, or the save failed; the editor then shows why).
   */
  private async okToLeaveEditor(): Promise<boolean> {
    const editor = this.editor;
    if (!editor?.dirty) return true;
    const choice = await this.confirmDialog.choose({
      heading: "Save changes?",
      text: `"${blockLabel(editor._draft, this.hass.states)}" has unsaved changes.`,
      choices: [
        { value: "discard", label: "Discard", kind: "danger" },
        { value: "save", label: "Save", kind: "primary" },
      ],
    });
    if (choice === "save") return editor.save();
    if (choice === "discard") editor.discard();
    return choice === "discard";
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (this._tabDialog || this._settingsOpen || this._duplicateSource) return;
    if (this._picking) {
      this._picking = false;
      e.preventDefault();
    }
  };

  // --- Blocks ------------------------------------------------------------------

  private async createBlock(detail: CreateBlockDetail): Promise<void> {
    if (!this._config || !(await this.okToLeaveEditor())) return;
    const input: BlockInput = {
      tab_id: this._activeTabId,
      day: detail.day,
      start: detail.start,
      duration: detail.duration,
      name: "",
      color: nextColor(this._config.blocks),
      actions: [],
      conditions: emptyGroup(),
    };
    const result = await this.run(() => this.api.createBlocks([input]));
    if (result?.blocks[0]) this._selectedId = result.blocks[0].id;
  }

  /**
   * A block's edge was dragged in the calendar. Save the new times right away, unless the
   * block's group is open in the editor with unsaved changes: then they join those changes.
   * (A time added in the editor but not saved yet is always an unsaved change.)
   */
  private async resizeBlock(detail: ResizeBlockDetail): Promise<void> {
    const { blockId, ...times } = detail;
    const editor = this.editor;
    if (editor?.dirty && editor.setTimes(blockId, times)) return;
    this._savingTimes = { ...this._savingTimes, [blockId]: times };
    const saved = await this.run(() => this.api.updateBlock(blockId, times));
    if (!saved && this._savingTimes[blockId] === times) {
      const { [blockId]: _failed, ...rest } = this._savingTimes;
      this._savingTimes = rest;
    }
  }

  private async addBlockNow(): Promise<void> {
    const now = nowIn(this.timeZone);
    const start = Math.min(Math.ceil(now.minute / 60) * 60, MINUTES_PER_DAY - 60);
    await this.createBlock({ day: Math.max(0, now.day), start, duration: 60 });
  }

  private async selectBlock(blockId: string | null): Promise<void> {
    if (blockId === this._selectedId) return;
    // A time added in the editor but not saved yet isn't a block to select.
    if (blockId && !this._config?.blocks.some((b) => b.id === blockId)) return;
    if (blockId && this.selectedIds.includes(blockId)) {
      // Another block of the group being edited: the editor keeps any unsaved changes.
      this._selectedId = blockId;
      return;
    }
    if (!(await this.okToLeaveEditor())) return;
    this._selectedId = blockId;
    this._preview = null;
    this._picking = false;
  }

  /** Eyedropper: copy another block into the one being edited, which joins its group. */
  private async pickBlock(blockId: string): Promise<void> {
    const editor = this.editor;
    const target = editor?._draft;
    const source = this._config?.blocks.find((b) => b.id === blockId);
    if (!editor || !target || !source || source.id === target.id) return;
    this._picking = false;
    const conditions = countConditions(target.conditions);
    const others = editor._whens.length - 1;
    if (target.actions.length || conditions || target.name.trim()) {
      const ok = await this.confirmDialog.ask({
        heading: "Copy from another block?",
        text:
          `This replaces the name, color, ${target.actions.length} action(s) and ` +
          `${conditions} condition(s) of "${blockLabel(target, this.hass.states)}"` +
          (others ? ` and the ${others} other block(s) of its group` : "") +
          ` with copies from "${blockLabel(source, this.hass.states)}". Save the block to keep ` +
          `the change.`,
        confirmText: "Replace",
        destructive: true,
      });
      if (!ok) return;
    }
    const wasGrouped = editor._whens.some((w) => w.id === source.id);
    editor.applyFrom(source);
    const label = blockLabel(source, this.hass.states);
    this.toast(
      !wasGrouped && editor._whens.some((w) => w.id === source.id)
        ? `Grouped with "${label}". Save to keep it.`
        : `Copied from "${label}". Save to keep it.`,
    );
  }

  /** Delete the selected block, or its whole group. */
  private async deleteSelected(groupIds: string[]): Promise<void> {
    const block = this.selectedBlock;
    const config = this._config;
    if (!block || !config) return;
    const current = this.editor?._draft ?? block;
    const label = blockLabel(current, this.hass.states);
    const group = groupIds.filter((id) => config.blocks.some((b) => b.id === id));
    let ids: string[] = [];
    if (group.length > 1) {
      const when = `${dayName(current.day, this.language, "long")} ${formatRange(current.start, current.duration, this.use24h)}`;
      const choice = await this.confirmDialog.choose({
        heading: "Delete block?",
        text:
          `"${label}" is a group of ${group.length} blocks. Delete just the one on ${when}, ` +
          `or all ${group.length}? This can't be undone.`,
        choices: [
          { value: "one", label: "Just this one", kind: "danger" },
          { value: "all", label: `All ${group.length}`, kind: "danger" },
        ],
      });
      if (choice === "one") ids = [block.id];
      else if (choice === "all") ids = group;
    } else {
      const ok = await this.confirmDialog.ask({
        heading: "Delete block?",
        text: `Delete "${label}"? This can't be undone.`,
        confirmText: "Delete",
        destructive: true,
      });
      if (ok) ids = [block.id];
    }
    if (!ids.length) return;
    const rest = group.filter((id) => !ids.includes(id));
    if (rest.length) {
      // Stay on the rest of the group, keeping any unsaved changes to it.
      this.editor?.removeWhen(block.id);
      this._selectedId = rest[0]!;
    } else {
      this._selectedId = null;
    }
    await this.run(() =>
      ids.length === 1 ? this.api.deleteBlock(ids[0]!) : this.api.deleteBlocks(ids),
    );
  }

  /**
   * Split a block off from its group by numbering its name and giving it a new color, then
   * edit it on its own. Unsaved changes to the group are saved or discarded first.
   */
  /**
   * Delete one block of the group being edited (its row's delete button), after asking.
   * The editor stays on the rest of the group, keeping any unsaved changes to it.
   */
  private async deleteWhen(blockId: string): Promise<void> {
    const editor = this.editor;
    const config = this._config;
    const when = editor?._whens.find((w) => w.id === blockId);
    if (!editor || !config || !when) return;
    const label = blockLabel(editor._draft, this.hass.states);
    const time = `${dayName(when.day, this.language, "long")} ${formatRange(when.start, when.duration, this.use24h)}`;
    const ok = await this.confirmDialog.ask({
      heading: "Delete block?",
      text:
        `Delete the "${label}" block on ${time}? The rest of the group stays. ` +
        "This can't be undone.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    editor.removeWhen(blockId);
    if (blockId === this._selectedId) {
      const saved = editor._whens.find((w) => config.blocks.some((b) => b.id === w.id));
      this._selectedId = saved?.id ?? null;
    }
    await this.run(() => this.api.deleteBlock(blockId));
  }

  private async splitBlock(blockId: string): Promise<void> {
    this._picking = false;
    if (!(await this.okToLeaveEditor())) return;
    const config = this._config;
    const block = config?.blocks.find((b) => b.id === blockId);
    if (!config || !block) return;
    if (blockGroup(config.blocks, block).length > 1) {
      const name = splitName(config.blocks, block.tab_id, block.name);
      const color = splitColor(config.blocks, block.tab_id, block.color);
      if (!(await this.run(() => this.api.updateBlock(block.id, { name, color })))) return;
    }
    this._selectedId = block.id;
    this._preview = null;
  }

  private async duplicate(blocks: BlockInput[]): Promise<void> {
    const result = await this.run(() => this.api.createBlocks(blocks));
    if (!result) return;
    this._duplicateSource = null;
    this.toast(
      result.blocks.length === 1 ? "Created 1 block." : `Created ${result.blocks.length} blocks.`,
    );
  }

  // --- Tabs --------------------------------------------------------------------

  private async selectTab(tabId: string): Promise<void> {
    if (tabId === this._activeTabId) return;
    if (!this._picking && this._selectedId) {
      if (!(await this.okToLeaveEditor())) return;
      this._selectedId = null;
    }
    this._activeTabId = tabId;
  }

  private async tabAction(tabId: string, action: TabMenuAction): Promise<void> {
    const config = this._config;
    const tab = config?.tabs.find((t) => t.id === tabId);
    if (!config || !tab) return;
    const order = config.tabs.map((t) => t.id);
    const i = order.indexOf(tabId);
    switch (action) {
      case "edit":
        this._tabDialog = { tab };
        break;
      case "duplicate": {
        const result = await this.run(() => this.api.duplicateTab(tabId));
        if (!result) return;
        const count = result.blocks.length;
        this.toast(
          `Created "${result.tab.name}" with ${count} block${count === 1 ? "" : "s"}. ` +
            "It's turned off until you turn it on.",
        );
        await this.selectTab(result.tab.id);
        break;
      }
      case "toggle":
        await this.run(() => this.api.updateTab(tabId, { enabled: !tab.enabled }));
        break;
      case "left":
      case "right": {
        const j = action === "left" ? i - 1 : i + 1;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j]!, order[i]!];
        await this.run(() => this.api.reorderTabs(order));
        break;
      }
      case "delete": {
        const count = config.blocks.filter((b) => b.tab_id === tabId).length;
        const ok = await this.confirmDialog.ask({
          heading: "Delete tab?",
          text: `Delete "${tab.name}" and its ${count} block(s)? This can't be undone.`,
          confirmText: "Delete",
          destructive: true,
        });
        if (ok) await this.run(() => this.api.deleteTab(tabId));
        break;
      }
    }
  }

  // --- Rendering ---------------------------------------------------------------

  private renderBanner() {
    const config = this._config!;
    const tab = config.tabs.find((t) => t.id === this._activeTabId);
    const tabState = tab ? this._status?.tabs[tab.id] : undefined;
    if (this._picking) {
      return html`<div class="banner info">
        <span>
          Choose the block to copy from.
          <span class="hide-narrow">
            Its name, color, actions and conditions replace this block's, which puts the two in one
            group if they're in the same tab. Press Esc to cancel.
          </span>
        </span>
        <button class="btn text" @click=${() => (this._picking = false)}>Cancel</button>
      </div>`;
    }
    if (!config.settings.enabled) {
      return html`<div class="banner warn">Scheduling is paused. Nothing is being set.</div>`;
    }
    if (tab && !tab.enabled) {
      return html`<div class="banner warn">
        The "${tab.name}" tab is turned off, so its blocks don't run.
        <button class="btn text" @click=${() => this.tabAction(tab.id, "toggle")}>Turn on</button>
      </div>`;
    }
    if (tab && tabState && !tabState.conditions_met) {
      return html`<div class="banner warn">
        This tab's conditions are false right now, so its blocks aren't running.
        <button class="btn text" @click=${() => (this._tabDialog = { tab })}>
          Edit conditions
        </button>
      </div>`;
    }
    return nothing;
  }

  protected override render() {
    if (!this.hass) return nothing;
    const config = this._config;
    const outdated = this._info && this._info.version !== __PC_VERSION__;
    const errorCount = this._status?.errors.length ?? 0;
    const selected = this.selectedBlock;
    return html`
      <div class="toolbar">
        ${
          this.narrow
            ? html`<button
                class="icon-btn"
                aria-label="Menu"
                @click=${() => this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }))}
              >
                ${icon(mdiMenu)}
              </button>`
            : nothing
        }
        <div class="title">Punch Clock</div>
        ${
          config
            ? html`<button class="btn on-header" @click=${() => void this.addBlockNow()}>
                  ${icon(mdiPlus, 18)}<span class="hide-narrow">Block</span>
                </button>
                <label class="master" title="Turn all scheduling on or off">
                  <span class="hide-narrow">Scheduling</span>
                  <span class="switch">
                    <input
                      type="checkbox"
                      aria-label="Scheduling"
                      .checked=${config.settings.enabled}
                      @change=${(e: Event) => {
                        const enabled = (e.target as HTMLInputElement).checked;
                        void this.run(() => this.api.updateSettings({ enabled }));
                      }}
                    />
                    <span></span>
                  </span>
                </label>`
            : nothing
        }
        ${
          errorCount
            ? html`<button
                class="icon-btn warn"
                aria-label=${`${errorCount} recent problems`}
                title=${`${errorCount} recent problems`}
                @click=${() => (this._settingsOpen = true)}
              >
                ${icon(mdiAlertCircleOutline)}
              </button>`
            : nothing
        }
        <button class="icon-btn" aria-label="Settings" @click=${() => (this._settingsOpen = true)}>
          ${icon(mdiCog)}
        </button>
      </div>
      ${
        outdated
          ? html`<div class="banner info">
              Punch Clock was updated. Reload the page to use the new version.
              <button class="btn text" @click=${() => location.reload()}>Reload</button>
            </div>`
          : nothing
      }
      ${
        this._loadError
          ? html`<div class="banner error">
              Couldn't load Punch Clock: ${this._loadError}
              <button class="btn text" @click=${() => void this.connect()}>Retry</button>
            </div>`
          : nothing
      }
      ${config ? this.renderMain(config, selected) : this._loadError ? nothing : html`<div class="loading">Loading…</div>`}
      ${this._toast ? html`<div class="toast" role="status">${this._toast}</div>` : nothing}
      <pc-confirm-dialog></pc-confirm-dialog>
    `;
  }

  private renderMain(config: Config, selected: Block | undefined) {
    const view = this.viewConfig(config);
    const counts = entityCounts(view.blocks.filter((b) => b.tab_id === this._activeTabId));
    const filter = this.activeFilter(counts);
    return html`
      <pc-tab-bar
        .tabs=${config.tabs}
        .activeId=${this._activeTabId}
        .status=${this._status}
        @select-tab=${(e: CustomEvent<{ tabId: string }>) => void this.selectTab(e.detail.tabId)}
        @add-tab=${() => (this._tabDialog = { tab: null })}
        @tab-action=${(e: CustomEvent<{ tabId: string; action: TabMenuAction }>) =>
          void this.tabAction(e.detail.tabId, e.detail.action)}
        @reorder=${(e: CustomEvent<{ order: string[] }>) => void this.run(() => this.api.reorderTabs(e.detail.order))}
      ></pc-tab-bar>
      ${this.renderBanner()}
      <pc-entity-filter
        .hass=${this.hass}
        .counts=${counts}
        .selected=${filter}
        @filter-changed=${(e: CustomEvent<{ selected: string[] }>) =>
          (this._filter = e.detail.selected)}
      ></pc-entity-filter>
      <div class="main">
        <pc-week-view
          .hass=${this.hass}
          .config=${view}
          .tabId=${this._activeTabId}
          .status=${this._status}
          .selectedIds=${this.selectedIds}
          .currentId=${this._selectedId}
          .filter=${filter}
          .picking=${this._picking}
          .use24h=${this.use24h}
          .language=${this.language}
          .timeZone=${this.timeZone}
          .hourHeight=${this._prefs.hourHeight}
          .initialHour=${this._prefs.initialHour}
          @create-block=${(e: CustomEvent<CreateBlockDetail>) => void this.createBlock(e.detail)}
          @resize-block=${(e: CustomEvent<ResizeBlockDetail>) => void this.resizeBlock(e.detail)}
          @select-block=${(e: CustomEvent<{ blockId: string }>) => void this.selectBlock(e.detail.blockId)}
          @pick-block=${(e: CustomEvent<{ blockId: string }>) => void this.pickBlock(e.detail.blockId)}
          @background-click=${() => {
            if (!this._picking) void this.selectBlock(null);
          }}
        ></pc-week-view>
        ${
          selected
            ? html`<div
                  class="splitter ${this._resizing ? "active" : ""}"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize the block editor"
                  aria-valuenow=${this._prefs.editorWidth}
                  aria-valuemin=${MIN_EDITOR_WIDTH}
                  tabindex="0"
                  title="Drag to resize. Double-click to reset."
                  @pointerdown=${this.onSplitterDown}
                  @pointermove=${this.onSplitterMove}
                  @pointerup=${this.onSplitterUp}
                  @pointercancel=${this.onSplitterUp}
                  @keydown=${this.onSplitterKey}
                  @dblclick=${() =>
                    this.savePrefs({ ...this._prefs, editorWidth: DEFAULT_PREFS.editorWidth })}
                ></div>
                <div
                  class="editor-pane ${this._picking ? "picking" : ""}"
                  style="--editor-width:${this._prefs.editorWidth}px"
                >
                  <pc-block-editor
                    .hass=${this.hass}
                    .block=${selected}
                    .config=${config}
                    .status=${this._status}
                    .api=${this.api}
                    .units=${this.units}
                    .use24h=${this.use24h}
                    .language=${this.language}
                    .picking=${this._picking}
                    @close-editor=${() => void this.selectBlock(null)}
                    @delete-block=${(e: CustomEvent<{ blockIds: string[] }>) =>
                      void this.deleteSelected(e.detail.blockIds)}
                    @split-block=${(e: CustomEvent<{ blockId: string }>) =>
                      void this.splitBlock(e.detail.blockId)}
                    @delete-when=${(e: CustomEvent<{ blockId: string }>) =>
                      void this.deleteWhen(e.detail.blockId)}
                    @select-when=${(e: CustomEvent<{ blockId: string }>) =>
                      void this.selectBlock(e.detail.blockId)}
                    @duplicate-block=${(e: CustomEvent<{ block: Block }>) => (this._duplicateSource = e.detail.block)}
                    @start-eyedropper=${() => (this._picking = !this._picking)}
                    @preview-changed=${(e: CustomEvent<BlockPreview>) => (this._preview = e.detail)}
                  ></pc-block-editor>
                </div>`
            : nothing
        }
      </div>
      <pc-duplicate-dialog
        .open=${!!this._duplicateSource}
        .source=${this._duplicateSource}
        .tabs=${config.tabs}
        .weekStart=${config.settings.week_start}
        .language=${this.language}
        .use24h=${this.use24h}
        @duplicate=${(e: CustomEvent<{ blocks: BlockInput[] }>) => void this.duplicate(e.detail.blocks)}
        @closed=${() => (this._duplicateSource = null)}
      ></pc-duplicate-dialog>
      <pc-tab-dialog
        .open=${!!this._tabDialog}
        .tab=${this._tabDialog?.tab ?? null}
        .hass=${this.hass}
        .api=${this.api}
        .config=${config}
        .units=${this.units}
        @saved=${(e: CustomEvent<{ tabId: string }>) => {
          this._tabDialog = null;
          this._activeTabId = e.detail.tabId;
        }}
        @closed=${() => (this._tabDialog = null)}
      ></pc-tab-dialog>
      <pc-settings-dialog
        .open=${this._settingsOpen}
        .settings=${config.settings}
        .prefs=${this._prefs}
        .status=${this._status}
        .language=${this.language}
        .use24h=${this.use24h}
        .version=${this._info?.version ?? __PC_VERSION__}
        @settings-change=${(e: CustomEvent<{ changes: Partial<Settings> }>) =>
          void this.run(() => this.api.updateSettings(e.detail.changes))}
        @prefs-change=${(e: CustomEvent<{ prefs: LocalPrefs }>) => this.savePrefs(e.detail.prefs)}
        @reapply=${async () => {
          if ((await this.run(() => this.api.reapply())) !== undefined)
            this.toast("Applied the schedule.");
        }}
        @closed=${() => (this._settingsOpen = false)}
      ></pc-settings-dialog>
    `;
  }

  static override styles = [
    themeTokens,
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        height: 100dvh;
        background: var(--pc-bg);
        font-family: var(--paper-font-body1_-_font-family, var(--ha-font-family-body, inherit));
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
        min-height: 56px;
        padding: env(safe-area-inset-top, 0) 8px 0 12px;
        background: var(--pc-header-bg);
        color: var(--pc-header-text);
      }
      .title {
        flex: 1;
        font-size: 1.25em;
        font-weight: 400;
        padding-left: 4px;
      }
      .btn.on-header {
        border-color: color-mix(in srgb, currentColor 40%, transparent);
        color: inherit;
      }
      .master {
        display: flex;
        align-items: center;
        gap: 8px;
        color: inherit;
        font-size: 0.95em;
        padding: 0 6px;
      }
      /* The header uses the primary color, so the switch is drawn in header colors. */
      .toolbar .switch span {
        background: color-mix(in srgb, var(--pc-header-text) 30%, transparent);
      }
      .toolbar .switch span::before {
        background: var(--pc-header-text);
      }
      .toolbar .switch input:checked + span {
        background: var(--pc-header-text);
      }
      .toolbar .switch input:checked + span::before {
        background: var(--pc-header-bg);
      }
      .icon-btn.warn {
        color: var(--pc-warning);
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 6px 16px;
        font-size: 0.9em;
        background: var(--pc-bg-2);
      }
      .banner.warn {
        background: color-mix(in srgb, var(--pc-warning) 18%, var(--pc-card));
      }
      .banner.info {
        background: color-mix(in srgb, var(--pc-primary) 14%, var(--pc-card));
      }
      .banner.error {
        background: color-mix(in srgb, var(--pc-error) 16%, var(--pc-card));
      }
      .main {
        flex: 1;
        min-height: 0;
        display: flex;
      }
      .main:has(.splitter.active) {
        cursor: col-resize;
        user-select: none;
      }
      pc-week-view {
        flex: 1;
        min-width: 0;
      }
      .splitter {
        position: relative;
        flex: none;
        width: 9px;
        margin: 0 -4px;
        z-index: 3;
        cursor: col-resize;
        touch-action: none;
      }
      .splitter::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 4px;
        width: 1px;
        background: var(--pc-divider);
        transition:
          background 0.15s,
          width 0.15s,
          left 0.15s;
      }
      .splitter::after {
        content: "";
        position: absolute;
        top: 50%;
        left: 2px;
        width: 5px;
        height: 36px;
        margin-top: -18px;
        border-radius: 3px;
        background: var(--pc-disabled);
      }
      .splitter:hover::before,
      .splitter:focus-visible::before,
      .splitter.active::before {
        left: 3px;
        width: 3px;
        background: var(--pc-primary);
      }
      .splitter:focus-visible {
        outline: none;
      }
      .editor-pane {
        width: var(--editor-width, 460px);
        /* Keep part of the calendar visible when the window shrinks. */
        max-width: calc(100% - 160px);
        flex: none;
        min-height: 0;
      }
      .loading {
        padding: 32px;
        color: var(--pc-text-2);
      }
      .toast {
        position: fixed;
        left: 50%;
        bottom: calc(24px + env(safe-area-inset-bottom, 0px));
        transform: translateX(-50%);
        z-index: 20;
        max-width: min(560px, calc(100vw - 32px));
        padding: 12px 18px;
        border-radius: var(--pc-radius-sm);
        background: #323232;
        color: #fff;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      }
      @media (max-width: 960px) {
        .splitter {
          display: none;
        }
        .editor-pane {
          position: fixed;
          inset: 0;
          width: auto;
          max-width: none;
          z-index: 10;
          border-left: none;
          padding-top: env(safe-area-inset-top, 0);
          background: var(--pc-card);
        }
        /*
         * The editor covers the calendar, so it steps aside while the eyedropper is on. Hidden
         * rather than not displayed, which could lose where it was scrolled to.
         */
        .editor-pane.picking {
          visibility: hidden;
        }
      }
      @media (max-width: 600px) {
        .hide-narrow {
          display: none;
        }
      }
    `,
  ];
}
