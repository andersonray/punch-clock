import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import type { Condition, ExplainNode, Group, HomeAssistant, Operator } from "../types";
import {
  MAX_CONDITION_DEPTH,
  emptyGroup,
  isNumeric,
  newCondition,
  valueSuggestions,
} from "../logic/model";
import { controls } from "../styles";
import { icon, mdiDelete, mdiPlus } from "../icons";
import "./pc-entity-picker";
import "./pc-combobox";

const OPERATORS: { value: Operator; label: string }[] = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "gt", label: "is greater than" },
  { value: "lt", label: "is less than" },
];

const HIDDEN_ATTRIBUTES = new Set([
  "friendly_name",
  "icon",
  "entity_picture",
  "supported_features",
  "attribution",
  "assumed_state",
  "editable",
  "id",
]);

function findNode(node: ExplainNode | null | undefined, id: string): ExplainNode | undefined {
  if (!node) return undefined;
  if (node.id === id) return node;
  for (const child of node.items ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Edits a condition group (recursively). Fires `group-changed` ({ group }) and,
 * for nested groups, `remove`.
 */
export class PcConditionEditor extends LitElement {
  static override properties = {
    hass: { attribute: false },
    group: { attribute: false },
    explain: { attribute: false },
    depth: { type: Number },
  };

  declare hass: HomeAssistant;
  declare group: Group;
  /** Live evaluation of the whole tree (from punch_clock/conditions/evaluate). */
  declare explain: ExplainNode | null;
  declare depth: number;

  constructor() {
    super();
    this.explain = null;
    this.depth = 1;
  }

  private emit(group: Group): void {
    this.dispatchEvent(new CustomEvent("group-changed", { detail: { group } }));
  }

  private replaceItem(index: number, item: Condition | Group | null): void {
    const items = [...this.group.items];
    if (item) items[index] = item;
    else items.splice(index, 1);
    this.emit({ ...this.group, items });
  }

  private zones(): string[] {
    return Object.values(this.hass.states)
      .filter((e) => e.entity_id.startsWith("zone.") && e.entity_id !== "zone.home")
      .map((e) => e.attributes.friendly_name ?? e.entity_id);
  }

  private resultChip(id: string): TemplateResult | typeof nothing {
    const node = findNode(this.explain, id);
    if (!node) return nothing;
    const actual =
      node.type === "condition"
        ? node.known
          ? `Current value: ${String(node.actual)}`
          : "The entity or attribute is unavailable, so this is false."
        : "";
    return html`<span class="chip ${node.result ? "true" : "false"}" title=${actual}>
      ${node.result ? "true" : "false"}
    </span>`;
  }

  private renderCondition(condition: Condition, index: number): TemplateResult {
    const entity = condition.entity_id ? this.hass.states[condition.entity_id] : undefined;
    const attributes = entity
      ? Object.keys(entity.attributes).filter((a) => !HIDDEN_ATTRIBUTES.has(a))
      : [];
    if (condition.attribute && !attributes.includes(condition.attribute)) {
      attributes.unshift(condition.attribute);
    }
    const suggestions = valueSuggestions(entity, condition.attribute, this.zones());
    const update = (changes: Partial<Condition>) =>
      this.replaceItem(index, { ...condition, ...changes });
    const numeric = condition.operator === "gt" || condition.operator === "lt";
    return html`<div class="condition">
      <pc-entity-picker
        class="entity"
        .hass=${this.hass}
        .value=${condition.entity_id}
        ?invalid=${!condition.entity_id}
        label="Entity"
        @value-changed=${(e: CustomEvent<{ value: string }>) =>
          update({ entity_id: e.detail.value, attribute: null, value: "" })}
      ></pc-entity-picker>
      <select
        class="attr"
        aria-label="State or attribute"
        @change=${(e: Event) => update({ attribute: (e.target as HTMLSelectElement).value || null })}
      >
        <option value="" ?selected=${!condition.attribute}>state</option>
        ${attributes.map(
          (a) => html`<option value=${a} ?selected=${a === condition.attribute}>${a}</option>`,
        )}
      </select>
      <select
        class="op"
        aria-label="Comparison"
        @change=${(e: Event) => update({ operator: (e.target as HTMLSelectElement).value as Operator })}
      >
        ${OPERATORS.map(
          (o) =>
            html`<option value=${o.value} ?selected=${o.value === condition.operator}>
              ${o.label}
            </option>`,
        )}
      </select>
      <pc-combobox
        class="value"
        label="Value"
        placeholder=${numeric || isNumeric(entity, condition.attribute) ? "Number" : "Value"}
        inputmode=${numeric ? "decimal" : "text"}
        .value=${condition.value}
        .options=${suggestions}
        @value-changed=${(e: CustomEvent<{ value: string }>) => update({ value: e.detail.value })}
      ></pc-combobox>
      ${this.resultChip(condition.id)}
      <button
        class="icon-btn small remove"
        aria-label="Remove condition"
        title="Remove condition"
        @click=${() => this.replaceItem(index, null)}
      >
        ${icon(mdiDelete, 18)}
      </button>
    </div>`;
  }

  protected override render() {
    const group = this.group;
    const canNest = this.depth < MAX_CONDITION_DEPTH;
    return html`
      <div class="head">
        <span>Match</span>
        <select
          aria-label="Match all or any"
          @change=${(e: Event) =>
            this.emit({ ...group, mode: (e.target as HTMLSelectElement).value as Group["mode"] })}
        >
          <option value="all" ?selected=${group.mode === "all"}>all</option>
          <option value="any" ?selected=${group.mode === "any"}>any</option>
        </select>
        <span>of these</span>
        ${this.resultChip(group.id)}
        <span class="grow"></span>
        ${
          this.depth > 1
            ? html`<button
                class="icon-btn small"
                aria-label="Remove group"
                title="Remove group"
                @click=${() => this.dispatchEvent(new CustomEvent("remove"))}
              >
                ${icon(mdiDelete, 18)}
              </button>`
            : nothing
        }
      </div>
      <div class="items">
        ${
          group.items.length
            ? group.items.map((item, i) =>
                item.type === "group"
                  ? html`<pc-condition-editor
                      class="nested"
                      .hass=${this.hass}
                      .group=${item}
                      .explain=${this.explain}
                      .depth=${this.depth + 1}
                      @group-changed=${(e: CustomEvent<{ group: Group }>) => {
                        e.stopPropagation();
                        this.replaceItem(i, e.detail.group);
                      }}
                      @remove=${(e: Event) => {
                        e.stopPropagation();
                        this.replaceItem(i, null);
                      }}
                    ></pc-condition-editor>`
                  : this.renderCondition(item, i),
              )
            : html`<div class="empty muted">
                No conditions.
                ${this.depth === 1 ? "This always applies." : "An empty group is true."}
              </div>`
        }
      </div>
      <div class="add">
        <button
          class="btn text"
          @click=${() => this.emit({ ...group, items: [...group.items, newCondition()] })}
        >
          ${icon(mdiPlus, 18)} Condition
        </button>
        ${
          canNest
            ? html`<button
                class="btn text"
                @click=${() => this.emit({ ...group, items: [...group.items, emptyGroup()] })}
              >
                ${icon(mdiPlus, 18)} Group
              </button>`
            : nothing
        }
      </div>
    `;
  }

  static override styles = [
    controls,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: 6px;
        /* Lay out condition rows by the editor's width, not the window's. */
        container-type: inline-size;
      }
      :host(.nested) {
        padding: 8px 0 4px 12px;
        border-left: 3px solid color-mix(in srgb, var(--pc-primary) 45%, transparent);
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .items {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .condition {
        display: grid;
        grid-template-columns:
          minmax(150px, 2fr) minmax(80px, 1fr) minmax(100px, 1fr) minmax(90px, 1fr)
          auto auto;
        grid-template-areas: "entity attr op value chip remove";
        gap: 6px;
        align-items: start;
      }
      .condition > * {
        min-width: 0;
      }
      .condition > select {
        width: 100%;
      }
      .entity {
        grid-area: entity;
      }
      .attr {
        grid-area: attr;
      }
      .op {
        grid-area: op;
      }
      .value {
        grid-area: value;
      }
      .condition > .chip {
        grid-area: chip;
        margin-top: 8px;
        justify-self: start;
      }
      .remove {
        grid-area: remove;
      }
      .empty {
        font-size: 0.9em;
        padding: 4px 0;
      }
      .add {
        display: flex;
        gap: 4px;
      }
      /* Narrow (e.g. the default-width editor): entity on its own line, then the rest. */
      @container (max-width: 640px) {
        .condition {
          grid-template-columns: 1fr 1fr auto;
          grid-template-areas:
            "entity entity remove"
            "attr op chip"
            "value value .";
          padding-bottom: 8px;
          border-bottom: 1px dashed var(--pc-divider);
        }
      }
    `,
  ];
}
