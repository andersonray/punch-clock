import { LitElement, css, html, nothing } from "lit";
import type { HassEntity, HomeAssistant } from "../types";
import { controls } from "../styles";
import { icon, mdiClose } from "../icons";

const MAX_RESULTS = 50;

let pickerCount = 0;

/**
 * Search box over hass.states. Fires `value-changed` with `{ value: entityId }`.
 * `suggestions` are listed first, under their own heading.
 */
export class PcEntityPicker extends LitElement {
  static override properties = {
    hass: { attribute: false },
    value: {},
    label: {},
    domains: { attribute: false },
    suggestions: { attribute: false },
    suggestionsLabel: {},
    invalid: { type: Boolean },
    _query: { state: true },
    _open: { state: true },
    _active: { state: true },
  };

  declare hass: HomeAssistant;
  declare value: string;
  declare label: string;
  /** Only offer entities of these domains (all domains if empty). */
  declare domains: readonly string[];
  /** Entities to list first, e.g. the ones most likely to be wanted here. */
  declare suggestions: readonly string[];
  /** Heading over the suggestions. */
  declare suggestionsLabel: string;
  declare invalid: boolean;
  declare _query: string;
  declare _open: boolean;
  declare _active: number;

  private readonly listId = `pc-entity-list-${++pickerCount}`;

  constructor() {
    super();
    this.value = "";
    this.label = "Entity";
    this.domains = [];
    this.suggestions = [];
    this.suggestionsLabel = "Suggested";
    this.invalid = false;
    this._query = "";
    this._open = false;
    this._active = 0;
  }

  /** Focus the search box, which opens the list. */
  override focus(): void {
    this.renderRoot.querySelector("input")?.focus();
  }

  private get entity(): HassEntity | undefined {
    return this.value ? this.hass?.states[this.value] : undefined;
  }

  private display(): string {
    if (!this.value) return "";
    const name = this.entity?.attributes.friendly_name;
    return name ? `${name} (${this.value})` : this.value;
  }

  /** Entities matching the query: the suggested ones, then up to MAX_RESULTS others. */
  private search(): { suggested: HassEntity[]; others: HassEntity[] } {
    const terms = this._query.toLowerCase().split(/\s+/).filter(Boolean);
    const domains = new Set(this.domains);
    const suggestions = new Set(this.suggestions);
    const suggested: { entity: HassEntity; rank: number; name: string }[] = [];
    const others: typeof suggested = [];
    for (const entity of Object.values(this.hass?.states ?? {})) {
      const domain = entity.entity_id.split(".", 1)[0]!;
      if (domains.size && !domains.has(domain)) continue;
      const name = (entity.attributes.friendly_name ?? "").toLowerCase();
      const haystack = `${name} ${entity.entity_id}`;
      if (!terms.every((t) => haystack.includes(t))) continue;
      const first = terms[0] ?? "";
      const rank = name.startsWith(first) ? 0 : entity.entity_id.startsWith(first) ? 1 : 2;
      (suggestions.has(entity.entity_id) ? suggested : others).push({ entity, rank, name });
    }
    const sorted = (list: typeof suggested) =>
      list.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map((r) => r.entity);
    return { suggested: sorted(suggested), others: sorted(others).slice(0, MAX_RESULTS) };
  }

  private select(entityId: string): void {
    this._open = false;
    this._query = "";
    this.dispatchEvent(new CustomEvent("value-changed", { detail: { value: entityId } }));
  }

  private onInput(e: InputEvent): void {
    this._query = (e.target as HTMLInputElement).value;
    this._open = true;
    this._active = 0;
  }

  private onFocus(e: FocusEvent): void {
    (e.target as HTMLInputElement).select();
    this._query = "";
    this._open = true;
    this._active = 0;
  }

  private onBlur(): void {
    // Let a click on an option land before closing.
    setTimeout(() => {
      this._open = false;
      this._query = "";
    }, 150);
  }

