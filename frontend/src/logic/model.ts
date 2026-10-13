// Helpers for building, copying and inspecting schedule objects.

import type {
  Action,
  Block,
  BlockInput,
  Condition,
  Config,
  EntityAction,
  Group,
  HassEntity,
} from "../types";
import { MINUTES_PER_DAY, windowsOverlap } from "./time";

export const MAX_CONDITION_DEPTH = 6;

export function newId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const emptyGroup = (): Group => ({ type: "group", id: newId("g"), mode: "all", items: [] });

export const newCondition = (entityId = ""): Condition => ({
  type: "condition",
  id: newId("c"),
  entity_id: entityId,
  attribute: null,
  operator: "is",
  value: "",
});

export const newEntityAction = (entityId = ""): EntityAction => ({
  id: newId("a"),
  type: "entity",
  entity_id: entityId,
  settings: {},
});

export function countConditions(group: Group): number {
  return group.items.reduce(
    (n, item) => n + (item.type === "group" ? countConditions(item) : 1),
    0,
  );
}

/** Deep copy with fresh IDs for every nested group, condition and action. */
export function cloneGroup(group: Group): Group {
  return {
    ...group,
    id: newId("g"),
    items: group.items.map((item) =>
      item.type === "group" ? cloneGroup(item) : { ...item, id: newId("c") },
    ),
  };
}

export function cloneAction(action: Action): Action {
  return structuredClone({ ...action, id: newId("a") });
}

/** What Duplicate and the eyedropper copy: actions and conditions with fresh IDs. */
export function copyBehavior(block: Block): Pick<Block, "actions" | "conditions"> {
  return { actions: block.actions.map(cloneAction), conditions: cloneGroup(block.conditions) };
}

export function toInput(block: Block): BlockInput {
  const { id: _id, seq: _seq, ...rest } = block;
  return structuredClone(rest);
}

export function conditionEntities(group: Group, out = new Set<string>()): Set<string> {
  for (const item of group.items) {
    if (item.type === "group") conditionEntities(item, out);
    else if (item.entity_id) out.add(item.entity_id);
  }
  return out;
}

/** Problems that would make the server reject a condition tree. */
export function conditionProblems(group: Group): string[] {
  const problems: string[] = [];
  const walk = (g: Group, depth: number) => {
    if (depth > MAX_CONDITION_DEPTH) problems.push("Conditions are nested too deeply.");
    for (const item of g.items) {
      if (item.type === "group") walk(item, depth + 1);
      else if (!item.entity_id) problems.push("Every condition needs an entity.");
    }
  };
  walk(group, 1);
  return [...new Set(problems)];
}

export function actionProblems(actions: Action[]): string[] {
  const problems = new Set<string>();
  for (const action of actions) {
    if (action.type === "entity") {
      if (!action.entity_id) problems.add("Every entity action needs an entity.");
      else if (!Object.keys(action.settings).length)
        problems.add(`Choose at least one value to set for ${action.entity_id}.`);
    } else if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(action.service)) {
      problems.add("Every service call needs a service like light.turn_on.");
    }
  }
  return [...problems];
}

export const PALETTE = [
  "#039be5",
  "#f4511e",
  "#33b679",
  "#8e24aa",
  "#f6bf26",
  "#e67c73",
  "#3f51b5",
  "#0b8043",
  "#d50000",
  "#616161",
  "#ef6c00",
  "#7986cb",
];

export function nextColor(blocks: Block[]): string {
  return PALETTE[blocks.length % PALETTE.length]!;
}

export function friendlyName(entityId: string, states: Record<string, HassEntity>): string {
  return states[entityId]?.attributes.friendly_name ?? entityId;
}

export function blockLabel(block: Block, states: Record<string, HassEntity> = {}): string {
  if (block.name) return block.name;
  const first = block.actions[0];
  if (!first) return "New block";
  return first.type === "entity" ? friendlyName(first.entity_id, states) : first.service;
}

// --- Conflicts and feedback ------------------------------------------------

/** Setting keys a block writes: "entity_id|key" or "service:<service>". */
export function blockKeys(block: Block): Set<string> {
  const keys = new Set<string>();
  for (const action of block.actions) {
    if (action.type === "entity") {
      for (const key of Object.keys(action.settings)) keys.add(`${action.entity_id}|${key}`);
    } else {
      keys.add(`service:${action.service}|${JSON.stringify(action.target)}`);
    }
  }
  return keys;
}

export interface Conflict {
  otherId: string;
  keys: string[];
}

