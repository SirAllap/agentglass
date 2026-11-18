import { describe, expect, test } from "bun:test";
import { MAX_ELBOW_COLS, elbowLanes, elbowsOf } from "../src/lib/prStackElbow.ts";

/* Lane order: three sisters on #1042, then a granddaughter that hangs on the second sister. */
const lane = [1043, 1044, 1045, 1046];
const parent: Record<number, number> = { 1043: 1042, 1044: 1042, 1045: 1042, 1046: 1044 };

describe("stack elbow", () => {
  test("the granddaughter starts at itself and ends at its true parent, not at the card above", () => {
    const e = elbowsOf(lane, (n) => parent[n], () => null);
    expect(e).toEqual([{ from: 1046, to: 1044, fromIndex: 3, toIndex: 1, span: 1 }]);
  });

  test("no elbow when the rail already joins the parent", () => {
    expect(elbowsOf(lane, (n) => parent[n], (n) => (n === 1046 ? 1044 : null))).toEqual([]);
  });

  test("no elbow for a parent outside the lane, a trunk base or itself", () => {
    expect(elbowsOf([1043], () => 1042, () => null)).toEqual([]);
    expect(elbowsOf([1043], () => null, () => null)).toEqual([]);
    expect(elbowsOf([1043], () => 1043, () => null)).toEqual([]);
  });

  test("a parent below the child ends there too", () => {
    expect(elbowsOf([1046, 1044], (n) => (n === 1046 ? 1044 : null), () => null)[0]).toMatchObject({ from: 1046, to: 1044, fromIndex: 0, toIndex: 1, span: 0 });
  });

  test("overlapping elbows take different gutter columns", () => {
    const e = elbowsOf([1, 2, 3, 4], (n) => ({ 3: 1, 4: 2 } as Record<number, number>)[n], () => null);
    const cols = elbowLanes(e);
    expect(cols.get(3)).not.toBe(cols.get(4));
  });

  test("columns never pass the gutter", () => {
    const lane = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const e = elbowsOf(lane, (n) => (n > 6 ? n - 6 : null), () => null);
    expect(e.length).toBe(5);
    const cols = [...elbowLanes(e).values()];
    expect(Math.max(...cols)).toBe(MAX_ELBOW_COLS - 1);
  });

  test("a hidden card starts and ends no elbow", () => {
    const parent = (n: number) => (n === 3 ? 1 : n === 4 ? 2 : null);
    expect(elbowsOf([1, 2, 3, 4], parent, () => null, (n) => n === 1 || n === 4)).toEqual([]);
    expect(elbowsOf([1, 2, 3, 4], parent, () => null).length).toBe(2);
  });
});
