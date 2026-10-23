import { describe, expect, test } from "bun:test";
import { closeTab, openTab, selectTab, showHere, stepTab, tabLabel, tabsOf } from "../src/lib/finderTabs.ts";

describe("folder tabs", () => {
  test("a new tab opens beside the active one and takes over", () => {
    const t = openTab(openTab(tabsOf("/h/a"), "/h/b"), "/h/c");
    expect(t).toEqual({ paths: ["/h/a", "/h/b", "/h/c"], active: 2 });
    expect(openTab(selectTab(t, 0), "/h/x")).toEqual({ paths: ["/h/a", "/h/x", "/h/b", "/h/c"], active: 1 });
  });
  test("closing keeps the active tab pointing at the same folder, and the last tab stays", () => {
    const t = { paths: ["/a", "/b", "/c"], active: 1 };
    expect(closeTab(t, 0)).toEqual({ paths: ["/b", "/c"], active: 0 });
    expect(closeTab(t, 1)).toEqual({ paths: ["/a", "/c"], active: 1 });
    expect(closeTab({ paths: ["/a", "/b"], active: 1 }, 1)).toEqual({ paths: ["/a"], active: 0 });
    expect(closeTab(tabsOf("/a"), 0)).toEqual(tabsOf("/a"));
  });
  test("Ctrl+Tab wraps both ways", () => {
    const t = { paths: ["/a", "/b", "/c"], active: 2 };
    expect(stepTab(t, 1).active).toBe(0);
    expect(stepTab({ ...t, active: 0 }, -1).active).toBe(2);
  });
  test("the active tab follows the finder and the others stay", () => {
    expect(showHere({ paths: ["/a", "/b"], active: 1 }, "/z")).toEqual({ paths: ["/a", "/z"], active: 1 });
  });
  test("a tab is named for its folder", () => {
    expect(tabLabel("/h", "/h")).toBe("~");
    expect(tabLabel("/h/orbit/src", "/h")).toBe("src");
    expect(tabLabel("/", "/h")).toBe("/");
  });
  test("a click on a tab that is not there changes nothing", () => {
    const t = tabsOf("/a");
    expect(selectTab(t, 3)).toBe(t);
  });
});
