import { LitElement, css, html, nothing } from "lit";
import type { HomeAssistant } from "../types";
import { friendlyName } from "../logic/model";
import { controls } from "../styles";

/**
 * A row of toggle chips, one per entity the tab's blocks act on, for showing only the
 * blocks that act on the chosen ones. Fires `filter-changed` ({ selected: entity IDs }).
 */
export class PcEntityFilter extends LitElement {
  static override properties = {
    hass: { attribute: false },
    counts: { attribute: false },
    selected: { attribute: false },
  };

  declare hass: HomeAssistant;
  /** How many of the tab's blocks act on each entity. */
  declare counts: Map<string, number>;
  /** The chosen entities; empty shows every block. */
  declare selected: readonly string[];

  constructor() {
    super();
    this.counts = new Map();
    this.selected = [];
  }

  private emit(selected: string[]): void {
    this.dispatchEvent(new CustomEvent("filter-changed", { detail: { selected } }));
  }

  private toggle(entityId: string): void {
    this.emit(
      this.selected.includes(entityId)
        ? this.selected.filter((e) => e !== entityId)
        : [...this.selected, entityId],
    );
  }

  protected override render() {
    if (!this.counts.size) return nothing;
    const states = this.hass?.states ?? {};
    const chips = [...this.counts]
      .map(([entityId, count]) => ({ entityId, count, name: friendlyName(entityId, states) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const filtering = this.selected.length > 0;
    return html`<div class="bar" role="group" aria-label="Show only blocks that set">
      <span class="label">Show blocks for</span>
      ${chips.map(({ entityId, count, name }) => {
        const on = this.selected.includes(entityId);
        return html`<button
          class="chip-btn ${on ? "on" : ""}"
          aria-pressed=${on ? "true" : "false"}
          title=${`${entityId}: ${count} block${count === 1 ? "" : "s"}`}
          @click=${() => this.toggle(entityId)}
        >
          ${name}<span class="count">${count}</span>
        </button>`;
      })}
      ${
        filtering
          ? html`<button class="btn text show-all" @click=${() => this.emit([])}>Show all</button>`
          : nothing
      }
    </div>`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
      }
      .bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-bottom: 1px solid var(--pc-divider);
        background: var(--pc-card);
      }
      .label {
        color: var(--pc-text-2);
        font-size: 0.85em;
        margin-right: 2px;
        white-space: nowrap;
      }
      .chip-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 0 10px;
        border: 1px solid var(--pc-divider);
        border-radius: 14px;
        background: transparent;
        color: var(--pc-text);
        font-size: 0.85em;
        white-space: nowrap;
        cursor: pointer;
      }
      .chip-btn:hover {
        background: color-mix(in srgb, var(--pc-text) 6%, transparent);
      }
      .chip-btn.on {
        border-color: var(--pc-primary);
        background: color-mix(in srgb, var(--pc-primary) 16%, transparent);
        color: var(--pc-primary);
        font-weight: 500;
      }
      .count {
        min-width: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--pc-bg-2);
        color: var(--pc-text-2);
        font-size: 0.85em;
        font-weight: 400;
        text-align: center;
      }
      .chip-btn.on .count {
        background: var(--pc-primary);
        color: var(--pc-on-primary);
      }
      .show-all {
        min-height: 28px;
      }
      /* On a phone, one row that scrolls sideways instead of several rows of chips. */
      @media (max-width: 600px) {
        .bar {
          flex-wrap: nowrap;
          overflow-x: auto;
        }
      }
    `,
  ];
}
