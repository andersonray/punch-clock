import { LitElement, css, html, nothing } from "lit";
import type { Status, Tab } from "../types";
import { controls } from "../styles";
import { icon, mdiDotsVertical, mdiPlus } from "../icons";

export type TabMenuAction = "edit" | "duplicate" | "toggle" | "left" | "right" | "delete";

/**
 * Tabs across the top. Events: `select-tab` ({ tabId }), `add-tab`,
 * `tab-action` ({ tabId, action }), `reorder` ({ order }).
 */
export class PcTabBar extends LitElement {
  static override properties = {
    tabs: { attribute: false },
    activeId: {},
    status: { attribute: false },
    _menuFor: { state: true },
    _menuX: { state: true },
    _dragId: { state: true },
    _dropIndex: { state: true },
  };

  declare tabs: Tab[];
  declare activeId: string;
  declare status: Status | null;
  declare _menuFor: string | null;
  declare _menuX: number;
  declare _dragId: string | null;
  declare _dropIndex: number | null;

  constructor() {
    super();
    this.tabs = [];
    this.status = null;
    this._menuFor = null;
    this._menuX = 8;
    this._dragId = null;
    this._dropIndex = null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.closeMenu);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.closeMenu);
  }

  private readonly closeMenu = (e: Event): void => {
    if (this._menuFor && !e.composedPath().includes(this)) this._menuFor = null;
  };

  private fire(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private toggleMenu(e: Event, tabId: string): void {
    if (this._menuFor === tabId) {
      this._menuFor = null;
      return;
    }
    const button = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const host = this.getBoundingClientRect();
    this._menuX = Math.max(8, Math.min(button.right - host.left - 240, host.width - 248));
    this._menuFor = tabId;
  }

  private action(tabId: string, action: TabMenuAction): void {
    this._menuFor = null;
    this.fire("tab-action", { tabId, action });
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    const dragId = this._dragId;
    const index = this._dropIndex;
    this._dragId = null;
    this._dropIndex = null;
    if (!dragId || index === null) return;
    const order = this.tabs.map((t) => t.id).filter((id) => id !== dragId);
    const from = this.tabs.findIndex((t) => t.id === dragId);
    order.splice(index > from ? index - 1 : index, 0, dragId);
    if (order.join() !== this.tabs.map((t) => t.id).join()) this.fire("reorder", { order });
  }

  private dotClass(tab: Tab): string {
    if (!tab.enabled) return "off";
    return this.status?.tabs[tab.id]?.active ? "on" : "idle";
  }

  private dotTitle(tab: Tab): string {
    if (!tab.enabled) return "Disabled";
    const state = this.status?.tabs[tab.id];
    if (!state) return "";
    return state.active ? "Active: conditions are met" : "Inactive: conditions are not met";
  }

  private renderMenu() {
    const i = this.tabs.findIndex((t) => t.id === this._menuFor);
    const tab = this.tabs[i];
    if (!tab) return nothing;
    return html`<div class="menu" role="menu" style="left:${this._menuX}px">
      <button role="menuitem" @click=${() => this.action(tab.id, "edit")}>
        Name, conditions and defaults…
      </button>
      <button
        role="menuitem"
        title="Copy this tab and its blocks into a new tab, which starts out disabled"
        @click=${() => this.action(tab.id, "duplicate")}
      >
        Duplicate tab
      </button>
      <button role="menuitem" @click=${() => this.action(tab.id, "toggle")}>
        ${tab.enabled ? "Disable tab" : "Enable tab"}
      </button>
      <button role="menuitem" ?disabled=${i === 0} @click=${() => this.action(tab.id, "left")}>
        Move left (higher priority)
      </button>
      <button
        role="menuitem"
        ?disabled=${i === this.tabs.length - 1}
        @click=${() => this.action(tab.id, "right")}
      >
        Move right (lower priority)
      </button>
      <button
        role="menuitem"
        class="danger"
        ?disabled=${this.tabs.length === 1}
        @click=${() => this.action(tab.id, "delete")}
      >
        Delete tab…
      </button>
    </div>`;
  }

  protected override render() {
    return html`<div
        class="bar"
        role="tablist"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${this.onDrop}
      >
        ${this.tabs.map((tab, i) => {
          const active = tab.id === this.activeId;
          return html`<div
            class="tab ${active ? "active" : ""} ${this._dropIndex === i && this._dragId ? "drop-before" : ""}"
            draggable="true"
            @dragstart=${(e: DragEvent) => {
              this._dragId = tab.id;
              e.dataTransfer?.setData("text/plain", tab.id);
            }}
            @dragover=${(e: DragEvent) => {
              e.preventDefault();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              this._dropIndex = e.clientX < rect.left + rect.width / 2 ? i : i + 1;
            }}
            @dragend=${() => {
              this._dragId = null;
              this._dropIndex = null;
            }}
          >
            <button
              role="tab"
              aria-selected=${active ? "true" : "false"}
              class="tab-button"
              @click=${() => this.fire("select-tab", { tabId: tab.id })}
              @dblclick=${() => this.action(tab.id, "edit")}
            >
              <span class="dot ${this.dotClass(tab)}" title=${this.dotTitle(tab)}></span>
              <span class="label">${tab.name}</span>
            </button>
            ${
              active
                ? html`<button
                    class="icon-btn small"
                    aria-label=${`Options for ${tab.name}`}
                    aria-haspopup="menu"
                    @click=${(e: Event) => this.toggleMenu(e, tab.id)}
                  >
                    ${icon(mdiDotsVertical, 18)}
                  </button>`
                : nothing
            }
          </div>`;
        })}
        <button
          class="icon-btn add"
          aria-label="Add tab"
          title="Add tab"
          @click=${() => this.fire("add-tab")}
        >
          ${icon(mdiPlus)}
        </button>
      </div>
      ${this.renderMenu()}`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        position: relative;
        border-bottom: 1px solid var(--pc-divider);
        background: var(--pc-card);
      }
      .bar {
        display: flex;
        align-items: stretch;
        gap: 2px;
        padding: 0 8px;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .tab {
        position: relative;
        display: flex;
        align-items: center;
        border-bottom: 3px solid transparent;
        flex: none;
      }
      .tab.active {
        border-bottom-color: var(--pc-primary);
      }
      .tab.drop-before {
        box-shadow: inset 3px 0 0 var(--pc-primary);
      }
      .tab-button {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 10px 9px;
        border: none;
        background: none;
        cursor: pointer;
        color: var(--pc-text-2);
        font-weight: 500;
      }
      .tab.active .tab-button {
        color: var(--pc-primary);
      }
      .label {
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex: none;
      }
      .dot.on {
        background: var(--pc-success);
      }
      .dot.idle {
        background: var(--pc-disabled);
      }
      .dot.off {
        border: 2px solid var(--pc-disabled);
      }
      .add {
        align-self: center;
      }
      .menu {
        position: absolute;
        top: 100%;
        z-index: 10;
        display: flex;
        flex-direction: column;
        min-width: 240px;
        padding: 6px 0;
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
      }
      .menu button {
        padding: 10px 16px;
        border: none;
        background: none;
        text-align: left;
        cursor: pointer;
      }
      .menu button:hover:not(:disabled) {
        background: color-mix(in srgb, var(--pc-primary) 10%, transparent);
      }
      .menu button:disabled {
        color: var(--pc-disabled);
        cursor: default;
      }
      .menu .danger {
        color: var(--pc-error);
      }
    `,
  ];
}
