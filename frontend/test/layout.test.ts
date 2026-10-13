import { describe, expect, it } from "vitest";
import { layoutDay, type LayoutInput } from "../src/logic/layout";

const item = (id: string, start: number, end: number, seq = 0): LayoutInput => ({
  id,
  start,
  end,
  seq,
});

const byId = (items: LayoutInput[], minVisual = 0) =>
  Object.fromEntries(
    layoutDay(items, minVisual).map((p) => [p.id, { left: p.left, width: p.width }]),
  );

describe("layoutDay", () => {
  it("gives non-overlapping blocks the full width", () => {
    expect(byId([item("a", 0, 60), item("b", 60, 120)])).toEqual({
      a: { left: 0, width: 1 },
      b: { left: 0, width: 1 },
    });
  });

  it("splits overlapping blocks side by side", () => {
    expect(byId([item("a", 0, 120), item("b", 60, 180)])).toEqual({
      a: { left: 0, width: 0.5 },
      b: { left: 0.5, width: 0.5 },
    });
  });

  it("reuses columns in a chain (A overlaps B, B overlaps C, A doesn't overlap C)", () => {
    const result = byId([item("a", 0, 60), item("b", 30, 90), item("c", 60, 120)]);
    expect(result.a).toEqual({ left: 0, width: 0.5 });
    expect(result.b).toEqual({ left: 0.5, width: 0.5 });
    expect(result.c).toEqual({ left: 0, width: 0.5 });
  });

  it("expands into free columns to the right", () => {
    // x, y and z start together (3 columns). w starts after y and z have ended, so it
    // takes y's column and widens over z's.
    const result = byId([
      item("x", 0, 180),
      item("y", 0, 60),
      item("z", 0, 60),
      item("w", 90, 180),
    ]);
    expect(result.x).toEqual({ left: 0, width: 1 / 3 });
    expect(result.w).toEqual({ left: 1 / 3, width: 2 / 3 });
    const late = byId([item("a", 0, 240), item("b", 0, 60), item("c", 120, 180)]);
    expect(late.c).toEqual({ left: 0.5, width: 0.5 });
  });

  it("treats very short blocks as taller so labels don't collide", () => {
    expect(byId([item("a", 0, 5), item("b", 10, 20)], 20)).toEqual({
      a: { left: 0, width: 0.5 },
      b: { left: 0.5, width: 0.5 },
    });
  });

  it("is stable for identical blocks", () => {
    const result = byId([item("x", 0, 60, 2), item("y", 0, 60, 1)]);
    expect(result.y).toEqual({ left: 0, width: 0.5 });
    expect(result.x).toEqual({ left: 0.5, width: 0.5 });
  });
});
