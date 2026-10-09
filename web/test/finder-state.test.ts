/*
 * Reopening the finder puts everything back: the tab, its query, the result you
 * were on, the file open and how far down it, the drawer's width. What is tested
 * is the part that can be wrong without a screen — what a stored value means —
 * including a value from an older or hand-edited store, which must degrade to
 * defaults and never to a state the finder cannot draw.
 */
import { describe, expect, test } from "bun:test";
import {
  DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN, clampDrawer, emptySnapshot, indexOfSel, rememberedSel, restore, resumeLine, scrollFor, tabViewOf, withTabView,
} from "../src/lib/finderState.ts";

describe("a snapshot survives a round trip through storage", () => {
  test("every part comes back", () => {
    let s = emptySnapshot();
    s = withTabView(s, "machine", { q: "~/shots/*.png", browsePath: "/home/u/shots", sel: "/home/u/shots/02-list.png", exts: ["png"] });
    s = { ...s, drawerW: 340, collapsed: true, scroll: { path: "/home/u/shots/02-list.png", top: 412 } };
    expect(restore(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  test("each tab keeps its own query, selection and chips", () => {
    let s = emptySnapshot();
    s = withTabView(s, "names", { q: "retry", browsePath: null, sel: "/r/retry.py", exts: [] });
    s = withTabView(s, "contents", { q: "backoff", browsePath: null, sel: null, exts: ["md"] });
    expect(tabViewOf(s, "names").q).toBe("retry");
    expect(tabViewOf(s, "names").sel).toBe("/r/retry.py");
    expect(tabViewOf(s, "contents").exts).toEqual(["md"]);
    expect(tabViewOf(s, "recent")).toEqual({ q: "", browsePath: null, sel: null, exts: [] });
    expect(s.tab).toBe("contents");
  });
});

describe("what a bad store means", () => {
  test("nothing, junk or another version is a fresh finder", () => {
    for (const raw of [null, undefined, 3, "x", [], { v: 2 }, {}]) expect(restore(raw)).toEqual(emptySnapshot());
  });
  test("a wrong field falls back alone, the rest is kept", () => {
    const r = restore({ v: 1, tab: "bogus", drawerW: "wide", collapsed: "yes", tabs: { names: { q: 5, sel: "/a", exts: ["png", 3] }, junk: {} }, scroll: { path: "/a", top: -4 } });
    expect(r.tab).toBe("names");
    expect(r.drawerW).toBe(DRAWER_DEFAULT);
    expect(r.collapsed).toBe(false);
    expect(r.tabs.names).toEqual({ q: "", browsePath: null, sel: "/a", exts: ["png"] });
    expect(r.scroll).toBeNull();
  });
});

describe("the drawer", () => {
  test("its width is held between the minimum and the maximum", () => {
    expect(clampDrawer(50)).toBe(DRAWER_MIN);
    expect(clampDrawer(4000)).toBe(DRAWER_MAX);
    expect(clampDrawer(333.4)).toBe(333);
    expect(clampDrawer(NaN)).toBe(DRAWER_DEFAULT);
    expect(restore({ v: 1, drawerW: 9999 }).drawerW).toBe(DRAWER_MAX);
  });
});

describe("scroll and selection are only restored where they mean something", () => {
  const s = { ...emptySnapshot(), scroll: { path: "/a/x.py", top: 300 } };
  test("scroll is for the file it was recorded on", () => {
    expect(scrollFor(s, "/a/x.py")).toBe(300);
    expect(scrollFor(s, "/a/y.py")).toBe(0);
    expect(scrollFor(s, null)).toBe(0);
  });
  test("the saved selection is found by path, and a vanished file is -1", () => {
    expect(indexOfSel(["/a", "/b", null], "/b")).toBe(1);
    expect(indexOfSel(["/a"], "/gone")).toBe(-1);
    expect(indexOfSel(["/a"], null)).toBe(-1);
  });
});

describe("the footer says what reopening will restore", () => {
  test("file, section, tab and query, in that order", () => {
    expect(resumeLine({ file: "retry-policy.md", section: "Backoff schedule", tab: "Name", q: " retry " }))
      .toBe("reopens exactly here: retry-policy.md \u00b7 \u00a7 Backoff schedule \u00b7 Name \u00b7 \u201cretry\u201d");
  });
  test("what is empty is left out", () => {
    expect(resumeLine({ file: null, section: null, tab: "Recent", q: "" })).toBe("reopens exactly here: Recent");
  });
});

describe("closing the finder does not forget the selection", () => {
  const file = "~/code/orbit/prompts/greeting.jinja2";
  test("while open, the live selection is what is remembered", () => {
    expect(rememberedSel(null, true, file)).toBe(file);
    expect(rememberedSel("~/code/orbit/old.md", true, file)).toBe(file);
  });
  test("closed, the list is emptied and has no selection: the last one stays", () => {
    expect(rememberedSel(file, false, null)).toBe(file);
    expect(rememberedSel(file, false, "~/code/orbit/first-dir")).toBe(file);
  });
  test("open but the list is still loading: the last one stays", () => {
    expect(rememberedSel(file, true, null)).toBe(file);
  });
});
