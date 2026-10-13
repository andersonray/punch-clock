import { describe, expect, it } from "vitest";
import {
  actionProblems,
  cloneGroup,
  conditionProblems,
  copyBehavior,
  countConditions,
  emptyGroup,
  feedbackEntities,
  findConflicts,
  newCondition,
  valueSuggestions,
} from "../src/logic/model";
import type { Block, Config, Group } from "../src/types";

const group = (...items: Group["items"]): Group => ({ ...emptyGroup(), items });

const block = (id: string, overrides: Partial<Block> = {}): Block => ({
  id,
  tab_id: "t1",
  seq: 1,
  day: 0,
  start: 360,
  duration: 120,
  name: id,
  color: "#039be5",
  actions: [
    { id: `a-${id}`, type: "entity", entity_id: "climate.house", settings: { temperature: 20 } },
  ],
  conditions: emptyGroup(),
  ...overrides,
});

describe("conditions", () => {
  it("counts nested conditions", () => {
    const tree = group(newCondition("a.b"), group(newCondition("c.d"), group(newCondition("e.f"))));
    expect(countConditions(tree)).toBe(3);
  });

  it("clones with fresh IDs", () => {
    const tree = group(newCondition("a.b"), group(newCondition("c.d")));
    const copy = cloneGroup(tree);
    expect(copy.id).not.toBe(tree.id);
    expect(copy.items[0]!.id).not.toBe(tree.items[0]!.id);
    expect((copy.items[1] as Group).items[0]).toMatchObject({ entity_id: "c.d" });
  });

  it("reports incomplete conditions", () => {
    expect(conditionProblems(group(newCondition("")))).toEqual([
      "Every condition needs an entity.",
    ]);
    let deep: Group = group(newCondition("a.b"));
    for (let i = 0; i < 6; i++) deep = group(deep);
    expect(conditionProblems(deep)).toContain("Conditions are nested too deeply.");
  });

  it("suggests values from the entity", () => {
    const climate = {
      entity_id: "climate.x",
      state: "heat",
      attributes: { hvac_modes: ["off", "heat"], fan_mode: "auto", fan_modes: ["auto", "on"] },
    };
    expect(valueSuggestions(climate, null)).toEqual(["off", "heat", "unavailable", "unknown"]);
    expect(valueSuggestions(climate, "fan_mode")).toEqual(["auto", "on"]);
    const person = { entity_id: "person.ray", state: "home", attributes: {} };
    expect(valueSuggestions(person, null, ["Work"])).toContain("Work");
  });
});

describe("actions", () => {
  it("reports incomplete actions", () => {
    expect(actionProblems([{ id: "a", type: "entity", entity_id: "", settings: {} }])).toEqual([
      "Every entity action needs an entity.",
    ]);
    expect(
      actionProblems([{ id: "a", type: "entity", entity_id: "light.x", settings: {} }]),
    ).toHaveLength(1);
    expect(
      actionProblems([{ id: "a", type: "service", service: "nope", target: {}, data: {} }]),
    ).toHaveLength(1);
  });

  it("copies actions and conditions with fresh IDs", () => {
    const source = block("src", { conditions: group(newCondition("input_boolean.guests")) });
    const copy = copyBehavior(source);
    expect(copy.actions[0]!.id).not.toBe(source.actions[0]!.id);
    expect(copy.actions[0]).toMatchObject({
      entity_id: "climate.house",
      settings: { temperature: 20 },
    });
    expect(copy.conditions.items[0]!.id).not.toBe(source.conditions.items[0]!.id);
    const copied = copy.actions[0];
    if (copied?.type === "entity") copied.settings.temperature = 99;
    const original = source.actions[0];
    expect(original?.type === "entity" && original.settings.temperature).toBe(20);
  });
});

describe("conflicts", () => {
  it("finds overlapping blocks that set the same thing", () => {
    const a = block("a");
    const b = block("b", { start: 420 });
    const c = block("c", { start: 420, tab_id: "t2" }); // other tab
    const d = block("d", { start: 480, duration: 60 }); // touches a's end, no overlap
    const conflicts = findConflicts([a, b, c, d]);
    expect(conflicts.get("a")).toEqual([{ otherId: "b", keys: ["climate.house|temperature"] }]);
    expect(conflicts.get("b")?.map((x) => x.otherId)).toEqual(["a", "d"]);
    expect(conflicts.has("c")).toBe(false);
  });

  it("warns about conditions on controlled entities", () => {
    const config: Config = {
      revision: 1,
      seq: 1,
      settings: { enabled: true, week_start: 6, debounce_seconds: 2, temperature_unit: "°C" },
      tabs: [{ id: "t1", name: "Week", enabled: true, conditions: emptyGroup(), defaults: [] }],
      blocks: [block("a")],
    };
    const tree = group(
      newCondition("climate.house"),
      newCondition("person.ray"),
      newCondition("binary_sensor.punch_clock_week_active"),
    );
    expect(feedbackEntities(tree, config)).toEqual([
      "climate.house",
      "binary_sensor.punch_clock_week_active",
    ]);
  });
});
