import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, readPrefs, writePrefs } from "../src/lib/finderMiller.ts";
import { CONTENTS_MIN, closesOnPress, contentsNote, flipMode, grepPath, hasScopeChoice, inScope, modeKey, scopeName, searchPlaceholder, splitMatch } from "../src/lib/finderSearch.ts";

const src = await Bun.file(new URL("../src/components/finder/machine/FinderSearch.tsx", import.meta.url)).text();
const key = (k: string, m: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...m });

describe("a press on the options menu does not close the dialog", () => {
  test("only a press on the backdrop itself closes it", () => {
    const backdrop = new EventTarget(), menuRow = new EventTarget();
    expect(closesOnPress(backdrop, backdrop)).toBe(true);
    // The menu is a Portal, yet React bubbles its press up to the dialog: target is the row, currentTarget the backdrop.
    expect(closesOnPress(menuRow, backdrop)).toBe(false);
  });
  test("the dialog's own handler asks that question", () => {
    const at = src.indexOf('role="dialog"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf(">", src.indexOf("onMouseDown", at) + 120))).toContain("closesOnPress(e.target, e.currentTarget)");
    expect(src).not.toMatch(/onMouseDown=\{onClose\}/);
  });
});

describe("mode keys", () => {
  test("Tab and Shift+Tab flip from the field, Alt+C anywhere; nothing else does", () => {
    expect(modeKey(key("Tab"))).toBe(true);
    expect(modeKey(key("c", { altKey: true }))).toBe(true);
    expect(modeKey(key("C", { altKey: true }))).toBe(true);
    for (const k of ["Enter", "Escape", "ArrowDown", "ArrowUp", "c"]) expect(modeKey(key(k))).toBe(false);
    expect(modeKey(key("c", { ctrlKey: true }))).toBe(false);
    expect(modeKey(key("Tab", { altKey: true }))).toBe(false);
  });
  test("the mode flips and the Finder keeps it with its other settings", () => {
    expect(flipMode("names")).toBe("contents");
    expect(flipMode(flipMode("names"))).toBe("names");
    expect(DEFAULT_PREFS.searchIn).toBe("names");
    expect(readPrefs(writePrefs({ ...DEFAULT_PREFS, searchIn: "contents" })).searchIn).toBe("contents");
    expect(readPrefs(JSON.stringify({ searchIn: "elsewhere" })).searchIn).toBe("names");
  });
  test("the kit's Segmented shows it, and a mode change is not a local copy", () => {
    expect(src).toContain("<Segmented compact");
    expect(src).not.toMatch(/const \[contents, setContents\]/);
  });
});

describe("what the dialog says", () => {
  test("placeholder and scope follow the mode", () => {
    expect(searchPlaceholder("names", "Home")).toBe("Search files and folders…");
    expect(searchPlaceholder("contents", "orbit")).toBe("Search inside files in orbit…");
    expect(scopeName("home", "/h/orbit")).toBe("Home");
    expect(scopeName("here", "/h/orbit/")).toBe("orbit");
    expect(hasScopeChoice("/h", "/h/")).toBe(false);
    expect(hasScopeChoice("/h", "/h/orbit")).toBe(true);
    expect(inScope("/h/orbit/a.ts", "/h/orbit")).toBe(true);
    expect(inScope("/h/orbit2/a.ts", "/h/orbit")).toBe(false);
  });
  test("the server's hit path is already absolute and is not joined to the root a second time", () => {
    expect(grepPath("/h", "/h/orbit/a.ts")).toBe("/h/orbit/a.ts");
    expect(grepPath("/h/", "orbit/a.ts")).toBe("/h/orbit/a.ts");
  });
  test("the match is found again in the trimmed line", () => {
    expect(splitMatch("    const quill = 1;", 10, 5)).toEqual({ before: "const ", match: "quill", after: " = 1;" });
    expect(splitMatch("abc", 0, 0)).toEqual({ before: "abc", match: "", after: "" });
    expect(splitMatch("abc", 9, 2)).toEqual({ before: "abc", match: "", after: "" });
  });
  test("each empty state is a sentence", () => {
    const o = { scope: "Home", pending: false, found: 0 };
    expect(contentsNote({ ...o, q: "" })).toContain("Search inside files in Home");
    expect(contentsNote({ ...o, q: "a" })).toBe(`Type at least ${CONTENTS_MIN} characters to search inside files in Home`);
    expect(contentsNote({ ...o, q: "zz", pending: true })).toBe("Searching…");
    expect(contentsNote({ ...o, q: "zz" })).toBe("No file in Home contains “zz”");
    expect(contentsNote({ ...o, q: "zz", error: "outside the places this may search" })).toContain("Could not search inside files in Home\noutside");
    expect(contentsNote({ ...o, q: "zz", found: 3, error: "x" })).toBe("");
  });
});
