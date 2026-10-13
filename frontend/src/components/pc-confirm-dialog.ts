import { LitElement, css, html } from "lit";
import { controls } from "../styles";
import "./pc-dialog";

export interface ConfirmOptions {
  heading: string;
  text: string;
  confirmText?: string;
  destructive?: boolean;
}

/** A yes/no dialog. Call `ask()` and await the answer. */
export class PcConfirmDialog extends LitElement {
  static override properties = {
    _options: { state: true },
  };

  declare _options: ConfirmOptions | null;
  private resolve: ((answer: boolean) => void) | null = null;

  constructor() {
    super();
    this._options = null;
  }

  ask(options: ConfirmOptions): Promise<boolean> {
    this.resolve?.(false);
    this._options = options;
    return new Promise((resolve) => (this.resolve = resolve));
  }

  private answer(value: boolean): void {
    this.resolve?.(value);
    this.resolve = null;
    this._options = null;
  }

  protected override render() {
    const o = this._options;
    return html`<pc-dialog
      .open=${!!o}
      heading=${o?.heading ?? ""}
      @closed=${() => this.answer(false)}
    >
      <p>${o?.text}</p>
      <button slot="actions" class="btn" @click=${() => this.answer(false)}>Cancel</button>
      <button
        slot="actions"
        class="btn ${o?.destructive ? "danger" : "primary"}"
        @click=${() => this.answer(true)}
      >
        ${o?.confirmText ?? "OK"}
      </button>
    </pc-dialog>`;
  }

  static override styles = [
    controls,
    css`
      p {
        margin: 0;
        line-height: 1.5;
      }
    `,
  ];
}
