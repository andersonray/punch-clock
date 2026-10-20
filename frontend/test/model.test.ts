import { describe, expect, it } from "vitest";
import {
  actionProblems,
  behaviorKey,
  blockEntities,
  blockGroup,
  cloneGroup,
  conditionProblems,
  copyBehavior,
  countConditions,
  emptyGroup,
  entityCounts,
  feedbackEntities,
  findConflicts,
  newCondition,
  PALETTE,
  sortWhens,
  splitColor,
  splitName,
  tabEntities,
  valueSuggestions,
  whenOf,
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

  it("lists the entities a tab's blocks set", () => {
    const light = { id: "a-l", type: "entity" as const, entity_id: "light.porch", settings: {} };
    const service = {
      id: "a-s",
      type: "service" as const,
      service: "script.turn_on",
      target: { entity_id: ["script.x"] },
      data: {},
    };
    const config = {
      blocks: [
        block("a"),
        block("b", { actions: [light, service, ...block("b").actions] }),
        block("c", { tab_id: "t2", actions: [{ ...light, entity_id: "light.other" }] }),
      ],
    } as Config;
    expect(tabEntities(config, "t1")).toEqual(["climate.house", "light.porch"]);
    expect(tabEntities(config, "t2")).toEqual(["light.other"]);
  });

  it("counts the blocks acting on each entity, including service call targets", () => {
    const service = {
      id: "a-s",
      type: "service" as const,
      service: "light.turn_on",
      target: { entity_id: ["light.porch", "climate.house"] },
      data: {},
    };
    const a = block("a"); // sets climate.house
    const b = block("b", { actions: [service] });
    const c = block("c", { actions: [] });
    expect([...blockEntities(b)]).toEqual(["light.porch", "climate.house"]);
    expect([...entityCounts([a, b, c])]).toEqual([
      ["climate.house", 2],
      ["light.porch", 1],
    ]);
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
      settings: {
        enabled: true,
        week_start: 6,
        debounce_seconds: 2,
        temperature_unit: "°C",
        time_format: "auto",
      },
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

describe("groups", () => {
  const blocks = [
    block("mon", { name: "Morning", day: 0 }),
    block("wed", { name: " Morning ", day: 2, color: "#039BE5" }),
    block("purple", { name: "Morning", day: 1, color: "#8e24aa" }),
    block("other-tab", { name: "Morning", tab_id: "t2" }),
    block("unnamed-1", { name: "" }),
    block("unnamed-2", { name: "" }),
  ];

  it("groups blocks of a tab with the same name and color", () => {
    expect(blockGroup(blocks, blocks[0]!).map((b) => b.id)).toEqual(["mon", "wed"]);
    expect(blockGroup(blocks, blocks[2]!).map((b) => b.id)).toEqual(["purple"]);
    expect(blockGroup(blocks, blocks[3]!).map((b) => b.id)).toEqual(["other-tab"]);
    expect(blockGroup(blocks, blocks[4]!).map((b) => b.id)).toEqual(["unnamed-1"]);
  });

  it("sorts times in calendar order for the first day of the week", () => {
    const whens = [
      whenOf(block("sun", { day: 6, start: 60 })),
      whenOf(block("mon-late", { day: 0, start: 600 })),
      whenOf(block("mon-early", { day: 0, start: 60 })),
    ];
    expect(sortWhens(whens, 0).map((w) => w.id)).toEqual(["mon-early", "mon-late", "sun"]);
    expect(sortWhens(whens, 6).map((w) => w.id)).toEqual(["sun", "mon-early", "mon-late"]);
  });

  it("numbers a split-off block with the lowest unused number in its tab", () => {
    expect(splitName(blocks, "t1", "Morning")).toBe("Morning 1");
    const more = [
      ...blocks,
      block("m1", { name: "Morning 1" }),
      block("m3", { name: "Morning 3" }),
    ];
    expect(splitName(more, "t1", "Morning")).toBe("Morning 2");
    expect(splitName(more, "t2", "Morning")).toBe("Morning 1");
  });

  it("gives a split-off block a palette color that the tab doesn't use yet", () => {
    const used = PALETTE.slice(0, -1).map((color, i) => block(`b${i}`, { color }));
    expect(splitColor(used, "t1", "#039be5", () => 0.99)).toBe(PALETTE.at(-1));
    // With every color in use, any color but the group's.
    const all = [...used, block("last", { color: PALETTE.at(-1)! })];
    const picked = PALETTE.map((_, i) =>
      splitColor(all, "t1", "#039be5", () => i / PALETTE.length),
    );
    expect(picked).not.toContain("#039be5");
    expect(new Set(picked).size).toBe(PALETTE.length - 1);
    // Other tabs don't count.
    expect(splitColor(used, "t2", "#039be5", () => 0)).toBe(PALETTE[0]);
  });

  it("compares what blocks do without their IDs", () => {
    const a = block("a", { conditions: group(newCondition("binary_sensor.door")) });
    const copy = { ...a, ...copyBehavior(a) };
    expect(copy.actions[0]!.id).not.toBe(a.actions[0]!.id);
    expect(behaviorKey(copy)).toBe(behaviorKey(a));
    const warmer = block("b", {
      actions: [{ ...a.actions[0]!, settings: { temperature: 21 } } as Block["actions"][0]],
    });
    expect(behaviorKey(warmer)).not.toBe(behaviorKey(a));
  });
});
