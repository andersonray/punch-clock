import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { partitionOptions, type PcCombobox } from "../src/components/pc-combobox";

const OPTIONS = ["off", "heat", "cool", "heat_cool", "auto"];

let box: PcCombobox;
let changes: string[];

beforeAll(async () => {
  await import("../src/main");
});

afterEach(() => box?.remove());

async function mount(value = "heat"): Promise<void> {
  box = document.createElement("pc-combobox") as PcCombobox;
  box.value = value;
  box.options = OPTIONS;
  box.label = "Value";
  changes = [];
  box.addEventListener("value-changed", (e) => changes.push((e as CustomEvent).detail.value));
  document.body.append(box);
  await box.updateComplete;
}

const root = () => box.shadowRoot!;
const input = () => root().querySelector("input")!;
const listed = () =>
  [...root().querySelectorAll("li")].map((li) =>
    li.getAttribute("role") === "separator" ? "---" : li.textContent!.trim(),
  );

async function type(text: string): Promise<void> {
  input().value = text;
  input().dispatchEvent(new Event("input"));
  await box.updateComplete;
}

describe("partitionOptions", () => {
  it("keeps order and splits on a case-insensitive substring", () => {
    expect(partitionOptions(OPTIONS, "CO")).toEqual([
      ["cool", "heat_cool"],
      ["off", "heat", "auto"],
    ]);
    expect(partitionOptions(OPTIONS, "  ")).toEqual([OPTIONS, []]);
    expect(partitionOptions(OPTIONS, "zzz")).toEqual([[], OPTIONS]);
  });
});

describe("pc-combobox", () => {
  it("shows every option when opened, with the current value marked", async () => {
    await mount("heat");
    root().querySelector<HTMLButtonElement>(".toggle")!.click();
    await box.updateComplete;
    expect(listed()).toEqual(OPTIONS);
    const selected = root().querySelector('[aria-selected="true"]')!;
    expect(selected.textContent!.trim()).toBe("heat");
  });

  it("puts matches for typed text first, above a divider", async () => {
    await mount("heat");
    await type("co");
    expect(listed()).toEqual(["cool", "heat_cool", "---", "off", "heat", "auto"]);
    expect(root().querySelector("mark")!.textContent).toBe("co");
    // Without matches there's no divider, and everything is still listed.
    await type("xyz");
    expect(listed()).toEqual(OPTIONS);
  });

  it("chooses an option with the keyboard or the mouse", async () => {
    await mount("heat");
    await type("co");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await box.updateComplete;
    expect(changes).toEqual(["cool"]); // Arrow Down goes to the first match
    expect(root().querySelector("ul")).toBeNull();

    root().querySelector<HTMLButtonElement>(".toggle")!.click();
    await box.updateComplete;
    [...root().querySelectorAll("li")].find((li) => li.textContent!.trim() === "auto")!.click();
    await box.updateComplete;
    expect(changes).toEqual(["cool", "auto"]);
  });

  it("accepts free text", async () => {
    await mount("");
    await type("21.5");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await box.updateComplete;
    expect(changes).toEqual(["21.5"]);
  });
});
