import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import type { PunchClockApi } from "../api";
import { errorMessage } from "../api";
import type {
  Action,
  Config,
  EntityAction,
  ExplainNode,
  Group,
  HomeAssistant,
  Tab,
} from "../types";
import {
  actionProblems,
  conditionProblems,
  emptyGroup,
  feedbackEntities,
  friendlyName,
  newEntityAction,
} from "../logic/model";
import type { TemperatureUnits } from "../logic/capabilities";
import { controls } from "../styles";
import { icon, mdiPlus } from "../icons";
import "./pc-dialog";
import "./pc-action-editor";
import "./pc-condition-editor";

type TabDraft = Omit<Tab, "id">;

/**
 * Create or edit a tab: name, enabled, conditions and default values.
 * Fires `saved` ({ tabId }) and `closed`.
 */
export class PcTabDialog extends LitElement {
  static override properties = {
    open: { type: Boolean },
    hass: { attribute: false },
    api: { attribute: false },
    config: { attribute: false },
    tab: { attribute: false },
    units: { attribute: false },
    _draft: { state: true },
    _explain: { state: true },
    _error: { state: true },
    _saving: { state: true },
  };

  declare open: boolean;
  declare hass: HomeAssistant;
  declare api: PunchClockApi;
  declare config: Config;
  /** The tab to edit, or null to create a new one. */
  declare tab: Tab | null;
  declare units: TemperatureUnits;
  declare _draft: TabDraft;
  declare _explain: ExplainNode | null;
  declare _error: string;
  declare _saving: boolean;

  private evaluateTimer = 0;

  constructor() {
    super();
    this.open = false;
    this.tab = null;
    this.units = { schedule: "°C", ha: "°C" };
    this._draft = { name: "", enabled: true, conditions: emptyGroup(), defaults: [] };
    this._explain = null;
    this._error = "";
    this._saving = false;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) {
      this._draft = this.tab
        ? structuredClone({
            name: this.tab.name,
            enabled: this.tab.enabled,
            conditions: this.tab.conditions,
            defaults: this.tab.defaults,
          })
        : { name: "", enabled: true, conditions: emptyGroup(), defaults: [] };
      this._error = "";
      this._explain = null;
      this.scheduleEvaluate();
    }
  }

  private scheduleEvaluate(): void {
    window.clearTimeout(this.evaluateTimer);
    this.evaluateTimer = window.setTimeout(async () => {
      if (conditionProblems(this._draft.conditions).length) return;
      try {
        this._explain = await this.api.evaluate(this._draft.conditions);
      } catch {
        this._explain = null;
      }
    }, 300);
  }

  private patch(changes: Partial<TabDraft>): void {
    this._draft = { ...this._draft, ...changes };
    this._error = "";
    if (changes.conditions) this.scheduleEvaluate();
  }

  private async save(): Promise<void> {
    const d = this._draft;
    const problems = [
      ...(d.name.trim() ? [] : ["Give the tab a name."]),
      ...actionProblems(d.defaults),
      ...conditionProblems(d.conditions),
    ];
    if (problems.length) {
      this._error = problems.join(" ");
      return;
    }
    this._saving = true;
    try {
      const payload = { ...d, name: d.name.trim() };
      const { tab } = this.tab
        ? await this.api.updateTab(this.tab.id, payload)
        : await this.api.createTab(payload);
      this.dispatchEvent(new CustomEvent("saved", { detail: { tabId: tab.id } }));
    } catch (err) {
      this._error = errorMessage(err);
    } finally {
      this._saving = false;
    }
  }

  protected override render() {
    if (!this.hass) return nothing;
    const d = this._draft;
    const setDefault = (i: number, action: Action | null) => {
      const defaults = [...d.defaults];
      if (action) defaults[i] = action as EntityAction;
      else defaults.splice(i, 1);
      this.patch({ defaults });
    };
    const feedback = feedbackEntities(d.conditions, this.config);
    return html`<pc-dialog
      wide
      .open=${this.open}
      heading=${this.tab ? `Edit tab "${this.tab.name}"` : "New tab"}
      @closed=${() => this.dispatchEvent(new CustomEvent("closed"))}
    >
      <div class="form">
        <div class="row">
          <label class="grow"
            >Name
            <input
              .value=${d.name}
              placeholder="e.g. Workweek, Vacation, Guests"
              @input=${(e: Event) => this.patch({ name: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="row enabled">
            <span class="switch">
              <input
                type="checkbox"
                .checked=${d.enabled}
                @change=${(e: Event) => this.patch({ enabled: (e.target as HTMLInputElement).checked })}
              />
              <span></span>
            </span>
            Enabled
          </label>
        </div>

        <section>
          <h3>Conditions</h3>
          <p class="muted">
            The tab's schedule only runs while these are true. Every tab whose conditions are true
            runs at the same time; where two tabs set the same thing, the tab further left wins.
          </p>
          <pc-condition-editor
            .hass=${this.hass}
            .group=${d.conditions}
            .explain=${this._explain}
            @group-changed=${(e: CustomEvent<{ group: Group }>) => this.patch({ conditions: e.detail.group })}
          ></pc-condition-editor>
          ${
            feedback.length
              ? html`<div class="warning-text">
                  ${feedback.map((e) => friendlyName(e, this.hass.states)).join(", ")} also
                  ${feedback.length === 1 ? "is" : "are"} controlled by this schedule, which can
                  make the tab switch on and off repeatedly.
                </div>`
              : nothing
          }
        </section>

        <section>
          <h3>Default values</h3>
          <p class="muted">
            What an entity goes back to when none of this tab's blocks is setting it. Entities
            without a default keep whatever value they have.
          </p>
          ${d.defaults.map(
            (action, i) =>
              html`<pc-action-editor
                entityOnly
                .hass=${this.hass}
                .action=${action}
                .units=${this.units}
                @action-changed=${(e: CustomEvent<{ action: Action }>) => setDefault(i, e.detail.action)}
                @remove=${() => setDefault(i, null)}
              ></pc-action-editor>`,
          )}
          <div>
            <button
              class="btn"
              @click=${() => this.patch({ defaults: [...d.defaults, newEntityAction()] })}
            >
              ${icon(mdiPlus, 18)} Default value
            </button>
          </div>
        </section>
        ${this._error ? html`<div class="error-text">${this._error}</div>` : nothing}
      </div>
      <button
        slot="actions"
        class="btn"
        @click=${() => this.dispatchEvent(new CustomEvent("closed"))}
      >
        Cancel
      </button>
      <button
        slot="actions"
        class="btn primary"
        ?disabled=${this._saving}
        @click=${() => void this.save()}
      >
        ${this.tab ? "Save" : "Create tab"}
      </button>
    </pc-dialog>`;
  }

  static override styles = [
    controls,
    css`
      .form {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      label.grow {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .enabled {
        align-self: flex-end;
        min-height: 36px;
        color: var(--pc-text);
        font-size: 0.95em;
      }
      section {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      h3 {
        margin: 0;
        font-size: 1em;
        font-weight: 500;
      }
      p {
        margin: 0;
        font-size: 0.9em;
      }
    `,
  ];
}
