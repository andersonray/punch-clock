// Smoke test: mount the whole panel against a fake `hass` and drive the main flows.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Block, BlockUpdate, Config, HomeAssistant, Status } from "../src/types";
import type { PunchClockPanel } from "../src/panel/punch-clock-panel";
import type { PcBlockEditor } from "../src/components/pc-block-editor";
import type { PcConfirmDialog } from "../src/components/pc-confirm-dialog";
import { PALETTE } from "../src/logic/model";

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

const makeStatus = (): Status => ({
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
});

interface Fake {
  hass: HomeAssistant;
  calls: Record<string, unknown>[];
}

/** A fake Home Assistant whose block commands change the config and push it, like the server. */
function fakeHass(initial: Config, status: Status = makeStatus()): Fake {
  localStorage.clear();
  const calls: Record<string, unknown>[] = [];
  let config = initial;
  let push: ((message: unknown) => void) | null = null;
  const commit = (blocks: Block[]) => {
    config = { ...config, revision: config.revision + 1, blocks };
    push?.({ kind: "config", config: structuredClone(config) });
  };
  const update = (updates: BlockUpdate[]) => {
    const changes = new Map(updates.map((u) => [u.block_id, u.changes]));
    commit(config.blocks.map((b) => ({ ...b, ...changes.get(b.id) })));
    return config.blocks.filter((b) => changes.has(b.id));
  };
  const remove = (ids: string[]) => commit(config.blocks.filter((b) => !ids.includes(b.id)));
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
          const blocks = inputs.map((b, i) => ({ ...b, id: `b_new${i}`, seq: 10 + i }));
          commit([...config.blocks, ...blocks]);
          return { blocks } as T;
        }
        case "punch_clock/blocks/update": {
          const [block] = update([msg as unknown as BlockUpdate]);
          return { block } as T;
        }
        case "punch_clock/blocks/update_many":
          return { blocks: update(msg.updates as BlockUpdate[]) } as T;
        case "punch_clock/blocks/delete":
          remove([msg.block_id as string]);
          return {} as T;
        case "punch_clock/blocks/delete_many":
          remove(msg.block_ids as string[]);
          return {} as T;
        default:
          return {} as T;
      }
    },
    connection: {
      async subscribeMessage<T>(callback: (message: T) => void) {
        push = callback as (message: unknown) => void;
        callback({ kind: "config", config: structuredClone(config) } as T);
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

async function mount(
  adjust: (config: Config) => void = () => {},
  adjustStatus: (status: Status) => void = () => {},
): Promise<void> {
  const config = makeConfig();
  adjust(config);
  const status = makeStatus();
  adjustStatus(status);
  fake = fakeHass(config, status);
  el = document.createElement("punch-clock-panel");
  el.hass = fake.hass;
  document.body.append(el);
  await settle(el);
}

const weekView = () => shadow(el).querySelector("pc-week-view")!;
const blocks = () => [...shadow(weekView()).querySelectorAll<HTMLButtonElement>(".block")];
const editor = () => shadow(el).querySelector("pc-block-editor") as PcBlockEditor | null;

const timeInputs = (ed: Element) => [...shadow(ed).querySelectorAll("pc-time-input")];
const whenRows = (ed: Element) => [...shadow(ed).querySelectorAll(".when-row:not(.head)")];
const selected = () => blocks().filter((b) => b.classList.contains("selected"));
/** Answer the panel's confirmation dialog (or the one in `host`, such as the editor). */
const confirmChoice = async (label: string, host: Element = el) => {
  const dialog = shadow(host).querySelector("pc-confirm-dialog")!;
  [...shadow(dialog).querySelectorAll("button")]
    .find((b) => b.textContent?.trim() === label)!
    .click();
  await settle(el);
};
/** Click the index-th calendar block (in column order) whose text includes `text`. */
const clickBlock = async (text: string, index = 0) => {
  const matching = blocks().filter((b) => b.textContent?.includes(text));
  matching[index]!.click();
  await settle(el);
};
const lastCall = (type: string) => fake.calls.findLast((c) => c.type === `punch_clock/${type}`);
const updates = () =>
  fake.calls
    .filter((c) => c.type === "punch_clock/blocks/update_many")
    .flatMap((c) => c.updates as BlockUpdate[]);

/** Type a new name and leave the field. */
function rename(ed: Element, name: string): void {
  const field = shadow(ed).querySelector<HTMLInputElement>(".name")!;
  field.value = name;
  field.dispatchEvent(new Event("input"));
  field.dispatchEvent(new Event("change"));
}

/** "Morning" also runs on Wednesday and Friday; a purple "Morning" isn't in its group. */
function addMorningGroup(config: Config): void {
  const morning = config.blocks.find((b) => b.id === "b_morning")!;
  config.blocks.push(
    { ...structuredClone(morning), id: "b_wed", seq: 4, day: 2, start: 420 },
    { ...structuredClone(morning), id: "b_fri", seq: 5, day: 4, start: 480 },
    { ...structuredClone(morning), id: "b_purple", seq: 6, day: 5, color: "#8e24aa" },
  );
}

const headerText = (picker: Element) =>
  [...shadow(picker).querySelectorAll(".seg")].map((b) => b.textContent?.trim());

const buttonNamed = (root: Element, name: string) =>
  [...shadow(root).querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;

/** Press and release on the picker's dial at a point in its 256x256 viewBox. */
function tapDial(picker: Element, x: number, y: number): void {
  const dial = shadow(picker).querySelector(".dial")!;
  dial.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }) as DOMRect;
  for (const type of ["pointerdown", "pointerup"]) {
    dial.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }),
    );
  }
}

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
    expect(updates()).toEqual([]);
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

  it("picks a time on the 24-hour clock dial", async () => {
    await mount((config) => (config.settings.time_format = "24"));
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const ed = editor()!;
    const [start] = timeInputs(ed);
    const field = shadow(start).querySelector<HTMLButtonElement>(".field")!;
    expect(field.textContent).toContain("06:00");

    field.click();
    await settle(el);
    const picker = shadow(start).querySelector("pc-time-picker")!;
    expect(picker.open).toBe(true);
    expect(headerText(picker)).toEqual(["06", "00"]);
    expect(shadow(picker).querySelector(".ampm")).toBeNull(); // no AM/PM in 24-hour mode
    expect(shadow(picker).querySelectorAll("text.inner")).toHaveLength(12);

    // 3 o'clock on the inner ring is 15; releasing switches to minutes.
    tapDial(picker, 128 + 62, 128);
    await settle(el);
    expect(headerText(picker)).toEqual(["15", "00"]);
    expect(shadow(picker).querySelector(".dial")!.getAttribute("aria-label")).toBe("Minute");
    tapDial(picker, 128, 228); // 6 o'clock = 30 minutes
    await settle(el);
    expect(headerText(picker)).toEqual(["15", "30"]);

    buttonNamed(picker, "OK").click();
    await settle(el);
    expect(picker.open).toBe(false);
    expect(ed._draft.start).toBe(930);
    expect(ed._draft.duration).toBe(990); // the stop time stays 08:00, now the next day
    expect(field.textContent).toContain("15:30");
  });

  it("uses AM/PM on the 12-hour dial and accepts typed times", async () => {
    await mount((config) => (config.settings.time_format = "12"));
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const ed = editor()!;
    const [start, stop] = timeInputs(ed);

    shadow(stop).querySelector<HTMLButtonElement>(".field")!.click();
    await settle(el);
    let picker = shadow(stop).querySelector("pc-time-picker")!;
    expect(headerText(picker)).toEqual(["8", "00"]);
    expect(shadow(picker).querySelectorAll("text.inner")).toHaveLength(0);
    buttonNamed(picker, "PM").click();
    buttonNamed(picker, "OK").click();
    await settle(el);
    expect(ed._draft.duration).toBe(840); // 6:00 AM to 8:00 PM

    shadow(start).querySelector<HTMLButtonElement>(".field")!.click();
    await settle(el);
    picker = shadow(start).querySelector("pc-time-picker")!;
    shadow(picker).querySelector<HTMLButtonElement>('[aria-label="Type the time"]')!.click();
    await settle(el);
    const typeInto = (label: string, value: string) => {
      const input = shadow(picker).querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    typeInto("Hour", "13");
    await settle(el);
    buttonNamed(picker, "OK").click();
    await settle(el);
    expect(picker.open).toBe(true);
    expect(shadow(picker).querySelector(".error-text")?.textContent).toContain("1–12");

    typeInto("Hour", "7");
    typeInto("Minute", "45");
    await settle(el);
    buttonNamed(picker, "OK").click();
    await settle(el);
    expect(picker.open).toBe(false);
    expect(ed._draft.start).toBe(465); // 7:45 AM
    expect(ed._draft.duration).toBe(735); // still ends at 8:00 PM

    // Cancel leaves the time alone.
    shadow(start).querySelector<HTMLButtonElement>(".field")!.click();
    await settle(el);
    tapDial(picker, 228, 128);
    await settle(el);
    buttonNamed(picker, "Cancel").click();
    await settle(el);
    expect(ed._draft.start).toBe(465);
  });

  it("moves the block in the calendar as soon as its day or times change", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    const column = (i: number) =>
      [...shadow(weekView()).querySelectorAll(".col")][i]!.textContent ?? "";
    // The week starts on Sunday, so Wednesday is column 3 and Friday column 5.
    expect(column(3)).toContain("Target");

    const day = shadow(ed).querySelector<HTMLSelectElement>("select")!;
    day.value = "4";
    day.dispatchEvent(new Event("change"));
    await settle(el);
    expect(column(3)).not.toContain("Target");
    expect(column(5)).toContain("Target");

    const [start] = timeInputs(ed);
    shadow(start)
      .querySelector(".field")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true }));
    await settle(el);
    const moved = blocks().find((b) => b.textContent?.includes("Target"))!;
    expect(moved.getAttribute("style")).toContain("top:492px"); // 10:15 at 48 px per hour
    expect(updates()).toEqual([]);

    [...shadow(ed).querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Discard")!
      .click();
    await settle(el);
    expect(column(3)).toContain("Target");
    expect(column(5)).not.toContain("Target");
  });

  it("marks blocks whose conditions aren't met right now", async () => {
    await mount(undefined, (status) => {
      status.blocks = {
        b_morning: { in_window: false, conditions_met: false, active: false },
        b_target: { in_window: false, conditions_met: true, active: false },
      };
    });
    const morning = blocks().find((b) => b.textContent?.includes("Morning"))!;
    const target = blocks().find((b) => b.textContent?.includes("Target"))!;
    expect(morning.classList.contains("unmet")).toBe(true);
    expect(morning.querySelector(".unmet-badge")).not.toBeNull();
    expect(morning.getAttribute("aria-label")).toContain("conditions not met right now");
    expect(target.classList.contains("unmet")).toBe(false);
    expect(shadow(weekView()).querySelector(".scroller")!.classList.contains("tab-off")).toBe(
      false,
    );
  });

  it("hatches every block when the tab isn't running, with the icon only for unmet ones", async () => {
    await mount(undefined, (status) => {
      status.tabs.t_1 = { enabled: false, conditions_met: true, active: false };
      status.blocks = {
        b_morning: { in_window: false, conditions_met: false, active: false },
        b_target: { in_window: false, conditions_met: true, active: false },
      };
    });
    expect(shadow(weekView()).querySelector(".scroller")!.classList.contains("tab-off")).toBe(true);
    const morning = blocks().find((b) => b.textContent?.includes("Morning"))!;
    const target = blocks().find((b) => b.textContent?.includes("Target"))!;
    expect(morning.querySelector(".unmet-badge")).not.toBeNull();
    expect(target.querySelector(".unmet-badge")).toBeNull(); // would run if the tab were on
    expect(target.getAttribute("aria-label")).toContain("its tab isn't running");
  });

  it("offers to save unsaved changes when leaving a block", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('.swatch[aria-label="#33b679"]')!.click();
    await settle(el);
    expect(ed.dirty).toBe(true);

    const confirm = shadow(el).querySelector("pc-confirm-dialog")!;
    const choose = async (label: string) => {
      [...shadow(confirm).querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === label)!
        .click();
      await settle(el);
    };
    const leave = async () => {
      blocks()
        .find((b) => b.textContent?.includes("Morning"))!
        .click();
      await settle(el);
    };

    // Cancel stays on the block with the changes kept.
    await leave();
    expect(
      [...shadow(confirm).querySelectorAll("button")].map((b) => b.textContent?.trim()),
    ).toEqual(["Cancel", "Discard", "Save"]);
    await choose("Cancel");
    expect(editor()!._draft.id).toBe("b_target");
    expect(editor()!.dirty).toBe(true);

    // Save writes the block, then moves on.
    await leave();
    await choose("Save");
    expect(updates()).toMatchObject([{ block_id: "b_target", changes: { color: "#33b679" } }]);
    expect(editor()!._draft.id).toBe("b_morning");
  });

  it("stays on the block if saving from the prompt fails", async () => {
    await mount();
    blocks()
      .find((b) => b.textContent?.includes("Target"))!
      .click();
    await settle(el);
    const ed = editor()!;
    // An action without an entity can't be saved.
    [...shadow(ed).querySelectorAll("button")]
      .find((b) => b.textContent?.includes("Entity action"))!
      .click();
    await settle(el);
    blocks()
      .find((b) => b.textContent?.includes("Morning"))!
      .click();
    await settle(el);
    const confirm = shadow(el).querySelector("pc-confirm-dialog")!;
    [...shadow(confirm).querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "Save")!
      .click();
    await settle(el);
    expect(editor()!._draft.id).toBe("b_target");
    expect(shadow(editor()).querySelector(".error-text")?.textContent).toContain("needs an entity");
    expect(updates()).toEqual([]);
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

  it("selects a whole group and lists the time of each of its blocks", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning", 1); // Wednesday
    const ed = editor()!;
    expect(ed._draft.id).toBe("b_wed");
    expect(ed._whens.map((w) => w.id)).toEqual(["b_morning", "b_wed", "b_fri"]);
    expect(selected()).toHaveLength(3);
    const rows = whenRows(ed);
    expect(rows).toHaveLength(3);
    expect(rows[1]!.classList.contains("current")).toBe(true);
    expect(rows.every((r) => r.querySelector('[aria-label^="Split"]'))).toBe(true);

    // A block on its own has one time and nothing to split.
    await clickBlock("Target");
    expect(whenRows(editor()!)).toHaveLength(1);
    expect(shadow(editor()).querySelector('[aria-label^="Split"]')).toBeNull();
    expect(selected()).toHaveLength(1);
  });

  it("saves the shared settings and each block's times at once", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning");
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('.swatch[aria-label="#33b679"]')!.click();
    await settle(el);
    const friday = whenRows(ed)[2]!.querySelector("select")!;
    friday.value = "5";
    friday.dispatchEvent(new Event("change"));
    await settle(el);
    // The calendar shows the change for every block of the group before saving.
    expect(selected().every((b) => b.getAttribute("style")?.includes("#33b679"))).toBe(true);
    expect(updates()).toEqual([]);

    buttonNamed(ed, "Save").click();
    await settle(el);
    const saved = updates();
    expect(saved.map((u) => u.block_id)).toEqual(["b_morning", "b_wed", "b_fri"]);
    expect(saved.map((u) => u.changes.day)).toEqual([0, 2, 5]);
    expect(saved.every((u) => u.changes.color === "#33b679" && u.changes.name === "Morning")).toBe(
      true,
    );
    expect(saved[2]!.changes.actions).toEqual(saved[0]!.changes.actions);
    expect(fake.calls.filter((c) => c.type === "punch_clock/blocks/update_many")).toHaveLength(1);
    expect(ed.dirty).toBe(false);
  });

  it("asks before saving a block with another group's name and color", async () => {
    await mount(addMorningGroup);
    await clickBlock("Target");
    const ed = editor()!;
    rename(ed, "Morning"); // Target already has Morning's color
    await settle(el);
    expect(ed._whens.map((w) => w.id)).toEqual(["b_target"]); // nothing joins before saving
    expect(selected()).toHaveLength(1);

    // Cancel keeps the changes unsaved, so the name or color can be changed.
    buttonNamed(ed, "Save").click();
    await settle(el);
    const ask = shadow(ed).querySelector<PcConfirmDialog>("pc-confirm-dialog")!;
    expect(ask._options?.heading).toBe('Join the "Morning" group?');
    await confirmChoice("Cancel", ed);
    expect(updates()).toEqual([]);
    expect(ed.dirty).toBe(true);

    // Joining takes the group's actions and conditions.
    buttonNamed(ed, "Save").click();
    await settle(el);
    await confirmChoice("Replace and join", ed);
    expect(updates()).toMatchObject([
      {
        block_id: "b_target",
        changes: {
          name: "Morning",
          actions: [{ entity_id: "climate.house", settings: { temperature: 21 } }],
          conditions: { items: [{ entity_id: "input_boolean.guests" }] },
        },
      },
    ]);
    expect(ed._whens.map((w) => w.id)).toEqual(["b_morning", "b_wed", "b_target", "b_fri"]);
    expect(selected()).toHaveLength(4);
    expect(ed.dirty).toBe(false);
  });

  it("joins a group without asking when the actions and conditions match", async () => {
    await mount((config) => {
      addMorningGroup(config);
      const morning = config.blocks.find((b) => b.id === "b_morning")!;
      config.blocks.push({ ...structuredClone(morning), id: "b_thu", day: 3, name: "Brunch" });
    });
    await clickBlock("Brunch");
    const ed = editor()!;
    rename(ed, "Morning");
    await settle(el);
    buttonNamed(ed, "Save").click();
    await settle(el);
    expect(shadow(ed).querySelector<PcConfirmDialog>("pc-confirm-dialog")!._options).toBeNull();
    expect(updates()).toMatchObject([{ block_id: "b_thu", changes: { name: "Morning" } }]);
    expect(ed._whens).toHaveLength(4);
  });

  it("splits a block off from its group with a numbered name and a new color", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning");
    whenRows(editor()!)[1]!.querySelector<HTMLButtonElement>('[aria-label^="Split"]')!.click();
    await settle(el);
    expect(lastCall("blocks/update")).toMatchObject({
      block_id: "b_wed",
      changes: { name: "Morning 1" },
    });
    const ed = editor()!;
    expect(ed._draft).toMatchObject({ id: "b_wed", name: "Morning 1" });
    // A palette color that no other block in the tab uses.
    expect(PALETTE).toContain(ed._draft.color);
    expect(["#039be5", "#8e24aa"]).not.toContain(ed._draft.color);
    expect(whenRows(ed)).toHaveLength(1);
    expect(selected()).toHaveLength(1);

    // The next one split off gets the next number.
    await clickBlock("Morning", 0);
    whenRows(editor()!)[1]!.querySelector<HTMLButtonElement>('[aria-label^="Split"]')!.click();
    await settle(el);
    expect(editor()!._draft).toMatchObject({ id: "b_fri", name: "Morning 2" });
  });

  it("asks to save unsaved changes before splitting", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning");
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('.swatch[aria-label="#33b679"]')!.click();
    await settle(el);
    whenRows(ed)[2]!.querySelector<HTMLButtonElement>('[aria-label^="Split"]')!.click();
    await settle(el);
    await confirmChoice("Save");
    expect(updates()).toHaveLength(3);
    expect(lastCall("blocks/update")).toMatchObject({
      block_id: "b_fri",
      changes: { name: "Morning 1" },
    });
    expect(editor()!._draft).toMatchObject({ id: "b_fri", name: "Morning 1" });
    expect(["#33b679", "#039be5", "#8e24aa"]).not.toContain(editor()!._draft.color);
    expect(whenRows(editor()!)).toHaveLength(1);
  });

  it("adds a time on the next day, and creates its block when saving", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning");
    const ed = editor()!;
    for (let i = 0; i < 2; i++) {
      buttonNamed(ed, "Add a time").click();
      await settle(el);
    }
    // The last row is Friday 8:00-10:00, so Saturday, then Sunday.
    expect(ed._whens.slice(3)).toMatchObject([
      { day: 5, start: 480, duration: 120 },
      { day: 6, start: 480, duration: 120 },
    ]);
    expect(selected()).toHaveLength(5); // shown in the calendar before saving
    expect(fake.calls.some((c) => String(c.type).startsWith("punch_clock/blocks/"))).toBe(false);

    // An unsaved time can't be selected in the calendar (Sunday is the first column).
    selected()[0]!.click();
    await settle(el);
    expect(editor()!._draft.id).toBe("b_morning");

    // Its row has a remove button instead of the split button.
    const sunday = whenRows(ed)[4]!;
    expect(sunday.querySelector('[aria-label^="Split"]')).toBeNull();
    sunday.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')!.click();
    await settle(el);
    expect(ed._whens).toHaveLength(4);

    buttonNamed(ed, "Save").click();
    await settle(el);
    expect(updates()).toEqual([]);
    expect(lastCall("blocks/create")!.blocks).toMatchObject([
      {
        tab_id: "t_1",
        name: "Morning",
        day: 5,
        start: 480,
        duration: 120,
        actions: [{ entity_id: "climate.house" }],
      },
    ]);
    expect(ed._whens.map((w) => w.id)).toEqual(["b_morning", "b_wed", "b_fri", "b_new0"]);
    expect(ed.dirty).toBe(false);
  });

  it("needs a name to save a block with more than one time", async () => {
    await mount((config) => {
      config.blocks.find((b) => b.id === "b_target")!.name = "";
    });
    await clickBlock("New block");
    const ed = editor()!;
    buttonNamed(ed, "Add a time").click();
    await settle(el);
    expect(shadow(ed).querySelector(".warning-text")?.textContent).toContain(
      "Give the block a name",
    );
    buttonNamed(ed, "Save").click();
    await settle(el);
    expect(shadow(ed).querySelector(".error-text")?.textContent).toContain("Give the block a name");
    expect(lastCall("blocks/create")).toBeUndefined();

    rename(ed, "Lunch");
    await settle(el);
    buttonNamed(ed, "Save").click();
    await settle(el);
    expect(updates()).toMatchObject([{ block_id: "b_target", changes: { name: "Lunch" } }]);
    expect(lastCall("blocks/create")!.blocks).toMatchObject([
      { name: "Lunch", day: 3, start: 600, duration: 60 },
    ]);
  });

  it("groups a block with the one the eyedropper copies from", async () => {
    await mount(addMorningGroup);
    await clickBlock("Target");
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
    await settle(el);
    await clickBlock("Morning", 1);
    await confirmChoice("Replace");
    expect(ed._draft.id).toBe("b_target");
    expect(ed._whens.map((w) => w.id)).toEqual(["b_morning", "b_wed", "b_target", "b_fri"]);
    expect(selected()).toHaveLength(4);
    expect(shadow(el).querySelector(".toast")?.textContent).toContain('Grouped with "Morning"');

    // Only the block that changed is written.
    buttonNamed(ed, "Save").click();
    await settle(el);
    expect(updates()).toMatchObject([
      { block_id: "b_target", changes: { name: "Morning", day: 2, start: 600 } },
    ]);
    expect(ed._whens).toHaveLength(4);
    expect(ed.dirty).toBe(false);
  });

  it("drops an earlier eyedropper group when copying from another block", async () => {
    await mount(addMorningGroup);
    await clickBlock("Target");
    const ed = editor()!;
    for (const source of ["Morning", "Night"]) {
      shadow(ed).querySelector<HTMLButtonElement>('[aria-label^="Copy actions"]')!.click();
      await settle(el);
      await clickBlock(source);
      await confirmChoice("Replace");
    }
    expect(ed._whens.map((w) => w.id)).toEqual(["b_target", "b_night"]);
  });

  it("keeps unsaved changes when clicking another block of the group", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning");
    const ed = editor()!;
    shadow(ed).querySelector<HTMLButtonElement>('.swatch[aria-label="#33b679"]')!.click();
    await settle(el);
    await clickBlock("Morning", 2); // Friday, in the calendar's unsaved color
    expect(shadow(el).querySelector<PcConfirmDialog>("pc-confirm-dialog")!._options).toBeNull();
    expect(ed._draft).toMatchObject({ id: "b_fri", color: "#33b679" });
    expect(ed.dirty).toBe(true);
    expect(whenRows(ed)[2]!.classList.contains("current")).toBe(true);
  });

  it("deletes one block of a group or the whole group", async () => {
    await mount(addMorningGroup);
    await clickBlock("Morning", 1);
    shadow(editor()).querySelector<HTMLButtonElement>('[aria-label="Delete block"]')!.click();
    await settle(el);
    await confirmChoice("Just this one");
    expect(lastCall("blocks/delete")).toMatchObject({ block_id: "b_wed" });
    expect(editor()!._whens.map((w) => w.id)).toEqual(["b_morning", "b_fri"]);
    expect(selected()).toHaveLength(2);

    shadow(editor()).querySelector<HTMLButtonElement>('[aria-label="Delete block"]')!.click();
    await settle(el);
    await confirmChoice("All 2");
    expect(lastCall("blocks/delete_many")).toMatchObject({ block_ids: ["b_morning", "b_fri"] });
    expect(editor()).toBeNull();
    expect(blocks().some((b) => b.textContent?.includes("Morning"))).toBe(true); // the purple one
  });
});
