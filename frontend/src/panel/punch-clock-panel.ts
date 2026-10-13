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
import { blockLabel, countConditions, emptyGroup, nextColor } from "../logic/model";
import { MINUTES_PER_DAY, nowIn, uses24h } from "../logic/time";
import { themeTokens, controls } from "../styles";
import { icon, mdiAlertCircleOutline, mdiCog, mdiMenu, mdiPlus } from "../icons";
import type { PcBlockEditor } from "../components/pc-block-editor";
import type { PcConfirmDialog } from "../components/pc-confirm-dialog";
import type { CreateBlockDetail } from "../components/pc-week-view";
import type { TabMenuAction } from "../components/pc-tab-bar";
import { HOUR_HEIGHTS, type LocalPrefs } from "../components/pc-settings-dialog";

declare const __PC_VERSION__: string;

const PREFS_KEY = "punch-clock:prefs";
const DEFAULT_PREFS: LocalPrefs = { hourHeight: 48, initialHour: -1 };

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

  private readonly api = new PunchClockApi(() => this.hass);
  private unsubscribe: (() => Promise<void>) | null = null;
  private connecting = false;
  private toastTimer = 0;

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
    return uses24h(this.hass.locale ?? { language: this.hass.language });
  }

  private get language(): string {
    return this.hass.locale?.language ?? this.hass.language ?? "en";
  }

  private get timeZone(): string {
    return this._info?.time_zone ?? this.hass.config.time_zone;
  }

  private get temperatureUnit(): string {
    return this._info?.temperature_unit ?? this.hass.config.unit_system?.temperature ?? "°C";
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

  /** Ask before throwing away unsaved edits in the block editor. */
  private async okToLeaveEditor(): Promise<boolean> {
    if (!this.editor?.dirty) return true;
    return this.confirmDialog.ask({
      heading: "Discard changes?",
      text: "This block has unsaved changes.",
      confirmText: "Discard",
      destructive: true,
    });
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

  private async addBlockNow(): Promise<void> {
    const now = nowIn(this.timeZone);
    const start = Math.min(Math.ceil(now.minute / 60) * 60, MINUTES_PER_DAY - 60);
    await this.createBlock({ day: Math.max(0, now.day), start, duration: 60 });
  }

  private async selectBlock(blockId: string | null): Promise<void> {
    if (blockId === this._selectedId) return;
    if (!(await this.okToLeaveEditor())) return;
    this._selectedId = blockId;
    this._picking = false;
  }

  private async pickBlock(blockId: string): Promise<void> {
    const editor = this.editor;
    const target = editor?._draft;
    const source = this._config?.blocks.find((b) => b.id === blockId);
    if (!editor || !target || !source || source.id === target.id) return;
    this._picking = false;
    const existing = target.actions.length + countConditions(target.conditions);
    if (existing) {
      const ok = await this.confirmDialog.ask({
        heading: "Replace actions and conditions?",
        text:
          `This replaces the ${target.actions.length} action(s) and ` +
          `${countConditions(target.conditions)} condition(s) of "${blockLabel(target, this.hass.states)}" ` +
          `with copies from "${blockLabel(source, this.hass.states)}". Save the block to keep the change.`,
        confirmText: "Replace",
        destructive: true,
      });
      if (!ok) return;
    }
    editor.applyBehavior(source);
    this.toast(`Copied from "${blockLabel(source, this.hass.states)}". Save to keep it.`);
  }

  private async deleteSelected(): Promise<void> {
    const block = this.selectedBlock;
    if (!block) return;
    const ok = await this.confirmDialog.ask({
      heading: "Delete block?",
      text: `Delete "${blockLabel(block, this.hass.states)}"? This can't be undone.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await this.run(() => this.api.deleteBlock(block.id));
    this._selectedId = null;
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
        Click the block to copy actions and conditions from. Press Esc to cancel.
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
      <div class="main">
        <pc-week-view
          .hass=${this.hass}
          .config=${config}
          .tabId=${this._activeTabId}
          .status=${this._status}
          .selectedId=${this._selectedId}
          .picking=${this._picking}
          .use24h=${this.use24h}
          .language=${this.language}
          .timeZone=${this.timeZone}
          .hourHeight=${this._prefs.hourHeight}
          .initialHour=${this._prefs.initialHour}
          @create-block=${(e: CustomEvent<CreateBlockDetail>) => void this.createBlock(e.detail)}
          @select-block=${(e: CustomEvent<{ blockId: string }>) => void this.selectBlock(e.detail.blockId)}
          @pick-block=${(e: CustomEvent<{ blockId: string }>) => void this.pickBlock(e.detail.blockId)}
          @background-click=${() => {
            if (!this._picking) void this.selectBlock(null);
          }}
        ></pc-week-view>
        ${
          selected
            ? html`<div class="editor-pane">
                <pc-block-editor
                  .hass=${this.hass}
                  .block=${selected}
                  .config=${config}
                  .status=${this._status}
                  .api=${this.api}
                  .temperatureUnit=${this.temperatureUnit}
                  .use24h=${this.use24h}
                  .language=${this.language}
                  .picking=${this._picking}
                  @close-editor=${() => void this.selectBlock(null)}
                  @delete-block=${() => void this.deleteSelected()}
                  @duplicate-block=${(e: CustomEvent<{ block: Block }>) => (this._duplicateSource = e.detail.block)}
                  @start-eyedropper=${() => (this._picking = !this._picking)}
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
        @duplicate=${(e: CustomEvent<{ blocks: BlockInput[] }>) => void this.duplicate(e.detail.blocks)}
        @closed=${() => (this._duplicateSource = null)}
      ></pc-duplicate-dialog>
      <pc-tab-dialog
        .open=${!!this._tabDialog}
        .tab=${this._tabDialog?.tab ?? null}
        .hass=${this.hass}
        .api=${this.api}
        .config=${config}
        .temperatureUnit=${this.temperatureUnit}
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
        @prefs-change=${(e: CustomEvent<{ prefs: LocalPrefs }>) => {
          this._prefs = e.detail.prefs;
          try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(this._prefs));
          } catch {
            // Storage can be unavailable (private mode); the preference just won't persist.
          }
        }}
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
      pc-week-view {
        flex: 1;
        min-width: 0;
      }
      .editor-pane {
        width: 460px;
        flex: none;
        border-left: 1px solid var(--pc-divider);
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
        .editor-pane {
          position: fixed;
          inset: 0;
          width: auto;
          z-index: 10;
          border-left: none;
          padding-top: env(safe-area-inset-top, 0);
          background: var(--pc-card);
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
