// Which settings an entity action can set, derived from the entity's domain,
// supported_features and attributes. Mirrors DOMAIN_KEYS in logic/actions.py.

import type { HassEntity, SettingValue } from "../types";

export type Control =
  | { kind: "enum"; options: string[] }
  | { kind: "number"; min: number; max: number; step: number; unit?: string }
  | { kind: "range"; min: number; max: number; step: number; unit?: string }
  | { kind: "bool" }
  | { kind: "rgb" };

export interface SettingDescriptor {
  key: string;
  label: string;
  control: Control;
  /** Value used when the setting is first switched on. */
  initial: SettingValue;
  hint?: string;
}

export const ACTION_DOMAINS = [
  "climate",
  "water_heater",
  "humidifier",
  "fan",
  "light",
  "switch",
  "input_boolean",
  "lock",
  "number",
  "input_number",
  "select",
  "input_select",
  "cover",
  "media_player",
] as const;

export const isActionDomain = (domain: string): boolean =>
  (ACTION_DOMAINS as readonly string[]).includes(domain);

export const domainOf = (entityId: string): string => entityId.split(".", 1)[0] ?? "";

const ON_OFF = ["on", "off"];

// Feature flags (Home Assistant IntFlag values).
const CLIMATE = {
  TARGET_TEMPERATURE: 1,
  RANGE: 2,
  HUMIDITY: 4,
  FAN: 8,
  PRESET: 16,
  SWING: 32,
  SWING_H: 512,
};
const WATER_HEATER = { TARGET_TEMPERATURE: 1, OPERATION_MODE: 2, AWAY_MODE: 4, ON_OFF: 8 };
const HUMIDIFIER = { MODES: 1 };
const FAN = { SET_SPEED: 1, OSCILLATE: 2, DIRECTION: 4, PRESET_MODE: 8, TURN_OFF: 16, TURN_ON: 32 };
const LIGHT = { EFFECT: 4 };
const COVER = { OPEN: 1, CLOSE: 2, SET_POSITION: 4, SET_TILT_POSITION: 128 };
const MEDIA = { VOLUME_SET: 4, VOLUME_MUTE: 8, TURN_ON: 128, TURN_OFF: 256, SELECT_SOURCE: 2048 };

const COLOR_MODES = new Set(["hs", "rgb", "rgbw", "rgbww", "xy"]);

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const has = (features: number, flag: number): boolean => (features & flag) === flag;

function enumSetting(
  key: string,
  label: string,
  options: string[],
  current: unknown,
): SettingDescriptor | null {
  if (!options.length) return null;
  const initial = typeof current === "string" && options.includes(current) ? current : options[0]!;
  return { key, label, control: { kind: "enum", options }, initial };
}

function temperatureLimits(attrs: Record<string, unknown>, unit: string) {
  const fahrenheit = unit.includes("F");
  return {
    min: num(attrs.min_temp, fahrenheit ? 45 : 7),
    max: num(attrs.max_temp, fahrenheit ? 95 : 35),
    step: num(attrs.target_temp_step, fahrenheit ? 1 : 0.5),
    unit,
  };
}

