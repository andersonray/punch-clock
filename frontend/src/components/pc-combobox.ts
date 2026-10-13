import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { controls } from "../styles";
import { icon, mdiCheck, mdiMenuDown } from "../icons";

let comboboxCount = 0;

/** Split options into those containing the filter text and the rest, keeping order. */
export function partitionOptions(options: string[], filter: string): [string[], string[]] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [options, []];
  const matches: string[] = [];
  const rest: string[] = [];
  for (const option of options)
    (option.toLowerCase().includes(needle) ? matches : rest).push(option);
  return [matches, rest];
}

/**
 * A text field with a dropdown of suggestions. Any text is allowed. The dropdown
 * always lists every option: once you type, options containing the typed text move
 * to the top, above a dividing line. Fires `value-changed` ({ value }).
 */
export class PcCombobox extends LitElement {
  static override properties = {
    value: {},
    options: { attribute: false },
    label: {},
    placeholder: {},
    inputmode: {},
    _text: { state: true },
    _open: { state: true },
    _typed: { state: true },
    _active: { state: true },
  };

  declare value: string;
  declare options: string[];
  declare label: string;
  declare placeholder: string;
  declare inputmode: string;
  declare _text: string;
  declare _open: boolean;
  /** True once the user has typed since the dropdown opened (the text is a filter then). */
  declare _typed: boolean;
  declare _active: number;

  private readonly listId = `pc-combobox-list-${++comboboxCount}`;
  private closeTimer = 0;

