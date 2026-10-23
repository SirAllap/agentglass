/*
 * Recent is a list, not a folder: its rows come from many folders, so a row's name is its whole
 * path, and everything that joins `dir + name` has to take that as the answer.
 */
import { describe, expect, test } from "bun:test";
import { crumbs, isRecent, joinPath, RECENT, rowLabel } from "../src/lib/finderMiller.ts";
import { readMachineSnap, writeMachineSnap } from "../src/lib/finderMachineState.ts";

describe("rows of Recent", () => {
  test("a name that is a whole path is the path, a plain name is joined as before", () => {
    expect(joinPath(RECENT, "/home/ann/notes/a b.md")).toBe("/home/ann/notes/a b.md");
    expect(joinPath("/home/ann", "orbit")).toBe("/home/ann/orbit");
    expect(joinPath("/", "etc")).toBe("/etc");
  });
  test("a row is called by its last segment", () => {
    expect(rowLabel("/home/ann/notes/a b.md")).toBe("a b.md");
    expect(rowLabel("README.md")).toBe("README.md");
  });
  test("the path bar says Recent, and Recent is the one place that is a list", () => {
    expect(crumbs(RECENT, "/home/ann")).toEqual([{ label: "Recent", path: RECENT }]);
    expect(isRecent(RECENT)).toBe(true);
    expect(isRecent("/home/ann")).toBe(false);
  });
  test("the finder reopens in Recent", () => {
    const snap = readMachineSnap(writeMachineSnap({ v: 1, trail: [RECENT], sel: ["/home/ann/x.md"], focusCol: 0, scroll: {}, dragged: {}, peek: false }));
    expect(snap?.trail).toEqual([RECENT]);
  });
});

describe("the sidebar's Recent does not start the old view", () => {
  test("it goes to the list in the columns", async () => {
    const src = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
    expect(src).toContain("onRecent={() => go(RECENT)}");
    const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
    expect(palette).not.toContain('onRecent={() => goTab("recent")}');
  });
});
