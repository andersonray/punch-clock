import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { controls } from "../styles";
import { icon, mdiClose } from "../icons";

/**
 * A modal dialog on the native <dialog> element (top layer, Esc to close, focus
 * handling). Fires `closed` when dismissed by the user.
 */
export class PcDialog extends LitElement {
  static override properties = {
    open: { type: Boolean },
    heading: {},
    wide: { type: Boolean },
  };

  declare open: boolean;
  declare heading: string;
  declare wide: boolean;

  constructor() {
    super();
    this.open = false;
    this.heading = "";
    this.wide = false;
  }

  private get dialog(): HTMLDialogElement | null {
    return this.renderRoot.querySelector("dialog");
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("open")) return;
    const dialog = this.dialog;
    if (!dialog) return;
    if (this.open && !dialog.open) dialog.showModal();
    if (!this.open && dialog.open) dialog.close();
  }

  private onCancel(e: Event): void {
    e.preventDefault();
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private onBackdrop(e: MouseEvent): void {
    if (e.target === this.dialog) this.dispatchEvent(new CustomEvent("closed"));
  }

  protected override render() {
    return html`<dialog
      class=${this.wide ? "wide" : ""}
      @cancel=${this.onCancel}
      @click=${this.onBackdrop}
      aria-label=${this.heading}
    >
      <div class="frame">
        <header>
          <h2>${this.heading}</h2>
          <button
            class="icon-btn"
            aria-label="Close"
            @click=${() => this.dispatchEvent(new CustomEvent("closed"))}
          >
            ${icon(mdiClose)}
          </button>
        </header>
        <div class="content">${this.open ? html`<slot></slot>` : nothing}</div>
        <footer><slot name="actions"></slot></footer>
      </div>
    </dialog>`;
  }

  static override styles = [
    controls,
    css`
      dialog {
        padding: 0;
        border: none;
        border-radius: var(--pc-radius);
        background: var(--pc-card);
        color: var(--pc-text);
        width: min(480px, calc(100vw - 32px));
        max-height: calc(100dvh - 32px);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
      }
      dialog.wide {
        width: min(720px, calc(100vw - 32px));
      }
      dialog::backdrop {
        background: rgba(0, 0, 0, 0.45);
      }
      .frame {
        display: flex;
        flex-direction: column;
        max-height: calc(100dvh - 32px);
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 8px 4px 20px;
      }
      h2 {
        flex: 1;
        margin: 0;
        font-size: 1.15em;
        font-weight: 500;
      }
      .content {
        padding: 8px 20px 16px;
        overflow: auto;
      }
      footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 20px 16px;
        border-top: 1px solid var(--pc-divider);
      }
      @media (max-width: 600px) {
        dialog,
        dialog.wide {
          width: 100vw;
          max-width: 100vw;
          height: 100dvh;
          max-height: 100dvh;
          border-radius: 0;
        }
        .frame {
          height: 100%;
          max-height: 100dvh;
        }
        .content {
          flex: 1;
        }
      }
    `,
  ];
}
