import { LitElement, css, html, nothing, svg, type PropertyValues } from "lit";
import {
  DIAL_CENTER,
  DIAL_SIZE,
  hourAt,
  hourItems,
  minuteAt,
  minuteItems,
  polar,
  to12,
  to24,
} from "../logic/clock";
import { controls } from "../styles";
import { icon, mdiClockOutline, mdiKeyboardOutline } from "../icons";

const KNOB_RADIUS = 20;
const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * A modal clock-dial time picker modeled on Android's: pick the hour on the dial
 * (it then switches to minutes), pick the minute, then OK. In 12-hour mode there's
 * an AM/PM toggle; in 24-hour mode the dial has an inner ring for 00 and 13-23
 * instead. The keyboard icon switches to typing the hour and minute.
 *
 * Events: `picked` ({ value: minute of the day }), `closed` (cancelled).
 */
export class PcTimePicker extends LitElement {
  static override properties = {
    open: { type: Boolean },
    value: { type: Number },
    use24h: { type: Boolean },
    label: {},
    _hour: { state: true },
    _minute: { state: true },
    _view: { state: true },
    _mode: { state: true },
    _hourText: { state: true },
    _minuteText: { state: true },
    _error: { state: true },
  };

  declare open: boolean;
  declare value: number;
  declare use24h: boolean;
  /** What is being picked, e.g. "Start"; shown in the title. */
  declare label: string;
  declare _hour: number;
  declare _minute: number;
  declare _view: "hour" | "minute";
  declare _mode: "dial" | "input";
  declare _hourText: string;
  declare _minuteText: string;
  declare _error: string;

  private dragging = false;

  constructor() {
    super();
    this.open = false;
    this.value = 0;
    this.use24h = false;
    this.label = "";
    this._hour = 0;
    this._minute = 0;
    this._view = "hour";
    this._mode = "dial";
    this._hourText = "";
    this._minuteText = "";
    this._error = "";
  }

