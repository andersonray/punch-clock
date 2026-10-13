import { LitElement, css, html } from "lit";
import { live } from "lit/directives/live.js";
import { MINUTES_PER_DAY, formatMinute, parseTimeText } from "../logic/time";
import { controls } from "../styles";

/**
 * A time-of-day field shown in the panel's clock style (12- or 24-hour), unlike
 * <input type="time">, which always follows the browser's locale. Accepts typed
 * times in either style; Arrow Up/Down change it by a minute (with Shift, 15).
 * Fires `value-changed` ({ value: minute of the day }).
 */
export class PcTimeInput extends LitElement {
  static override properties = {
    value: { type: Number },
    use24h: { type: Boolean },
    label: {},
    _invalid: { state: true },
  };

  declare value: number;
  declare use24h: boolean;
  declare label: string;
  declare _invalid: boolean;

  constructor() {
    super();
    this.value = 0;
    this.use24h = false;
    this.label = "Time";
    this._invalid = false;
  }

  private emit(minute: number): void {
    this._invalid = false;
    if (minute !== this.value) {
      this.dispatchEvent(new CustomEvent("value-changed", { detail: { value: minute } }));
    }
  }

  private onChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const minute = parseTimeText(input.value);
    if (minute === null) {
      this._invalid = true;
      return;
    }
    input.value = formatMinute(minute, this.use24h);
    this.emit(minute);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = (e.shiftKey ? 15 : 1) * (e.key === "ArrowUp" ? 1 : -1);
    this.emit((((this.value + step) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
  }

  protected override render() {
    return html`<input
      type="text"
      autocomplete="off"
      spellcheck="false"
      aria-label=${this.label}
      aria-invalid=${this._invalid ? "true" : "false"}
      title=${this.use24h ? "e.g. 18:30" : "e.g. 6:30 PM"}
      class=${this._invalid ? "invalid" : ""}
      .value=${live(formatMinute(this.value, this.use24h))}
      @change=${this.onChange}
      @keydown=${this.onKeyDown}
    />`;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: block;
      }
      input {
        width: 100%;
      }
      input.invalid {
        border-color: var(--pc-error);
      }
    `,
  ];
}