/**
 * Blocks in the same tab whose time windows overlap and that set the same
 * entity setting. The backend lets the most recently started block win.
 */
export function findConflicts(blocks: Block[]): Map<string, Conflict[]> {
  const result = new Map<string, Conflict[]>();
  const keys = new Map(blocks.map((b) => [b.id, blockKeys(b)]));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (a.tab_id !== b.tab_id) continue;
      if (
        !windowsOverlap(
          a.day * MINUTES_PER_DAY + a.start,
          a.duration,
          b.day * MINUTES_PER_DAY + b.start,
          b.duration,
        )
      )
        continue;
      const shared = [...keys.get(a.id)!].filter((k) => keys.get(b.id)!.has(k));
      if (!shared.length) continue;
      result.set(a.id, [...(result.get(a.id) ?? []), { otherId: b.id, keys: shared }]);
      result.set(b.id, [...(result.get(b.id) ?? []), { otherId: a.id, keys: shared }]);
    }
  }
  return result;
}

/** Entities any block action or tab default controls. */
export function controlledEntities(config: Config): Set<string> {
  const out = new Set<string>();
  for (const tab of config.tabs) for (const d of tab.defaults) out.add(d.entity_id);
  for (const block of config.blocks)
    for (const a of block.actions) if (a.type === "entity") out.add(a.entity_id);
  return out;
}

/** Condition entities that the schedule also controls (possible feedback loop). */
export function feedbackEntities(group: Group, config: Config): string[] {
  const controlled = controlledEntities(config);
  return [...conditionEntities(group)].filter(
    (e) =>
      controlled.has(e) ||
      e.startsWith("binary_sensor.punch_clock_") ||
      e.startsWith("switch.punch_clock_"),
  );
}

// --- Condition value suggestions ---------------------------------------------

const DOMAIN_STATES: Record<string, string[]> = {
  binary_sensor: ["on", "off"],
  input_boolean: ["on", "off"],
  switch: ["on", "off"],
  light: ["on", "off"],
  fan: ["on", "off"],
  automation: ["on", "off"],
  lock: ["locked", "unlocked", "jammed", "open"],
  cover: ["open", "closed", "opening", "closing"],
  media_player: ["off", "on", "idle", "playing", "paused", "standby"],
  person: ["home", "not_home"],
  device_tracker: ["home", "not_home"],
  sun: ["above_horizon", "below_horizon"],
  alarm_control_panel: [
    "disarmed",
    "armed_home",
    "armed_away",
    "armed_night",
    "armed_vacation",
    "triggered",
  ],
  vacuum: ["cleaning", "docked", "idle", "paused", "returning", "error"],
};

/** Values worth offering in a condition's value field. Free text is always allowed. */
export function valueSuggestions(
  entity: HassEntity | undefined,
  attribute: string | null,
  zones: string[] = [],
): string[] {
  if (!entity) return [];
  const domain = entity.entity_id.split(".", 1)[0] ?? "";
  const a = entity.attributes;
  const values = new Set<string>();
  if (attribute) {
    const current = a[attribute];
    if (current !== undefined && current !== null && typeof current !== "object")
      values.add(String(current));
    const lists: Record<string, string> = {
      hvac_mode: "hvac_modes",
      fan_mode: "fan_modes",
      preset_mode: "preset_modes",
      swing_mode: "swing_modes",
      source: "source_list",
      effect: "effect_list",
    };
    const list = lists[attribute];
    if (list && Array.isArray(a[list])) for (const v of a[list] as unknown[]) values.add(String(v));
    if (typeof current === "boolean") ["true", "false"].forEach((v) => values.add(v));
  } else {
    for (const v of DOMAIN_STATES[domain] ?? []) values.add(v);
    if (domain === "climate" && Array.isArray(a.hvac_modes))
      for (const v of a.hvac_modes) values.add(String(v));
    if (domain === "water_heater" && Array.isArray(a.operation_list))
      for (const v of a.operation_list) values.add(String(v));
    if (
      (domain === "select" || domain === "input_select" || a.device_class === "enum") &&
      Array.isArray(a.options)
    )
      for (const v of a.options) values.add(String(v));
    if (domain === "person" || domain === "device_tracker") for (const z of zones) values.add(z);
    values.add(entity.state);
    values.add("unavailable");
    values.add("unknown");
  }
  return [...values];
}

/** True if the condition compares numbers (shows a number-friendly hint). */
export function isNumeric(entity: HassEntity | undefined, attribute: string | null): boolean {
  if (!entity) return false;
  const value = attribute ? entity.attributes[attribute] : entity.state;
  return (
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
  );
}