  private get dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector("dialog");
  }

  private get pm(): boolean {
    return this._hour >= 12;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) {
      this._hour = Math.floor(this.value / 60) % 24;
      this._minute = this.value % 60;
      this._view = "hour";
      this._mode = "dial";
      this._error = "";
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("open")) return;
    const dialog = this.dialog;
    if (!dialog) return;
    if (this.open && !dialog.open) {
      dialog.showModal();
      this.renderRoot.querySelector<SVGElement>(".dial")?.focus();
    } else if (!this.open && dialog.open) {
      dialog.close();
    }
  }

  private setPm(pm: boolean): void {
    if (pm !== this.pm) this._hour = (this._hour + 12) % 24;
  }

  private hourLabel(): string {
    return this.use24h ? pad(this._hour) : String(to12(this._hour));
  }

  // --- Dial ----------------------------------------------------------------------

  private pointerOffset(e: PointerEvent): { dx: number; dy: number } {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const scale = rect.width ? DIAL_SIZE / rect.width : 1;
    return {
      dx: (e.clientX - rect.left - rect.width / 2) * scale,
      dy: (e.clientY - rect.top - rect.height / 2) * scale,
    };
  }

  private pickAt(e: PointerEvent): void {
    const { dx, dy } = this.pointerOffset(e);
    if (this._view === "hour") {
      const hour = hourAt(dx, dy, this.use24h);
      this._hour = this.use24h ? hour : to24(hour, this.pm);
    } else {
      this._minute = minuteAt(dx, dy);
    }
  }

  private onDialDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    this.dragging = true;
    this.pickAt(e);
  }

  private onDialMove(e: PointerEvent): void {
    if (this.dragging) this.pickAt(e);
  }

  private onDialUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.pickAt(e);
    // Like Android: after choosing the hour, go on to the minutes.
    if (this._view === "hour") this._view = "minute";
  }

  private onDialKey(e: KeyboardEvent): void {
    const step =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (step) {
      e.preventDefault();
      if (this._view === "hour") this._hour = (this._hour + step + 24) % 24;
      else this._minute = (this._minute + step * (e.shiftKey ? 5 : 1) + 60) % 60;
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this._view === "hour") this._view = "minute";
      else this.confirm();
    }
  }

  private renderDial() {
    const hourView = this._view === "hour";
    const items = hourView ? hourItems(this.use24h) : minuteItems();
    const dialHour = this.use24h ? this._hour : to12(this._hour);
    const selected = hourView
      ? items.find((i) => i.value === dialHour)!
      : { angle: this._minute * 6, radius: items[0]!.radius, inner: false };
    const knob = polar(selected.angle, selected.radius);
    const knobRadius = selected.inner ? KNOB_RADIUS - 3 : KNOB_RADIUS;
    const valueText = hourView ? `${this.hourLabel()} o'clock` : `${this._minute} minutes`;
    return html`<svg
      class="dial"
      viewBox="0 0 ${DIAL_SIZE} ${DIAL_SIZE}"
      role="slider"
      tabindex="0"
      aria-label=${hourView ? "Hour" : "Minute"}
      aria-valuemin="0"
      aria-valuemax=${hourView ? 23 : 59}
      aria-valuenow=${hourView ? this._hour : this._minute}
      aria-valuetext=${valueText}
      @pointerdown=${this.onDialDown}
      @pointermove=${this.onDialMove}
      @pointerup=${this.onDialUp}
      @pointercancel=${() => (this.dragging = false)}
      @keydown=${this.onDialKey}
    >
      ${svg`
        <circle class="face" cx=${DIAL_CENTER} cy=${DIAL_CENTER} r=${DIAL_CENTER}></circle>
        <line class="hand" x1=${DIAL_CENTER} y1=${DIAL_CENTER} x2=${knob.x} y2=${knob.y}></line>
        <circle class="hub" cx=${DIAL_CENTER} cy=${DIAL_CENTER} r="4"></circle>
        <circle class="knob" cx=${knob.x} cy=${knob.y} r=${knobRadius}></circle>
        ${
          !hourView && this._minute % 5
            ? svg`<circle class="knob-dot" cx=${knob.x} cy=${knob.y} r="3"></circle>`
            : nothing
        }
        ${items.map((item) => {
          const p = polar(item.angle, item.radius);
          const on = hourView ? item.value === dialHour : item.value === this._minute;
          return svg`<text x=${p.x} y=${p.y} class=${`${item.inner ? "inner" : ""} ${on ? "on" : ""}`}>${item.label}</text>`;
        })}
      `}
    </svg>`;
  }

  // --- Keyboard entry --------------------------------------------------------------

  private enterInputMode(): void {
    this._hourText = this.hourLabel();
    this._minuteText = pad(this._minute);
    this._error = "";
    this._mode = "input";
  }

  /** Apply the typed hour and minute; returns false (and shows why) if invalid. */
  private applyInput(): boolean {
    const hour = Number(this._hourText);
    const minute = Number(this._minuteText);
    const hourOk =
      /^\d{1,2}$/.test(this._hourText.trim()) &&
      (this.use24h ? hour <= 23 : hour >= 1 && hour <= 12);
    const minuteOk = /^\d{1,2}$/.test(this._minuteText.trim()) && minute <= 59;
    if (!hourOk || !minuteOk) {
      this._error = this.use24h
        ? "Enter an hour 0–23 and a minute 0–59."
        : "Enter an hour 1–12 and a minute 0–59.";
      return false;
    }
    this._hour = this.use24h ? hour : to24(hour, this.pm);
    this._minute = minute;
    this._error = "";
    return true;
  }

  private toggleMode(): void {
    if (this._mode === "dial") this.enterInputMode();
    else if (this.applyInput()) {
      this._mode = "dial";
      this._view = "hour";
    }
  }

  private renderInputs() {
    const field = (label: string, value: string, set: (v: string) => void) =>
      html`<label class="field">
        <input
          inputmode="numeric"
          maxlength="2"
          aria-label=${label}
          .value=${value}
          @input=${(e: Event) => set((e.target as HTMLInputElement).value)}
          @focus=${(e: FocusEvent) => (e.target as HTMLInputElement).select()}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              this.confirm();
            }
          }}
        />
        <span>${label}</span>
      </label>`;
    return html`<div class="header input">
        ${field("Hour", this._hourText, (v) => (this._hourText = v))}
        <span class="colon">:</span>
        ${field("Minute", this._minuteText, (v) => (this._minuteText = v))} ${this.renderAmPm()}
      </div>
      ${this._error ? html`<div class="error-text">${this._error}</div>` : nothing}`;
  }

  // --- Frame ------------------------------------------------------------------------

  private renderAmPm() {
    if (this.use24h) return nothing;
    return html`<div class="ampm" role="radiogroup" aria-label="AM or PM">
      <button
        role="radio"
        aria-checked=${this.pm ? "false" : "true"}
        class=${this.pm ? "" : "on"}
        @click=${() => this.setPm(false)}
      >
        AM
      </button>
      <button
        role="radio"
        aria-checked=${this.pm ? "true" : "false"}
        class=${this.pm ? "on" : ""}
        @click=${() => this.setPm(true)}
      >
        PM
      </button>
    </div>`;
  }

  private confirm(): void {
    if (this._mode === "input" && !this.applyInput()) return;
    this.dispatchEvent(
      new CustomEvent("picked", { detail: { value: this._hour * 60 + this._minute } }),
    );
  }

  private cancel(): void {
    this.dispatchEvent(new CustomEvent("closed"));
  }

  protected override render() {
    const hourView = this._view === "hour";
    return html`<dialog
      aria-label=${this.label ? `${this.label} time` : "Select time"}
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.cancel();
      }}
      @click=${(e: MouseEvent) => {
        if (e.target === this.dialog) this.cancel();
      }}
    >
      <div class="title">
        ${this._mode === "dial" ? "Select time" : "Enter time"}${this.label ? ` · ${this.label}` : ""}
      </div>
      ${
        this._mode === "dial"
          ? html`<div class="header">
                <button
                  class="seg ${hourView ? "on" : ""}"
                  aria-label="Hour"
                  aria-pressed=${hourView ? "true" : "false"}
                  @click=${() => (this._view = "hour")}
                >
                  ${this.hourLabel()}
                </button>
                <span class="colon">:</span>
                <button
                  class="seg ${hourView ? "" : "on"}"
                  aria-label="Minute"
                  aria-pressed=${hourView ? "false" : "true"}
                  @click=${() => (this._view = "minute")}
                >
                  ${pad(this._minute)}
                </button>
                ${this.renderAmPm()}
              </div>
              ${this.renderDial()}`
          : this.renderInputs()
      }
      <footer>
        <button
          class="icon-btn"
          aria-label=${this._mode === "dial" ? "Type the time" : "Use the clock"}
          title=${this._mode === "dial" ? "Type the time" : "Use the clock"}
          @click=${() => this.toggleMode()}
        >
          ${icon(this._mode === "dial" ? mdiKeyboardOutline : mdiClockOutline)}
        </button>
        <span class="grow"></span>
        <button class="btn text" @click=${() => this.cancel()}>Cancel</button>
        <button class="btn text ok" @click=${() => this.confirm()}>OK</button>
      </footer>
    </dialog>`;
  }

  static override styles = [
    controls,
    css`
      dialog {
        width: min(328px, calc(100vw - 24px));
        padding: 24px 24px 12px;
        border: none;
        border-radius: 28px;
        background: var(--pc-card);
        color: var(--pc-text);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
      }
      dialog::backdrop {
        background: rgba(0, 0, 0, 0.45);
      }
      .title {
        margin-bottom: 20px;
        font-size: 0.8em;
        font-weight: 500;
        letter-spacing: 0.04em;
        color: var(--pc-text-2);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }
      .seg {
        width: 96px;
        height: 80px;
        border: none;
        border-radius: 8px;
        background: var(--pc-bg-2);
        color: var(--pc-text);
        font-size: 3em;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }
      .seg.on {
        background: color-mix(in srgb, var(--pc-primary) 20%, var(--pc-card));
        color: var(--pc-primary);
      }
      .colon {
        font-size: 3em;
        line-height: 1;
        padding: 0 2px;
      }
      .ampm {
        display: flex;
        flex-direction: column;
        height: 80px;
        width: 52px;
        margin-left: 6px;
        border: 1px solid var(--pc-divider);
        border-radius: 8px;
        overflow: hidden;
      }
      .ampm button {
        flex: 1;
        border: none;
        background: none;
        color: var(--pc-text-2);
        font-weight: 500;
        cursor: pointer;
      }
      .ampm button + button {
        border-top: 1px solid var(--pc-divider);
      }
      .ampm button.on {
        background: color-mix(in srgb, var(--pc-primary) 20%, var(--pc-card));
        color: var(--pc-primary);
      }
      .dial {
        display: block;
        width: 256px;
        max-width: 100%;
        margin: 32px auto 8px;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        cursor: pointer;
        border-radius: 50%;
      }
      .dial:focus-visible {
        outline: 2px solid var(--pc-primary);
        outline-offset: 4px;
      }
      .dial * {
        pointer-events: none;
      }
      .face {
        fill: var(--pc-bg-2);
      }
      .hand {
        stroke: var(--pc-primary);
        stroke-width: 2;
      }
      .hub,
      .knob {
        fill: var(--pc-primary);
      }
      .knob-dot {
        fill: var(--pc-on-primary);
      }
      text {
        fill: var(--pc-text);
        font-size: 16px;
        text-anchor: middle;
        dominant-baseline: central;
        font-variant-numeric: tabular-nums;
      }
      text.inner {
        fill: var(--pc-text-2);
        font-size: 13px;
      }
      text.on {
        fill: var(--pc-on-primary);
      }
      .header.input {
        align-items: flex-start;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        color: var(--pc-text-2);
        font-size: 0.8em;
      }
      .field input {
        width: 96px;
        height: 72px;
        font-size: 2.6em;
        text-align: center;
        border-radius: 8px;
        background: var(--pc-bg-2);
        font-variant-numeric: tabular-nums;
      }
      .field input:focus {
        background: var(--pc-card);
        border: 2px solid var(--pc-primary);
        outline: none;
      }
      .error-text {
        margin-top: 8px;
      }
      footer {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 20px;
      }
      .btn.text.ok {
        font-weight: 600;
      }
      @media (max-width: 360px) {
        .seg,
        .field input {
          width: 76px;
        }
      }
    `,
  ];
}
