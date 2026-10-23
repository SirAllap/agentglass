/*
 * Recent is a list, not a folder: its rows come from many folders, so a row's name is its whole
 * path, and everything that joins `dir + name` has to take that as the answer.
 */
import { describe, expect, test } from "bun:test";
import { crumbs, isRecent, joinPath, nextRecentSort, RECENT, RECENT_SORT, recentDisplay, rowLabel } from "../src/lib/finderMiller.ts";
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

describe("Recent's own sort (Strata: Recency first, no Folders first)", () => {
  const r = (name: string, mtime: number, kind: "file" | "dir" = "file") => ({ name, kind, bytes: 1, mtime, items: null, hidden: false }) as never;
  // The server hands Recent over newest first.
  const rows = [r("/h/zeta.md", 30), r("/h/dir", 20, "dir"), r("/h/alpha.md", 10)];
  const o = { needle: "", hidden: false, group: false };
  test("starts on Recency, newest first, as the server ordered it", () => {
    expect(RECENT_SORT).toEqual({ key: "recency", dir: "desc" });
    expect(recentDisplay(rows, o, RECENT_SORT).rows.map((x) => x.name)).toEqual(["/h/zeta.md", "/h/dir", "/h/alpha.md"]);
  });
  test("Recency ascending is the oldest first; another key sorts, folders are not lifted", () => {
    expect(recentDisplay(rows, o, { key: "recency", dir: "asc" }).rows.map((x) => x.name)).toEqual(["/h/alpha.md", "/h/dir", "/h/zeta.md"]);
    expect(recentDisplay(rows, o, { key: "name", dir: "asc" }).rows.map((x) => x.name)).toEqual(["/h/alpha.md", "/h/dir", "/h/zeta.md"]);
  });
  test("the same key reverses, a new one starts ascending, Recency starts newest first", () => {
    expect(nextRecentSort(RECENT_SORT, "recency")).toEqual({ key: "recency", dir: "asc" });
    expect(nextRecentSort(RECENT_SORT, "size")).toEqual({ key: "size", dir: "asc" });
    expect(nextRecentSort({ key: "size", dir: "desc" }, "recency")).toEqual({ key: "recency", dir: "desc" });
  });
});

describe("the column wires it", () => {
  const col = Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url));
  test("the menu offers Recency in Recent and no Folders first there", async () => {
    const t = await col.text();
    expect(t).toContain('"recency", "name", "size", "modified", "type"');
    expect(t).toContain("{!recent && <><MenuRule />");
  });
});
