import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describe as describeEntity,
  isActionDomain,
  summarizeSettings,
} from "../src/logic/capabilities";
import type { HassEntity } from "../src/types";

// Shared with the Python tests (tests/pure/test_actions.py).
const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "../tests/fixtures/entities.json"), "utf8"),
) as Record<string, { state: string; attributes: Record<string, unknown> }>;

const entity = (id: string): HassEntity => ({ entity_id: id, ...fixtures[id]! });
const units = (unit: string) => ({ schedule: unit, ha: unit });
const keys = (id: string, unit = "°F") => describeEntity(entity(id), units(unit)).map((d) => d.key);

describe("describe", () => {
  it("offers climate settings from features and attributes", () => {
    expect(keys("climate.ecobee")).toEqual(["hvac_mode", "preset_mode", "temp_range", "fan_mode"]);
    expect(keys("climate.hvac", "°C")).toEqual([
      "hvac_mode",
      "temperature",
      "fan_mode",
      "swing_mode",
    ]);
    const temperature = describeEntity(entity("climate.hvac"), units("°C")).find(
      (d) => d.key === "temperature",
    )!;
    expect(temperature.control).toEqual({ kind: "number", min: 7, max: 35, step: 0.5, unit: "°C" });
    expect(temperature.initial).toBe(21);
  });

  it("shows temperatures in the schedule's unit", () => {
    // climate.hvac reports °C (min 7, max 35, current 21); the schedule uses °F.
    const temperature = describeEntity(entity("climate.hvac"), { schedule: "°F", ha: "°C" }).find(
      (d) => d.key === "temperature",
    )!;
    expect(temperature.control).toEqual({ kind: "number", min: 45, max: 95, step: 1, unit: "°F" });
    expect(temperature.initial).toBe(70);
    const back = describeEntity(entity("climate.ecobee"), { schedule: "°C", ha: "°F" }).find(
      (d) => d.key === "temp_range",
    )!;
    expect(back.control).toMatchObject({ min: 7.5, max: 35, step: 0.5, unit: "°C" });
    expect(back.initial).toEqual({ low: 20, high: 24 });
  });

  it("offers light settings by color mode", () => {
    expect(keys("light.living_room")).toEqual([
      "state",
      "brightness_pct",
      "color_temp_kelvin",
      "rgb_color",
      "effect",
    ]);
    expect(keys("light.porch")).toEqual(["state", "brightness_pct"]);
    const brightness = describeEntity(entity("light.living_room"), units("°C")).find(
      (d) => d.key === "brightness_pct",
    )!;
    expect(brightness.initial).toBe(71);
  });

  it("covers the other domains", () => {
    expect(keys("fan.ceiling")).toEqual([
      "state",
      "percentage",
      "preset_mode",
      "oscillating",
      "direction",
    ]);
    expect(keys("cover.living_room_window")).toEqual(["state", "position", "tilt_position"]);
    expect(keys("cover.garage_door")).toEqual(["state"]);
    expect(keys("media_player.living_room")).toEqual([
      "state",
      "source",
      "volume_level",
      "is_volume_muted",
    ]);
    expect(keys("water_heater.demo")).toEqual([
      "state",
      "operation_mode",
      "temperature",
      "away_mode",
    ]);
    expect(keys("humidifier.dehumidifier")).toEqual(["state", "mode", "humidity"]);
    expect(keys("input_number.setpoint")).toEqual(["value"]);
    expect(keys("select.speed")).toEqual(["option"]);
    expect(keys("lock.front_door")).toEqual(["state"]);
    expect(keys("switch.decorative_lights")).toEqual(["state"]);
  });

  it("only lists supported domains", () => {
    expect(isActionDomain("climate")).toBe(true);
    expect(isActionDomain("sensor")).toBe(false);
    expect(
      describeEntity({ entity_id: "sensor.x", state: "1", attributes: {} }, units("°C")),
    ).toEqual([]);
  });
});

describe("summarizeSettings", () => {
  it("reads naturally", () => {
    expect(summarizeSettings({ hvac_mode: "heat", temperature: 68 })).toBe("heat, 68°");
    expect(summarizeSettings({ temp_range: { low: 66, high: 74 } })).toBe("66–74°");
    expect(summarizeSettings({ brightness_pct: 40, oscillating: true })).toBe(
      "40%, oscillating on",
    );
  });
});
