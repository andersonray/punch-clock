import { LitElement, css, html } from "lit";
import { controls } from "../styles";
import "./pc-dialog";

export interface ConfirmOptions {
  heading: string;
  text: string;
  confirmText?: string;
  destructive?: boolean;
}

export interface Choice {
  value: string;
  label: string;
  kind?: "primary" | "danger" | "plain";
}

export interface ChoiceOptions {
  heading: string;
  text: string;
  /** Buttons shown after Cancel, left to right. */
  choices: Choice[];
}

/** A dialog asking the user to choose. Call `ask()` (yes/no) or `choose()` and await it. */
export class PcConfirmDialog extends LitElement {
  static override properties = {
    _options: { state: true },
  };

  declare _options: ChoiceOptions | null;
  private resolve: ((choice: string | null) => void) | null = null;

  constructor() {
    super();
    this._options = null;
  }

  /** Resolves to the chosen value, or null if cancelled. */
  choose(options: ChoiceOptions): Promise<string | null> {
    this.resolve?.(null);
    this._options = options;
    return new Promise((resolve) => (this.resolve = resolve));
  }

  async ask(options: ConfirmOptions): Promise<boolean> {
    const choice = await this.choose({
      heading: options.heading,
      text: options.text,
      choices: [
        {
          value: "yes",
          label: options.confirmText ?? "OK",
          kind: options.destructive ? "danger" : "primary",
        },
      ],
    });
    return choice === "yes";
  }

  private answer(value: string | null): void {
    this.resolve?.(value);
    this.resolve = null;
    this._options = null;
  }

  protected override render() {
    const o = this._options;
    return html`<pc-dialog
      .open=${!!o}
      heading=${o?.heading ?? ""}
      @closed=${() => this.answer(null)}
    >
      <p>${o?.text}</p>
      <button slot="actions" class="btn" @click=${() => this.answer(null)}>Cancel</button>
      ${(o?.choices ?? []).map(
        (c) =>
          html`<button
            slot="actions"
            class="btn ${c.kind === "plain" ? "" : (c.kind ?? "primary")}"
            @click=${() => this.answer(c.value)}
          >
            ${c.label}
          </button>`,
      )}
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
