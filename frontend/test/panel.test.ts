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
    settings: {
      enabled: true,
      week_start: 6,
      debounce_seconds: 2,
      temperature_unit: "°C",
      time_format: "auto",
    },
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
  localStorage.clear();
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

async function mount(adjust: (config: Config) => void = () => {}): Promise<void> {
  const config = makeConfig();
  adjust(config);
  fake = fakeHass(config);
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

    // Start picking, then click the source block. The target has a name, so it asks first.
    shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
    await settle(el);
    expect(weekView().picking).toBe(true);
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const ask = shadow(el).querySelector("pc-confirm-dialog")!;
    [...shadow(ask).querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Replace"))!
      .click();
    await settle(el);
    expect(ed._draft.actions).toHaveLength(1);
    expect(ed._draft.actions[0]!.id).not.toBe("a_1");
    expect(ed._draft.name).toBe("Morning");
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
    expect(ed._draft.name).toBe("Night");
  });

  it("copies the name and color with the eyedropper and shows them right away", async () => {
    await mount((config) => {
      config.blocks.find((b) => b.id === "b_morning")!.color = "#8e24aa";
    });
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
    await settle(el);
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    // "Target" has a name, so it asks first.
    const confirm = shadow(el).querySelector("pc-confirm-dialog")!;
    [...shadow(confirm).querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Replace"))!
      .click();
    await settle(el);
    expect(ed._draft).toMatchObject({ name: "Morning", color: "#8e24aa" });
    // The calendar shows the copied name and color before saving.
    const morningBlocks = blocks().filter((b) => b.textContent?.includes("Morning"));
    expect(morningBlocks).toHaveLength(2);
    expect(morningBlocks.every((b) => b.getAttribute("style")?.includes("#8e24aa"))).toBe(true);
    expect(fake.calls.some((c) => c.type === "punch_clock/blocks/update")).toBe(false);
  });

  it("previews a new color immediately and a new name after leaving the field", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    const target = () => blocks().find((b) => b.getAttribute("style")?.includes("top:480px"))!;
    shadow(ed).querySelector<HTMLButtonElement>('.swatch[aria-label="#33b679"]')!.click();
    await settle(el);
    expect(target().getAttribute("style")).toContain("#33b679");

    const name = shadow(ed).querySelector<HTMLInputElement>(".name")!;
    name.value = "Lunch";
    name.dispatchEvent(new Event("input"));
    await settle(el);
    expect(target().textContent).toContain("Target"); // not until the field loses focus
    name.dispatchEvent(new Event("change"));
    await settle(el);
    expect(target().textContent).toContain("Lunch");

    // Discarding puts the saved name and color back.
    [...shadow(ed).querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Discard")!
      .click();
    await settle(el);
    expect(target().textContent).toContain("Target");
    expect(target().getAttribute("style")).toContain("#039be5");
  });

  it("resizes the editor by dragging the divider or with the keyboard", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const main = shadow(el).querySelector<HTMLElement>(".main")!;
    Object.defineProperty(main, "clientWidth", { value: 1400 });
    main.getBoundingClientRect = () =>
      ({ left: 0, right: 1400, top: 0, bottom: 800, width: 1400, height: 800 }) as DOMRect;
    const splitter = shadow(el).querySelector<HTMLElement>(".splitter")!;
    const pane = () => shadow(el).querySelector<HTMLElement>(".editor-pane")!;
    expect(pane().getAttribute("style")).toContain("--editor-width:460px");

    const pointer = (type: string, x: number) =>
      splitter.dispatchEvent(
        new PointerEvent(type, { clientX: x, button: 0, pointerId: 1, bubbles: true }),
      );
    pointer("pointerdown", 940);
    pointer("pointermove", 700);
    pointer("pointerup", 700);
    await settle(el);
    expect(pane().getAttribute("style")).toContain("--editor-width:700px");
    expect(JSON.parse(localStorage.getItem("punch-clock:prefs")!).editorWidth).toBe(700);

    pointer("pointerdown", 700);
    pointer("pointermove", 50); // would hide the calendar: clamped
    pointer("pointerup", 50);
    await settle(el);
    expect(pane().getAttribute("style")).toContain("--editor-width:1240px");

    splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle(el);
    expect(pane().getAttribute("style")).toContain("--editor-width:340px");
    splitter.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await settle(el);
    expect(pane().getAttribute("style")).toContain("--editor-width:372px");
  });

  it("edits start and stop times in the chosen clock style", async () => {
    await mount((config) => (config.settings.time_format = "24"));
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const ed = editor()!;
    const [start, stop] = [...shadow(ed).querySelectorAll("pc-time-input")].map((t) =>
      shadow(t).querySelector("input")!,
    );
    expect(start!.value).toBe("06:00");
    expect(stop!.value).toBe("08:00");

    start!.value = "6:15 pm";
    start!.dispatchEvent(new Event("change"));
    await settle(el);
    expect(ed._draft.start).toBe(1095);
    expect(start!.value).toBe("18:15");
    // The stop time stays 08:00, so the block now runs past midnight.
    expect(ed._draft.duration).toBe(825);

    stop!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true }));
    await settle(el);
    expect(ed._draft.duration).toBe(840);

    start!.value = "25:00";
    start!.dispatchEvent(new Event("change"));
    await settle(el);
    expect(ed._draft.start).toBe(1095);
    expect(start!.getAttribute("aria-invalid")).toBe("true");
  });

  it("uses the clock setting for times", async () => {
    await mount((config) => (config.settings.time_format = "24"));
    const labels = [...shadow(weekView()).querySelectorAll(".gutter span")].map(
      (s) => s.textContent,
    );
    expect(labels).toContain("13:00");
    el.remove();
    await mount((config) => (config.settings.time_format = "12"));
    const twelve = [...shadow(weekView()).querySelectorAll(".gutter span")].map(
      (s) => s.textContent,
    );
    expect(twelve).toContain("1 PM");
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
