import { LitElement, css, html } from "lit";
import { MINUTES_PER_DAY, formatMinute } from "../logic/time";
import { controls } from "../styles";
import { icon, mdiClockOutline } from "../icons";
import "./pc-time-picker";

/**
 * A time-of-day field shown in the panel's clock style (12- or 24-hour), unlike
 * <input type="time">, which always follows the browser's locale. Clicking it (or
 * Enter/Space) opens the clock-dial picker; Arrow Up/Down change it by a minute
 * (with Shift, 15). Fires `value-changed` ({ value: minute of the day }).
 */
export class PcTimeInput extends LitElement {
  static override properties = {
    value: { type: Number },
    use24h: { type: Boolean },
    label: {},
    _open: { state: true },
  };

  declare value: number;
  declare use24h: boolean;
  declare label: string;
  declare _open: boolean;

  constructor() {
    super();
    this.value = 0;
    this.use24h = false;
    this.label = "Time";
    this._open = false;
  }

  private emit(minute: number): void {
    if (minute !== this.value) {
      this.dispatchEvent(new CustomEvent("value-changed", { detail: { value: minute } }));
    }
  }

  private close(): void {
    this._open = false;
    this.renderRoot.querySelector<HTMLButtonElement>(".field")?.focus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = (e.shiftKey ? 15 : 1) * (e.key === "ArrowUp" ? 1 : -1);
      this.emit((((this.value + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
    }
  }

  protected override render() {
    return html`<button
        type="button"
        class="field"
        aria-haspopup="dialog"
        aria-label=${`${this.label}: ${formatMinute(this.value, this.use24h)}. Change time`}
        @click=${() => (this._open = true)}
        @keydown=${this.onKeyDown}
      >
        <span class="text">${formatMinute(this.value, this.use24h)}</span>
        ${icon(mdiClockOutline, 18)}
      </button>
      <pc-time-picker
        .open=${this._open}
        .value=${this.value}
        .use24h=${this.use24h}
        .label=${this.label}
        @picked=${(e: CustomEvent<{ value: number }>) => {
          this.emit(e.detail.value);
          this.close();
        }}
        @closed=${() => this.close()}
      ></pc-time-picker>`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
      }
      .field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        width: 100%;
        min-height: 36px;
        padding: 6px 8px 6px 10px;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
        color: var(--pc-text);
        cursor: pointer;
        text-align: left;
        font-variant-numeric: tabular-nums;
      }
      .field:hover {
        border-color: color-mix(in srgb, var(--pc-text) 35%, transparent);
      }
      .field svg {
        color: var(--pc-text-2);
        flex: none;
      }
    `,
  ];
}
