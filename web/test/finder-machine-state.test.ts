/*
 * Closing the finder is not leaving it: it comes back at the same folder chain,
 * selection, scroll and preview, also after the app restarts. What is stored is
 * only believed when it still draws — a path that is not absolute, a chain whose
 * columns are not each a child of the one before, or a number that is not one.
 */
import { describe, expect, test } from "bun:test";
import { readMachineSnap, writeMachineSnap, type MachineSnap } from "../src/lib/finderMachineState.ts";

const snap: MachineSnap = {
  v: 1, trail: ["/home/ann", "/home/ann/code", "/home/ann/code/orbit"], sel: ["code", "orbit", "README.md"], focusCol: 2,
  scroll: { "/home/ann/code/orbit": 340 }, dragged: { "/home/ann/code": 280 }, peek: false, prevDrag: 410,
};

describe("round trip", () => {
  test("what was written is what comes back", () => { expect(readMachineSnap(writeMachineSnap(snap))).toEqual(snap); });
  test("nothing stored, or damage, is nothing: the caller starts at its own place", () => {
    expect(readMachineSnap(null)).toBeNull();
    expect(readMachineSnap("{not json")).toBeNull();
    expect(readMachineSnap("42")).toBeNull();
    expect(readMachineSnap(JSON.stringify({ ...snap, v: 2 }))).toBeNull();
  });
});

describe("only what still draws", () => {
  const read = (o: object) => readMachineSnap(JSON.stringify({ ...snap, ...o }));
  test("a relative or empty first column is refused", () => {
    expect(read({ trail: ["code"], sel: ["x"] })).toBeNull();
    expect(read({ trail: [], sel: [] })).toBeNull();
  });
  test("a chain is cut where a column is not the child of the one before", () => {
    const r = read({ trail: ["/home/ann", "/home/ann/code", "/tmp/elsewhere"], sel: ["code", "x", "y"] });
    expect(r?.trail).toEqual(["/home/ann", "/home/ann/code"]);
    expect(r?.sel).toEqual(["code", "x"]);
  });
  test("a selection list is the length of the chain, missing names are null", () => {
    expect(read({ sel: ["code"] })?.sel).toEqual(["code", null, null]);
    expect(read({ sel: ["a", "b", "c", "d", "e"] })?.sel).toEqual(["a", "b", "c"]);
    expect(read({ sel: ["code", 7, null] })?.sel).toEqual(["code", null, null]);
  });
  test("the focused column is inside the chain", () => {
    expect(read({ focusCol: 9 })?.focusCol).toBe(2);
    expect(read({ focusCol: -3 })?.focusCol).toBe(0);
    expect(read({ focusCol: "x" })?.focusCol).toBe(0);
  });
  test("scroll and widths keep only numbers that make sense, for columns still in the chain", () => {
    const r = read({ scroll: { "/home/ann/code/orbit": -5, "/home/ann/code": 12, "/gone": 9, "/home/ann": "x" }, dragged: { "/home/ann/code": 20, "/gone": 300 } });
    expect(r?.scroll).toEqual({ "/home/ann/code": 12 });
    expect(r?.dragged).toEqual({});
  });
  test("a peek and a preview width are optional and typed", () => {
    expect(read({ peek: "yes", prevDrag: "wide" })?.peek).toBe(false);
    expect(read({ prevDrag: "wide" })?.prevDrag).toBeUndefined();
  });
});

describe("the finder uses it", () => {
  const src = Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
  test("reads on mount and writes on change", async () => {
    const s = await src;
    expect(s).toContain("readMachineSnap(");
    expect(s).toContain("writeMachineSnap(");
  });
});
