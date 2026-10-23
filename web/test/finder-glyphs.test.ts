import { describe, expect, test } from "bun:test";
import { glyphFor } from "../src/lib/finderGlyphs.ts";
import { footerCount, formatSize, nextSidebar, readPrefs, sidebarMode, sidebarPrefs, sidebarTip } from "../src/lib/finderMiller.ts";

describe("file glyphs by name", () => {
  test("json is braces in amber, readme and markdown teal, code angle brackets", () => {
    expect(glyphFor("manifest.json", false)).toEqual({ glyph: "braces", tone: "amber" });
    expect(glyphFor("README.md", false)).toEqual({ glyph: "readme", tone: "teal" });
    expect(glyphFor("readme", false)).toEqual({ glyph: "readme", tone: "teal" });
    expect(glyphFor("notes.md", false)).toEqual({ glyph: "markdown", tone: "teal" });
    expect(glyphFor("check_tokens.py", false)).toEqual({ glyph: "code", tone: "green" });
  });
  test("pictures, media and archives each have their own", () => {
    expect(glyphFor("shot.PNG", false).glyph).toBe("image");
    expect(glyphFor("clip.mp4", false).glyph).toBe("video");
    expect(glyphFor("tone.mp3", false).glyph).toBe("audio");
    expect(glyphFor("bundle.tar.gz", false).glyph).toBe("archive");
  });
  test("a folder is plain whatever it is called, and an unknown file is plain text", () => {
    expect(glyphFor("data.json", true)).toEqual({ glyph: "folder", tone: "plain" });
    expect(glyphFor("LICENSE", false).glyph).toBe("text");
    expect(glyphFor("Makefile", false).glyph).toBe("code");
    expect(glyphFor(".gitignore", false).glyph).toBe("text");
  });
});

describe("the sidebar's three states", () => {
  test("one toggle steps full, rail, hidden, full", () => {
    expect(nextSidebar("full")).toBe("rail");
    expect(nextSidebar("rail")).toBe("hidden");
    expect(nextSidebar("hidden")).toBe("full");
  });
  test("a mode and the two flags it is stored as agree both ways", () => {
    for (const m of ["full", "rail", "hidden"] as const) expect(sidebarMode(sidebarPrefs(m))).toBe(m);
    expect(readPrefs(JSON.stringify({ sidebar: true, rail: true })).rail).toBe(true);
    expect(readPrefs(JSON.stringify({ sidebar: true })).rail).toBe(false);
  });
  test("the tooltip names the next step", () => {
    expect(sidebarTip("full", "Ctrl+B")).toBe("Compact sidebar (Ctrl+B)");
    expect(sidebarTip("rail", "Ctrl+B")).toBe("Hide sidebar (Ctrl+B)");
    expect(sidebarTip("hidden", "Ctrl+B")).toBe("Show sidebar (Ctrl+B)");
  });
});

describe("the footer's count", () => {
  test("nothing selected: the column's items", () => {
    expect(footerCount(0, null)).toBe("0 items");
    expect(footerCount(1, null)).toBe("1 item");
    expect(footerCount(100000, null)).toBe("100000 items");
    expect(footerCount(null, null)).toBe("");
  });
  test("one folder, one file with its size", () => {
    expect(footerCount(9, { kind: "dir", bytes: null, items: 3 })).toBe("1 folder selected");
    expect(footerCount(9, { kind: "file", bytes: 12345, items: null })).toBe("1 file selected (12.3 kB)");
    expect(footerCount(9, { kind: "file", bytes: null, items: null })).toBe("1 file selected (size unavailable)");
  });
  test("sizes are decimal with one digit only when fractional", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1000)).toBe("1 kB");
    expect(formatSize(12345)).toBe("12.3 kB");
    expect(formatSize(4_000_000)).toBe("4 MB");
    expect(formatSize(52_428_843)).toBe("52.4 MB");
    expect(formatSize(999_950)).toBe("1 MB");
  });
});

describe("the List view's Type word", () => {
  test("a folder, an extension said as a word, and a file with none", async () => {
    const { kindWord } = await import("../src/lib/finderMiller.ts");
    expect(kindWord({ name: "src", kind: "dir", items: 3 })).toBe("Folder");
    expect(kindWord({ name: "a.json", kind: "file", items: null })).toBe("JSON file");
    expect(kindWord({ name: "LICENSE", kind: "file", items: null })).toBe("File");
    expect(kindWord({ name: ".gitignore", kind: "file", items: null })).toBe("File");
    expect(kindWord({ name: "ends.", kind: "file", items: null })).toBe("File");
  });
});
