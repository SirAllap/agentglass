/*
 * The Ctrl+K overlay of the Machine finder: what Enter and Alt+Enter lead to,
 * how the highlight moves, what the empty states say, and that it is wired where
 * Strata has it. The index behind it is tested on the server (homeindex.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { emptyText, partialResults, hitPath, hitTarget, stepHot } from "../src/lib/finderSearch.ts";

const src = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();

describe("what a hit leads to", () => {
  test("Enter on a folder opens it; on a file selects it inside its own folder", () => {
    expect(hitTarget({ path: "/home/ann/orbit", dir: true }, false)).toEqual({ kind: "open-folder", path: "/home/ann/orbit" });
    expect(hitTarget({ path: "/home/ann/orbit/plan.md", dir: false }, false)).toEqual({ kind: "select", dir: "/home/ann/orbit", name: "plan.md" });
  });
  test("Alt+Enter opens the folder that holds it, with the hit selected, folder or file", () => {
    expect(hitTarget({ path: "/home/ann/orbit/plan.md", dir: false }, true)).toEqual({ kind: "select", dir: "/home/ann/orbit", name: "plan.md" });
    expect(hitTarget({ path: "/home/ann/orbit", dir: true }, true)).toEqual({ kind: "select", dir: "/home/ann", name: "orbit" });
    expect(hitTarget({ path: "/top", dir: true }, true)).toEqual({ kind: "select", dir: "/", name: "top" });
  });
});

describe("the list", () => {
  test("the highlight stops at both ends and survives an empty list", () => {
    expect(stepHot(0, -1, 5)).toBe(0);
    expect(stepHot(4, 1, 5)).toBe(4);
    expect(stepHot(2, 1, 5)).toBe(3);
    expect(stepHot(0, 1, 0)).toBe(0);
  });
  test("a row shows the whole path, as Strata does, and keeps both ends when it is long", () => {
    expect(hitPath("/home/ann/orbit/plan.md")).toBe("/home/ann/orbit/plan.md");
    const long = `/home/ann/${"deep-folder/".repeat(14)}plan.md`;
    const cut = hitPath(long);
    expect(cut.length).toBeLessThanOrEqual(118);
    expect(cut).toContain("…");
    expect(cut.startsWith("/home/ann/deep")).toBe(true);
    expect(cut.endsWith("/plan.md")).toBe(true);
  });
  test("empty states", () => {
    expect(emptyText("", "idle", 0)).toBe("Type to search Home and mounted local drives");
    expect(emptyText("pl", "ready", 3)).toBe("");
    expect(emptyText("pl", "ready", 0)).toBe("No matching files or folders");
    expect(emptyText("pl", "building", 0)).toBe("Searching…");
  });
});

describe("wired where Strata has it", () => {
  test("Ctrl+K opens it inside the finder, before the app's own chord check, and the finder's keys stand down while it is up", async () => {
    const t = await src("components/finder/machine/MachineFinder.tsx");
    const on = t.slice(t.indexOf("const on = (e: KeyboardEvent)"));
    expect(on.indexOf('key.toLowerCase() === "k"')).toBeGreaterThan(0);
    expect(on.indexOf('key.toLowerCase() === "k"')).toBeLessThan(on.indexOf("isAppChord(e)"));
    expect(on.indexOf("searchingRef.current")).toBeGreaterThan(-1);
    expect(on.indexOf("searchingRef.current")).toBeLessThan(on.indexOf('key.toLowerCase() === "k"'));
    expect(t).toContain('aria-label="Search"');
  });
  test("Names are asked of the index and Contents of the text search, and nothing polls", async () => {
    const t = await src("components/finder/machine/FinderSearch.tsx");
    expect(t).toContain("api.diskIndexSearch(");
    expect(t).toContain("api.diskGrep(");
    expect(t).not.toMatch(/setInterval/);
    expect(t).toContain("ctl.abort()");
  });
  test("the shortcut sheet lists it", async () => {
    expect(await src("lib/finderShortcuts.ts")).toContain('keys: "Ctrl+K"');
  });
});

describe("Partial results", () => {
  test("while the index is building, whether or not anything matched yet (Strata shows it beside \"No matching files or folders\")", () => {
    expect(partialResults("building", 3)).toBe(true);
    expect(partialResults("building", 0)).toBe(true);
    expect(partialResults("ready", 3)).toBe(false);
    expect(partialResults("idle", 0)).toBe(false);
  });
});