  private onKeyDown(e: KeyboardEvent, results: HassEntity[]): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._open = true;
      this._active = Math.min(this._active + 1, results.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this._active = Math.max(this._active - 1, 0);
    } else if (e.key === "Enter" && this._open && results[this._active]) {
      e.preventDefault();
      this.select(results[this._active]!.entity_id);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape" && this._open) {
      e.stopPropagation();
      this._open = false;
    }
  }

  private renderList(suggested: HassEntity[], others: HassEntity[]) {
    const option = (entity: HassEntity, i: number) =>
      html`<li
        role="option"
        aria-selected=${i === this._active ? "true" : "false"}
        class=${i === this._active ? "active" : ""}
        @mousedown=${(e: Event) => e.preventDefault()}
        @click=${() => this.select(entity.entity_id)}
      >
        <span class="name">${entity.attributes.friendly_name ?? entity.entity_id}</span>
        <span class="id">${entity.entity_id}</span>
      </li>`;
    const heading = (text: string) => html`<li class="heading" role="presentation">${text}</li>`;
    if (!suggested.length && !others.length) {
      return html`<li class="empty">No matching entities</li>`;
    }
    return html`${suggested.length ? heading(this.suggestionsLabel) : nothing}
    ${suggested.map((entity, i) => option(entity, i))}
    ${suggested.length && others.length ? heading("Other entities") : nothing}
    ${others.map((entity, i) => option(entity, suggested.length + i))}`;
  }

  protected override render() {
    const { suggested, others } = this._open ? this.search() : { suggested: [], others: [] };
    const results = [...suggested, ...others];
    const missing = this.value && this.hass && !this.entity;
    return html`
      <div class="field ${this.invalid || missing ? "invalid" : ""}">
        <input
          role="combobox"
          aria-label=${this.label}
          aria-expanded=${this._open ? "true" : "false"}
          aria-controls=${this.listId}
          aria-autocomplete="list"
          placeholder=${this.label}
          .value=${this._open ? this._query : this.display()}
          @input=${this.onInput}
          @focus=${this.onFocus}
          @blur=${this.onBlur}
          @keydown=${(e: KeyboardEvent) => this.onKeyDown(e, results)}
        />
        ${
          this.value
            ? html`<button
                class="icon-btn small"
                aria-label="Clear"
                @mousedown=${(e: Event) => e.preventDefault()}
                @click=${() => this.select("")}
              >
                ${icon(mdiClose, 16)}
              </button>`
            : nothing
        }
      </div>
      ${missing ? html`<div class="error-text">This entity doesn't exist.</div>` : nothing}
      ${
        this._open
          ? html`<ul id=${this.listId} role="listbox">
              ${this.renderList(suggested, others)}
            </ul>`
          : nothing
      }
    `;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .field {
        display: flex;
        align-items: center;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
      }
      .field.invalid {
        border-color: var(--pc-error);
      }
      .field:focus-within {
        outline: 2px solid var(--pc-primary);
        outline-offset: 1px;
      }
      input {
        flex: 1;
        border: none !important;
        outline: none !important;
        background: transparent !important;
        text-overflow: ellipsis;
      }
      ul {
        list-style: none;
        margin: 4px 0 0;
        padding: 4px 0;
        max-height: 240px;
        overflow: auto;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
      }
      li {
        display: flex;
        flex-direction: column;
        padding: 6px 12px;
        cursor: pointer;
      }
      li.active,
      li:hover {
        background: color-mix(in srgb, var(--pc-primary) 12%, transparent);
      }
      li.empty,
      li.heading {
        color: var(--pc-text-2);
        cursor: default;
        background: none;
      }
      li.heading {
        padding: 8px 12px 2px;
        font-size: 0.75em;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .id {
        font-size: 0.8em;
        color: var(--pc-text-2);
      }
    `,
  ];
}