function climate(entity: HassEntity, unit: string): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const t = temperatureLimits(a, unit);
  const mid = Math.round((t.min + t.max) / 2);
  const out: (SettingDescriptor | null)[] = [
    enumSetting("hvac_mode", "Mode", strings(a.hvac_modes), entity.state),
    has(f, CLIMATE.PRESET)
      ? enumSetting("preset_mode", "Preset", strings(a.preset_modes), a.preset_mode)
      : null,
    has(f, CLIMATE.TARGET_TEMPERATURE)
      ? {
          key: "temperature",
          label: "Target temperature",
          control: { kind: "number", ...t },
          initial: num(a.temperature, mid),
          hint: "Used in every mode except heat/cool.",
        }
      : null,
    has(f, CLIMATE.RANGE)
      ? {
          key: "temp_range",
          label: "Temperature range",
          control: { kind: "range", ...t },
          initial: {
            low: num(a.target_temp_low, mid - 2),
            high: num(a.target_temp_high, mid + 2),
          },
          hint: "Used in heat/cool mode.",
        }
      : null,
    has(f, CLIMATE.FAN)
      ? enumSetting("fan_mode", "Fan mode", strings(a.fan_modes), a.fan_mode)
      : null,
    has(f, CLIMATE.SWING)
      ? enumSetting("swing_mode", "Swing mode", strings(a.swing_modes), a.swing_mode)
      : null,
    has(f, CLIMATE.SWING_H)
      ? enumSetting(
          "swing_horizontal_mode",
          "Horizontal swing",
          strings(a.swing_horizontal_modes),
          a.swing_horizontal_mode,
        )
      : null,
    has(f, CLIMATE.HUMIDITY)
      ? {
          key: "humidity",
          label: "Target humidity",
          control: {
            kind: "number",
            min: num(a.min_humidity, 30),
            max: num(a.max_humidity, 99),
            step: 1,
            unit: "%",
          },
          initial: num(a.humidity, 50),
        }
      : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function waterHeater(entity: HassEntity, unit: string): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const t = temperatureLimits(a, unit);
  const out: (SettingDescriptor | null)[] = [
    has(f, WATER_HEATER.ON_OFF)
      ? enumSetting("state", "Power", ON_OFF, entity.state === "off" ? "off" : "on")
      : null,
    has(f, WATER_HEATER.OPERATION_MODE)
      ? enumSetting("operation_mode", "Operation mode", strings(a.operation_list), a.operation_mode)
      : null,
    has(f, WATER_HEATER.TARGET_TEMPERATURE)
      ? {
          key: "temperature",
          label: "Target temperature",
          control: { kind: "number", ...t },
          initial: num(a.temperature, t.min),
        }
      : null,
    has(f, WATER_HEATER.AWAY_MODE)
      ? {
          key: "away_mode",
          label: "Away mode",
          control: { kind: "bool" },
          initial: a.away_mode === "on",
        }
      : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function humidifier(entity: HassEntity): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const out: (SettingDescriptor | null)[] = [
    enumSetting("state", "Power", ON_OFF, entity.state),
    has(f, HUMIDIFIER.MODES)
      ? enumSetting("mode", "Mode", strings(a.available_modes), a.mode)
      : null,
    {
      key: "humidity",
      label: "Target humidity",
      control: {
        kind: "number",
        min: num(a.min_humidity, 0),
        max: num(a.max_humidity, 100),
        step: 1,
        unit: "%",
      },
      initial: num(a.humidity, 50),
    },
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function fan(entity: HassEntity): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const out: (SettingDescriptor | null)[] = [
    enumSetting("state", "Power", ON_OFF, entity.state),
    has(f, FAN.SET_SPEED)
      ? {
          key: "percentage",
          label: "Speed",
          control: {
            kind: "number",
            min: 0,
            max: 100,
            step: Math.max(1, Math.round(num(a.percentage_step, 1))),
            unit: "%",
          },
          initial: num(a.percentage, 50),
          hint: "Ignored if a preset is also set.",
        }
      : null,
    has(f, FAN.PRESET_MODE)
      ? enumSetting("preset_mode", "Preset", strings(a.preset_modes), a.preset_mode)
      : null,
    has(f, FAN.OSCILLATE)
      ? {
          key: "oscillating",
          label: "Oscillate",
          control: { kind: "bool" },
          initial: a.oscillating === true,
        }
      : null,
    has(f, FAN.DIRECTION)
      ? enumSetting("direction", "Direction", ["forward", "reverse"], a.direction)
      : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function light(entity: HassEntity): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const modes = strings(a.supported_color_modes);
  const dimmable = modes.some((m) => m !== "onoff");
  const out: (SettingDescriptor | null)[] = [
    enumSetting("state", "Power", ON_OFF, entity.state),
    dimmable
      ? {
          key: "brightness_pct",
          label: "Brightness",
          control: { kind: "number", min: 1, max: 100, step: 1, unit: "%" },
          initial: Math.max(1, Math.round((num(a.brightness, 255) * 100) / 255)),
          hint: "Setting brightness turns the light on.",
        }
      : null,
    modes.includes("color_temp")
      ? {
          key: "color_temp_kelvin",
          label: "Color temperature",
          control: {
            kind: "number",
            min: num(a.min_color_temp_kelvin, 2000),
            max: num(a.max_color_temp_kelvin, 6500),
            step: 50,
            unit: "K",
          },
          initial: num(a.color_temp_kelvin, 3000),
          hint: "Used instead of a color if both are set.",
        }
      : null,
    modes.some((m) => COLOR_MODES.has(m))
      ? {
          key: "rgb_color",
          label: "Color",
          control: { kind: "rgb" },
          initial: Array.isArray(a.rgb_color) ? (a.rgb_color as number[]) : [255, 255, 255],
        }
      : null,
    has(f, LIGHT.EFFECT) ? enumSetting("effect", "Effect", strings(a.effect_list), a.effect) : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function cover(entity: HassEntity): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const out: (SettingDescriptor | null)[] = [
    has(f, COVER.OPEN) || has(f, COVER.CLOSE)
      ? enumSetting("state", "Open or closed", ["open", "closed"], entity.state)
      : null,
    has(f, COVER.SET_POSITION)
      ? {
          key: "position",
          label: "Position",
          control: { kind: "number", min: 0, max: 100, step: 1, unit: "%" },
          initial: num(a.current_position, 100),
          hint: "Used instead of open/closed if both are set.",
        }
      : null,
    has(f, COVER.SET_TILT_POSITION)
      ? {
          key: "tilt_position",
          label: "Tilt position",
          control: { kind: "number", min: 0, max: 100, step: 1, unit: "%" },
          initial: num(a.current_tilt_position, 50),
        }
      : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

function mediaPlayer(entity: HassEntity): SettingDescriptor[] {
  const a = entity.attributes;
  const f = num(a.supported_features, 0);
  const out: (SettingDescriptor | null)[] = [
    has(f, MEDIA.TURN_ON) || has(f, MEDIA.TURN_OFF)
      ? enumSetting("state", "Power", ON_OFF, entity.state === "off" ? "off" : "on")
      : null,
    has(f, MEDIA.SELECT_SOURCE)
      ? enumSetting("source", "Source", strings(a.source_list), a.source)
      : null,
    has(f, MEDIA.VOLUME_SET)
      ? {
          key: "volume_level",
          label: "Volume",
          control: { kind: "number", min: 0, max: 1, step: 0.01 },
          initial: num(a.volume_level, 0.3),
        }
      : null,
    has(f, MEDIA.VOLUME_MUTE)
      ? {
          key: "is_volume_muted",
          label: "Muted",
          control: { kind: "bool" },
          initial: a.is_volume_muted === true,
        }
      : null,
  ];
  return out.filter((d): d is SettingDescriptor => d !== null);
}

/** The settings an entity action can set on this entity. */
export function describe(entity: HassEntity, temperatureUnit: string): SettingDescriptor[] {
  const a = entity.attributes;
  switch (domainOf(entity.entity_id)) {
    case "climate":
      return climate(entity, temperatureUnit);
    case "water_heater":
      return waterHeater(entity, temperatureUnit);
    case "humidifier":
      return humidifier(entity);
    case "fan":
      return fan(entity);
    case "light":
      return light(entity);
    case "switch":
    case "input_boolean":
      return [
        { key: "state", label: "State", control: { kind: "enum", options: ON_OFF }, initial: "on" },
      ];
    case "lock":
      return [
        {
          key: "state",
          label: "State",
          control: { kind: "enum", options: ["locked", "unlocked"] },
          initial: "locked",
        },
      ];
    case "number":
    case "input_number": {
      const unit = typeof a.unit_of_measurement === "string" ? a.unit_of_measurement : undefined;
      const min = num(a.min, 0);
      return [
        {
          key: "value",
          label: "Value",
          control: { kind: "number", min, max: num(a.max, 100), step: num(a.step, 1), unit },
          initial: num(entity.state, min),
        },
      ];
    }
    case "select":
    case "input_select": {
      const d = enumSetting("option", "Option", strings(a.options), entity.state);
      return d ? [d] : [];
    }
    case "cover":
      return cover(entity);
    case "media_player":
      return mediaPlayer(entity);
    default:
      return [];
  }
}

/** Human-readable summary of an action's settings, e.g. "Mode heat, 68 °F". */
export function summarizeSettings(settings: Record<string, SettingValue>): string {
  return Object.entries(settings)
    .map(([key, value]) => {
      if (key === "temp_range" && typeof value === "object" && !Array.isArray(value)) {
        return `${value.low}–${value.high}°`;
      }
      if (Array.isArray(value)) return `rgb(${value.join(", ")})`;
      if (key === "brightness_pct" || key === "percentage" || key === "position")
        return `${value}%`;
      if (key === "temperature") return `${value}°`;
      if (typeof value === "boolean") return `${key.replaceAll("_", " ")} ${value ? "on" : "off"}`;
      return String(value);
    })
    .join(", ");
}
