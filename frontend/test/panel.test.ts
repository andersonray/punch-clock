// Smoke test: mount the whole panel against a fake `hass` and drive the main flows.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Block, Config, HomeAssistant, Status } from "../src/types";
import type { PunchClockPanel } from "../src/panel/punch-clock-panel";
import type { PcBlockEditor } from "../src/components/pc-block-editor";

declare const __PC_VERSION__: string;

const emptyGroup = (id: string) => ({
  type: "group" as const,
  id,
  mode: "all" as const,
  items: [],
});

const block = (id: string, overrides: Partial<Block> = {}): Block => ({
  id,
  tab_id: "t_1",
  seq: 1,
  day: 0,
  start: 360,
  duration: 120,
  name: id,
  color: "#039be5",
  actions: [],
  conditions: emptyGroup(`g_${id}`),
  ...overrides,
});

function makeConfig(): Config {
  return {
    revision: 1,
    seq: 2,
    settings: { enabled: true, week_start: 6, debounce_seconds: 2, temperature_unit: "°C" },
    tabs: [
      { id: "t_1", name: "Week", enabled: true, conditions: emptyGroup("g_t1"), defaults: [] },
      { id: "t_2", name: "Vacation", enabled: false, conditions: emptyGroup("g_t2"), defaults: [] },
    ],
    blocks: [
      block("b_morning", {
        name: "Morning",
        actions: [
          { id: "a_1", type: "entity", entity_id: "climate.house", settings: { temperature: 21 } },
        ],
        conditions: {
          type: "group",
          id: "g_m",
          mode: "all",
          items: [
            {
              type: "condition",
              id: "c_1",
              entity_id: "input_boolean.guests",
              attribute: null,
              operator: "is",
              value: "on",
            },
          ],
        },
      }),
      block("b_night", { name: "Night", day: 4, start: 1320, duration: 240 }), // Fri 22:00 -> Sat 02:00
      block("b_target", { name: "Target", day: 2, start: 600, duration: 60 }),
    ],
  };
}

const status: Status = {
  enabled: true,
  started: true,
  evaluated_at: null,
  next_boundary: null,
  tabs: { t_1: { enabled: true, conditions_met: true, active: true } },
  blocks: {},
  desired: [],
  pending: [],
  suppressed: [],
  errors: [],
};

interface Fake {
  hass: HomeAssistant;
  calls: Record<string, unknown>[];
}

function fakeHass(config: Config): Fake {
  const calls: Record<string, unknown>[] = [];
  const hass = {
    states: {
      "climate.house": {
        entity_id: "climate.house",
        state: "heat",
        attributes: {
          friendly_name: "House",
          hvac_modes: ["off", "heat"],
          min_temp: 7,
          max_temp: 35,
          target_temp_step: 0.5,
          temperature: 20,
          supported_features: 1,
        },
      },
      "input_boolean.guests": {
        entity_id: "input_boolean.guests",
        state: "off",
        attributes: { friendly_name: "Guests" },
      },
    },
    services: { climate: { set_temperature: {} } },
    language: "en",
    locale: { language: "en", time_format: "24" },
    config: { time_zone: "UTC", unit_system: { temperature: "°C" } },
    async callWS<T>(msg: Record<string, unknown>): Promise<T> {
      calls.push(msg);
      switch (msg.type) {
        case "punch_clock/info":
          return { version: __PC_VERSION__, time_zone: "UTC", temperature_unit: "°C" } as T;
        case "punch_clock/conditions/evaluate":
          return { id: "g", type: "group", result: false, items: [] } as T;
        case "punch_clock/blocks/create": {
          const inputs = msg.blocks as Omit<Block, "id" | "seq">[];
          return { blocks: inputs.map((b, i) => ({ ...b, id: `b_new${i}`, seq: 10 + i })) } as T;
        }
        default:
          return {} as T;
      }
    },
    connection: {
      async subscribeMessage<T>(callback: (message: T) => void) {
        callback({ kind: "config", config } as T);
        callback({ kind: "status", status } as T);
        return async () => {};
      },
    },
  };
  return { hass: hass as unknown as HomeAssistant, calls };
}

const settle = async (el: PunchClockPanel) => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
};

const shadow = (el: Element | null | undefined) => (el as HTMLElement).shadowRoot!;

let el: PunchClockPanel;
let fake: Fake;