  constructor() {
    super();
    this.value = "";
    this.options = [];
    this.label = "";
    this.placeholder = "";
    this.inputmode = "text";
    this._text = "";
    this._open = false;
    this._typed = false;
    this._active = -1;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("value") && !this._open) this._text = this.value;
  }

  protected override updated(): void {
    // Keep the dropdown inside the window when the field sits near its right edge.
    const list = this.renderRoot.querySelector("ul");
    if (!list) return;
    list.style.left = "0px";
    const overflow = list.getBoundingClientRect().right - (window.innerWidth - 8);
    if (overflow > 0) list.style.left = `${-overflow}px`;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.closeTimer);
  }

  private get input(): HTMLInputElement | null {
    return this.renderRoot.querySelector("input");
  }

  /** Options in display order, with the divider position (-1 if none). */
  private ordered(): { items: string[]; divider: number } {
    const [matches, rest] = this._typed
      ? partitionOptions(this.options, this._text)
      : [this.options, []];
    return {
      items: [...matches, ...rest],
      divider: matches.length && rest.length ? matches.length : -1,
    };
  }

  private commit(value: string): void {
    this._text = value;
    if (value !== this.value) {
      this.dispatchEvent(new CustomEvent("value-changed", { detail: { value } }));
    }
  }

  private openList(typed: boolean): void {
    this._open = true;
    this._typed = typed;
    const { items } = this.ordered();
    // Only an exact match is pre-selected, so Enter keeps free text (e.g. a number) as typed.
    const typedText = this._text.trim().toLowerCase();
    this._active = typed
      ? items.findIndex((o) => o.toLowerCase() === typedText)
      : items.indexOf(this.value);
  }

  private close(): void {
    this._open = false;
    this._typed = false;
    this._active = -1;
  }

  private choose(option: string): void {
    this.commit(option);
    this.close();
  }

  private onInput(e: Event): void {
    this._text = (e.target as HTMLInputElement).value;
    this.openList(true);
  }

  private onBlur(): void {
    // Let a click on an option land first.
    this.closeTimer = window.setTimeout(() => {
      if (this._open) this.close();
      this.commit(this._text);
    }, 150);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const { items } = this.ordered();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this._open) this.openList(false);
        else this._active = Math.min(this._active + 1, items.length - 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (this._open) this._active = Math.max(this._active - 1, 0);
        break;
      case "Enter":
        e.preventDefault();
        if (this._open && items[this._active] !== undefined) this.choose(items[this._active]!);
        else {
          this.commit(this._text);
          this.close();
        }
        break;
      case "Escape":
        if (this._open) {
          e.stopPropagation();
          this.close();
        }
        break;
    }
  }

  private toggle(): void {
    window.clearTimeout(this.closeTimer);
    if (this._open) this.close();
    else this.openList(false);
    this.input?.focus();
  }

  private renderOption(option: string, index: number, needle: string) {
    const selected = option === this.value;
    let label: unknown = option;
    const at = needle ? option.toLowerCase().indexOf(needle) : -1;
    if (at >= 0) {
      label = html`${option.slice(0, at)}<mark>${option.slice(at, at + needle.length)}</mark>${option.slice(at + needle.length)}`;
    }
    return html`<li
      id=${`${this.listId}-${index}`}
      role="option"
      aria-selected=${selected ? "true" : "false"}
      class=${index === this._active ? "active" : ""}
      @mousedown=${(e: Event) => e.preventDefault()}
      @click=${() => this.choose(option)}
    >
      <span class="check">${selected ? icon(mdiCheck, 16) : nothing}</span>
      <span>${label}</span>
    </li>`;
  }

  protected override render() {
    const { items, divider } = this.ordered();
    const needle = this._typed ? this._text.trim().toLowerCase() : "";
    return html`<div class="field">
        <input
          role="combobox"
          aria-label=${this.label}
          aria-expanded=${this._open ? "true" : "false"}
          aria-controls=${this.listId}
          aria-autocomplete="list"
          aria-activedescendant=${this._open && this._active >= 0 ? `${this.listId}-${this._active}` : ""}
          placeholder=${this.placeholder}
          inputmode=${this.inputmode as "text"}
          autocomplete="off"
          .value=${this._text}
          @input=${this.onInput}
          @blur=${this.onBlur}
          @keydown=${this.onKeyDown}
        />
        ${
          this.options.length
            ? html`<button
                class="toggle"
                tabindex="-1"
                aria-label=${this._open ? "Hide suggestions" : "Show suggestions"}
                @mousedown=${(e: Event) => e.preventDefault()}
                @click=${() => this.toggle()}
              >
                ${icon(mdiMenuDown)}
              </button>`
            : nothing
        }
      </div>
      ${
        this._open && items.length
          ? html`<ul id=${this.listId} role="listbox" aria-label=${this.label}>
              ${items.map((option, i) =>
                i === divider
                  ? html`<li role="separator" class="divider"></li>
                      ${this.renderOption(option, i, needle)}`
                  : this.renderOption(option, i, needle),
              )}
            </ul>`
          : nothing
      }`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
        position: relative;
        min-width: 0;
      }
      .field {
        display: flex;
        align-items: center;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
      }
      .field:focus-within {
        outline: 2px solid var(--pc-primary);
        outline-offset: 1px;
      }
      input {
        flex: 1;
        width: 100%;
        border: none !important;
        outline: none !important;
        background: transparent !important;
      }
      .toggle {
        display: flex;
        align-items: center;
        align-self: stretch;
        padding: 0 4px;
        border: none;
        background: none;
        color: var(--pc-text-2);
        cursor: pointer;
      }
      ul {
        position: absolute;
        z-index: 20;
        top: calc(100% + 4px);
        left: 0;
        min-width: 100%;
        max-width: calc(100vw - 16px);
        max-height: 260px;
        margin: 0;
        padding: 4px 0;
        overflow: auto;
        list-style: none;
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
      }
      li[role="option"] {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 12px 7px 8px;
        white-space: nowrap;
        cursor: pointer;
      }
      li.active,
      li[role="option"]:hover {
        background: color-mix(in srgb, var(--pc-primary) 12%, transparent);
      }
      .check {
        display: inline-flex;
        width: 16px;
        color: var(--pc-primary);
      }
      .divider {
        height: 1px;
        margin: 4px 0;
        background: var(--pc-divider);
      }
      mark {
        background: none;
        color: var(--pc-primary);
        font-weight: 600;
      }
    `,
  ];
}
