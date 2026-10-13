// TypeScript mirrors of the backend model (custom_components/punch_clock/logic/model.py)
// and the subset of Home Assistant's frontend `hass` object that the panel uses.

export type Operator = "is" | "is_not" | "gt" | "lt";
export type GroupMode = "all" | "any";

export interface Condition {
  type: "condition";
  id: string;
  entity_id: string;
  attribute: string | null;
  operator: Operator;
  value: string;
}

export interface Group {
  type: "group";
  id: string;
  mode: GroupMode;
  items: (Condition | Group)[];
}

export type SettingValue = string | number | boolean | number[] | { low: number; high: number };

export interface EntityAction {
  id: string;
  type: "entity";
  entity_id: string;
  settings: Record<string, SettingValue>;
}

export interface ServiceAction {
  id: string;
  type: "service";
  service: string;
  target: Record<string, string[]>;
  data: Record<string, unknown>;
}

export type Action = EntityAction | ServiceAction;

export interface Tab {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Group;
  defaults: EntityAction[];
}

export interface Block {
  id: string;
  tab_id: string;
  seq: number;
  /** 0 = Monday ... 6 = Sunday */
  day: number;
  /** Minute of the day, 0-1439. */
  start: number;
  /** Minutes, 1-1440. May run past midnight into the next day. */
  duration: number;
  name: string;
  color: string;
  actions: Action[];
  conditions: Group;
}

export interface Settings {
  enabled: boolean;
  /** 0 = Monday ... 6 = Sunday */
  week_start: number;
  debounce_seconds: number;
  temperature_unit: string | null;
}

export interface Config {
  revision: number;
  seq: number;
  settings: Settings;
  tabs: Tab[];
  blocks: Block[];
}

export interface Status {
  enabled: boolean;
  started: boolean;
  evaluated_at: string | null;
  next_boundary: string | null;
  tabs: Record<string, { enabled: boolean; conditions_met: boolean; active: boolean }>;
  blocks: Record<string, { in_window: boolean; conditions_met: boolean; active: boolean }>;
  desired: {
    entity_id: string;
    key: string;
    value: unknown;
    source: { kind: "block" | "default"; tab_id: string; block_id: string | null };
  }[];
  pending: string[];
  suppressed: { entity_id: string; until: string }[];
  errors: { time: string; entity_id: string; message: string }[];
}

export interface Info {
  version: string;
  time_zone: string;
  temperature_unit: string;
}

export interface ExplainNode {
  id: string;
  type: "group" | "condition";
  result: boolean;
  known?: boolean;
  actual?: string | number | boolean | null;
  items?: ExplainNode[];
}

/** Payload for creating a block (the server assigns id and seq). */
export type BlockInput = Omit<Block, "id" | "seq">;

// --- Home Assistant -------------------------------------------------------

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown> & { friendly_name?: string; supported_features?: number };
}

export interface HassConnection {
  subscribeMessage<T>(
    callback: (message: T) => void,
    message: Record<string, unknown>,
    options?: { resubscribe?: boolean },
  ): Promise<() => Promise<void>>;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  services: Record<string, Record<string, unknown>>;
  connection: HassConnection;
  language: string;
  locale: { language: string; time_format?: string; first_weekday?: string };
  config: { time_zone: string; unit_system: { temperature: string } };
  user?: { is_admin: boolean };
  callWS<T>(message: Record<string, unknown>): Promise<T>;
  formatEntityState?(stateObj: HassEntity, state?: string): string;
  formatEntityAttributeName?(stateObj: HassEntity, attribute: string): string;
  formatEntityAttributeValue?(stateObj: HassEntity, attribute: string, value?: unknown): string;
}

export interface PanelInfo {
  config?: { version?: string };
}