async function mount(): Promise<void> {
  fake = fakeHass(makeConfig());
  el = document.createElement("punch-clock-panel");
  el.hass = fake.hass;
  document.body.append(el);
  await settle(el);
}

const weekView = () => shadow(el).querySelector("pc-week-view")!;
const blocks = () => [...shadow(weekView()).querySelectorAll<HTMLButtonElement>(".block")];
const editor = () => shadow(el).querySelector("pc-block-editor") as PcBlockEditor | null;

beforeAll(async () => {
  await import("../src/main");
});

afterEach(() => el?.remove());

describe("punch-clock-panel", () => {
  it("renders tabs and the active tab's blocks, splitting midnight-crossing blocks", async () => {
    await mount();
    const tabs = shadow(shadow(el).querySelector("pc-tab-bar")).querySelectorAll(".tab-button");
    expect([...tabs].map((t) => t.textContent?.trim())).toEqual(["Week", "Vacation"]);
    // Morning + Target + Night (two segments).
    expect(blocks()).toHaveLength(4);
    const heads = [...shadow(weekView()).querySelectorAll(".day-head")].map((h) =>
      h.textContent?.trim(),
    );
    expect(heads[0]).toBe("Sun");
  });

  it("opens the editor when a block is clicked", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const ed = editor()!;
    expect(ed).not.toBeNull();
    expect(ed._draft.id).toBe("b_morning");
    expect(shadow(ed).querySelectorAll("pc-action-editor")).toHaveLength(1);
    expect(shadow(ed).querySelector("pc-condition-editor")).not.toBeNull();
    expect(ed.dirty).toBe(false);
  });

  it("creates a block by dragging on a day column", async () => {
    await mount();
    const columns = shadow(weekView()).querySelectorAll<HTMLElement>(".col");
    const monday = columns[1]!; // the week starts on Sunday
    const hour = 48;
    const fire = (type: string, y: number) =>
      monday.dispatchEvent(
        new PointerEvent(type, {
          clientY: y,
          button: 0,
          pointerType: "mouse",
          pointerId: 1,
          bubbles: true,
        }),
      );
    fire("pointerdown", 8 * hour);
    fire("pointermove", 9 * hour);
    fire("pointermove", 10 * hour);
    fire("pointerup", 10 * hour);
    await settle(el);
    const create = fake.calls.find((c) => c.type === "punch_clock/blocks/create");
    expect(create).toBeDefined();
    expect((create!.blocks as Block[])[0]).toMatchObject({
      tab_id: "t_1",
      day: 0,
      start: 480,
      duration: 120,
    });
  });

  it("copies actions and conditions with the eyedropper after confirming", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    expect(ed._draft.actions).toHaveLength(0);

    // Start picking, then click the source block. The target is empty, so no confirmation.
    shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
    await settle(el);
    expect(weekView().picking).toBe(true);
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    expect(ed._draft.actions).toHaveLength(1);
    expect(ed._draft.actions[0]!.id).not.toBe("a_1");
    expect(ed._draft.conditions.items).toHaveLength(1);
    expect(ed.dirty).toBe(true);

    // Picking again now replaces existing actions, which needs confirmation.
    shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
    await settle(el);
    blocks()
      .find((b) => b.textContent?.includes("Night"))!
      .click();
    await settle(el);
    const confirm = shadow(el).querySelector("pc-confirm-dialog")!;
    const replace = [...shadow(confirm).querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Replace"),
    )!;
    replace.click();
    await settle(el);
    expect(ed._draft.actions).toHaveLength(0);
  });

  it("duplicates a block to several days", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    shadow(editor()).querySelector<HTMLButtonElement>('[aria-label="Duplicate"]')!.click();
    await settle(el);
    const dialog = shadow(el).querySelector("pc-duplicate-dialog")!;
    const days = [...shadow(dialog).querySelectorAll<HTMLInputElement>(".day input")];
    days[2]!.click(); // Tuesday
    days[4]!.click(); // Thursday
    await settle(el);
    const create = [...shadow(dialog).querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Create 2 blocks"),
    )!;
    create.click();
    await settle(el);
    const call = fake.calls.find((c) => c.type === "punch_clock/blocks/create")!;
    const created = call.blocks as Block[];
    expect(created.map((b) => b.day)).toEqual([1, 3]);
    expect(created[0]).toMatchObject({ start: 360, duration: 120, name: "Morning" });
    expect(created[0]!.actions[0]!.id).not.toBe("a_1");
  });
});
