import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import type {
  Action,
  EntityAction,
  HassEntity,
  HomeAssistant,
  ServiceAction,
  SettingValue,
} from "../types";
import {
  ACTION_DOMAINS,
  describe,
  type SettingDescriptor,
  type TemperatureUnits,
} from "../logic/capabilities";
import { controls } from "../styles";
import { icon, mdiDelete } from "../icons";
import "./pc-entity-picker";

const toHex = (rgb: number[]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

const fromHex = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Edits one action. Fires `action-changed` ({ action }) and `remove`.
 * Entity actions list the settings the entity supports; each has a checkbox
 * that decides whether the action sets it.
 */
export class PcActionEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    action: { attribute: false },
    units: { attribute: false },
    entityOnly: { type: Boolean },
    _dataText: { state: true },
    _dataError: { state: true },
  };

  declare hass: HomeAssistant;
  declare action: Action;
  declare units: TemperatureUnits;
  /** Hide the generic service option (used for tab defaults). */
  declare entityOnly: boolean;
  declare _dataText: string | null;
  declare _dataError: string;

  constructor() {
    super();
    this.units = { schedule: "°C", ha: "°C" };
    this.entityOnly = false;
    this._dataText = null;
    this._dataError = "";
  }

  private emit(action: Action): void {
    this.dispatchEvent(new CustomEvent("action-changed", { detail: { action } }));
  }

  private setSetting(action: EntityAction, key: string, value: SettingValue | undefined): void {
    const settings = { ...action.settings };
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    this.emit({ ...action, settings });
  }

  private formatOption(entity: HassEntity, key: string, value: string): string {
    try {
      if (key === "hvac_mode" || key === "state" || key === "option") {
        return this.hass.formatEntityState?.(entity, value) ?? value;
      }
      return this.hass.formatEntityAttributeValue?.(entity, key, value) ?? value;
    } catch {
      return value;
    }
  }

  private renderControl(
    action: EntityAction,
    entity: HassEntity,
    d: SettingDescriptor,
    value: SettingValue,
    enabled: boolean,
  ): TemplateResult {
    const set = (v: SettingValue) => this.setSetting(action, d.key, v);
    const c = d.control;
    switch (c.kind) {
      case "enum":
        return html`<select
          ?disabled=${!enabled}
          aria-label=${d.label}
          @change=${(e: Event) => set((e.target as HTMLSelectElement).value)}
        >
          ${c.options.map(
            (o) =>
              html`<option value=${o} ?selected=${o === value}>
                ${this.formatOption(entity, d.key, o)}
              </option>`,
          )}
        </select>`;
      case "number": {
        const n = typeof value === "number" ? value : Number(d.initial);
        return html`<div class="row number">
          <input
            type="range"
            min=${c.min}
            max=${c.max}
            step=${c.step}
            .value=${String(n)}
            ?disabled=${!enabled}
            aria-label=${d.label}
            @input=${(e: Event) => set(Number((e.target as HTMLInputElement).value))}
          />
          <input
            type="number"
            min=${c.min}
            max=${c.max}
            step=${c.step}
            .value=${String(n)}
            ?disabled=${!enabled}
            aria-label=${d.label}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) set(Math.min(c.max, Math.max(c.min, v)));
            }}
          />
          ${c.unit ? html`<span class="unit">${c.unit}</span>` : nothing}
        </div>`;
      }
      case "range": {
        const r =
          typeof value === "object" && !Array.isArray(value)
            ? value
            : (d.initial as { low: number; high: number });
        const field = (which: "low" | "high") =>
          html`<input
            type="number"
            min=${c.min}
            max=${c.max}
            step=${c.step}
            .value=${String(r[which])}
            ?disabled=${!enabled}
            aria-label=${`${d.label} ${which}`}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (!Number.isFinite(v)) return;
              const next = { ...r, [which]: v };
              if (next.low > next.high) {
                if (which === "low") next.high = v;
                else next.low = v;
              }
              set(next);
            }}
          />`;
        return html`<div class="row">
          ${field("low")}<span class="muted">to</span>${field("high")}
          ${c.unit ? html`<span class="unit">${c.unit}</span>` : nothing}
        </div>`;
      }
      case "bool":
        return html`<select
          ?disabled=${!enabled}
          aria-label=${d.label}
          @change=${(e: Event) => set((e.target as HTMLSelectElement).value === "true")}
        >
          <option value="true" ?selected=${value === true}>On</option>
          <option value="false" ?selected=${value === false}>Off</option>
        </select>`;
      case "rgb":
        return html`<input
          type="color"
          .value=${toHex(Array.isArray(value) ? value : (d.initial as number[]))}
          ?disabled=${!enabled}
          aria-label=${d.label}
          @change=${(e: Event) => set(fromHex((e.target as HTMLInputElement).value))}
        />`;
    }
  }

  private renderEntityAction(action: EntityAction): TemplateResult {
    const entity = action.entity_id ? this.hass.states[action.entity_id] : undefined;
    const descriptors = entity ? describe(entity, this.units) : [];
    const known = new Set(descriptors.map((d) => d.key));
    const unknownKeys = Object.keys(action.settings).filter((k) => !known.has(k));
    return html`
      <div class="row top">
        <pc-entity-picker
          class="grow"
          .hass=${this.hass}
          .value=${action.entity_id}
          .domains=${ACTION_DOMAINS}
          ?invalid=${!action.entity_id}
          label="Entity to set"
          @value-changed=${(e: CustomEvent<{ value: string }>) =>
            this.emit({ ...action, entity_id: e.detail.value, settings: {} })}
        ></pc-entity-picker>
        ${this.renderRemove()}
      </div>
      ${
        entity && !descriptors.length
          ? html`<div class="muted">This entity has no settings Punch Clock can set.</div>`
          : nothing
      }
      ${
        descriptors.length
          ? html`<div class="settings">
              ${descriptors.map((d) => {
                const enabled = d.key in action.settings;
                const value = action.settings[d.key] ?? d.initial;
                return html`<div class="setting ${enabled ? "" : "off"}">
                  <label class="check">
                    <input
                      type="checkbox"
                      .checked=${enabled}
                      @change=${(e: Event) =>
                        this.setSetting(
                          action,
                          d.key,
                          (e.target as HTMLInputElement).checked ? d.initial : undefined,
                        )}
                    />
                    <span>${d.label}</span>
                  </label>
                  <div class="control">
                    ${this.renderControl(action, entity!, d, value, enabled)}
                    ${enabled && d.hint ? html`<div class="hint muted">${d.hint}</div>` : nothing}
                  </div>
                </div>`;
              })}
            </div>`
          : nothing
      }
      ${
        unknownKeys.length
          ? html`<div class="warning-text">
              Saved values this entity no longer offers:
              ${unknownKeys.map((k) => `${k} = ${JSON.stringify(action.settings[k])}`).join(", ")}
              <button
                class="btn text"
                @click=${() => {
                  const settings = { ...action.settings };
                  for (const k of unknownKeys) delete settings[k];
                  this.emit({ ...action, settings });
                }}
              >
                Remove
              </button>
            </div>`
          : nothing
      }
    `;
  }

  private renderServiceAction(action: ServiceAction): TemplateResult {
    const services = Object.entries(this.hass.services ?? {}).flatMap(([domain, list]) =>
      Object.keys(list).map((name) => `${domain}.${name}`),
    );
    const targets = action.target.entity_id ?? [];
    const dataText = this._dataText ?? JSON.stringify(action.data, null, 2);
    return html`
      <div class="row top">
        <input
          class="grow"
          list="pc-services"
          placeholder="Service, e.g. script.turn_on"
          aria-label="Service"
          .value=${action.service}
          @change=${(e: Event) =>
            this.emit({ ...action, service: (e.target as HTMLInputElement).value.trim() })}
        />
        <datalist id="pc-services">
          ${services.map((s) => html`<option value=${s}></option>`)}
        </datalist>
        ${this.renderRemove()}
      </div>
      <div class="targets">
        ${targets.map(
          (entityId) =>
            html`<span class="chip"
              >${this.hass.states[entityId]?.attributes.friendly_name ?? entityId}
              <button
                class="icon-btn small"
                aria-label=${`Remove ${entityId}`}
                @click=${() =>
                  this.emit({
                    ...action,
                    target: { ...action.target, entity_id: targets.filter((t) => t !== entityId) },
                  })}
              >
                ${icon(mdiDelete, 14)}
              </button></span
            >`,
        )}
        <pc-entity-picker
          .hass=${this.hass}
          label="Add target entity (optional)"
          @value-changed=${(e: CustomEvent<{ value: string }>) => {
            if (!e.detail.value || targets.includes(e.detail.value)) return;
            this.emit({
              ...action,
              target: { ...action.target, entity_id: [...targets, e.detail.value] },
            });
          }}
        ></pc-entity-picker>
      </div>
      <label
        >Data (JSON)
        <textarea
          rows="3"
          .value=${dataText}
          @input=${(e: Event) => {
            this._dataText = (e.target as HTMLTextAreaElement).value;
            try {
              const data: unknown = JSON.parse(this._dataText || "{}");
              if (!data || typeof data !== "object" || Array.isArray(data))
                throw new Error("Data must be an object");
              this._dataError = "";
              this.emit({ ...action, data: data as Record<string, unknown> });
            } catch (err) {
              this._dataError = err instanceof Error ? err.message : String(err);
            }
          }}
        ></textarea>
      </label>
      ${this._dataError ? html`<div class="error-text">${this._dataError}</div>` : nothing}
    `;
  }

  private renderRemove(): TemplateResult {
    return html`<button
      class="icon-btn"
      aria-label="Remove action"
      title="Remove action"
      @click=${() => this.dispatchEvent(new CustomEvent("remove"))}
    >
      ${icon(mdiDelete)}
    </button>`;
  }

  protected override render() {
    return this.action.type === "entity"
      ? this.renderEntityAction(this.action)
      : this.renderServiceAction(this.action);
  }

  static override styles = [
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius);
        background: var(--pc-card);
      }
      .top {
        align-items: flex-start;
      }
      .settings {
        display: grid;
        grid-template-columns: minmax(120px, auto) 1fr;
        gap: 8px 12px;
        align-items: start;
      }
      .setting {
        display: contents;
      }
      .setting.off .control {
        opacity: 0.55;
      }
      .check {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 36px;
        color: var(--pc-text);
        font-size: 0.95em;
        cursor: pointer;
      }
      .control {
        min-width: 0;
      }
      .control select {
        width: 100%;
      }
      .number input[type="range"] {
        flex: 1;
        min-width: 60px;
      }
      .number input[type="number"],
      .row input[type="number"] {
        width: 84px;
      }
      .unit {
        color: var(--pc-text-2);
        font-size: 0.9em;
      }
      .hint {
        font-size: 0.8em;
        margin-top: 2px;
      }
      .targets {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .targets pc-entity-picker {
        flex: 1;
        min-width: 200px;
      }
      textarea {
        width: 100%;
        margin-top: 4px;
      }
      input[type="color"] {
        width: 64px;
        height: 36px;
        padding: 2px;
        border: 1px solid var(--pc-divider);
        border-radius: var(--pc-radius-sm);
        background: var(--pc-card);
      }
      @media (max-width: 480px) {
        .settings {
          grid-template-columns: 1fr;
        }
        .check {
          min-height: 0;
        }
      }
    `,
  ];
}
