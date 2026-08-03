// The tree's guides and icons.
//
// A wrong guide does not throw — it draws a pipe under the last child of a
// folder, and the tree stops reading as a tree. That is exactly the kind of bug
// that survives a screenshot review, so it is pinned here instead.
import { describe, expect, test } from "bun:test";
import { FILE, FOLDER, FOLDER_OPEN, guides, iconFor, isNoise } from "../src/lib/fileIcons.ts";

describe("guides", () => {
  test("a root-level entry has no stem", () => {
    expect(guides([false])).toBe("├─ ");
    expect(guides([true])).toBe("└─ ");
  });

  test("an ancestor with siblings below it keeps its pipe", () => {
    // parent is NOT the last child → the column under it continues.
    expect(guides([false, false])).toBe("│  ├─ ");
    expect(guides([false, true])).toBe("│  └─ ");
  });

  test("an ancestor that was the last child leaves blank space", () => {
    // This is the whole point: a pipe here would be a line to nowhere.
    expect(guides([true, false])).toBe("   ├─ ");
    expect(guides([true, true])).toBe("   └─ ");
  });

  test("three deep, mixed", () => {
    expect(guides([false, true, false])).toBe("│     ├─ ");
    expect(guides([true, false, true])).toBe("   │  └─ ");
  });

  test("the root itself has no prefix at all", () => {
    expect(guides([])).toBe("");
  });

  test("every level contributes exactly three columns", () => {
    // Monospaced by construction: the icons after the prefix must line up, and
    // they only do if each level is the same width.
    for (const depth of [1, 2, 3, 4, 5]) {
      const last = Array.from({ length: depth }, (_, i) => i % 2 === 0);
      expect(guides(last)).toHaveLength(depth * 3);
    }
  });
});

describe("iconFor", () => {
  test("a folder answers by state", () => {
    expect(iconFor("src", true, false).glyph).toBe(FOLDER.glyph);
    expect(iconFor("src", true, true).glyph).toBe(FOLDER_OPEN.glyph);
  });

  test("a known extension gets its language's colour", () => {
    expect(iconFor("models.py", false).tint).not.toBe(FILE.tint);
    expect(iconFor("api.ts", false).tint).not.toBe(iconFor("main.rs", false).tint);
  });

  test("the whole name wins over the extension", () => {
    // package.json is not "some JSON" — it is the file you open when the build
    // is wrong, and it should not look like every other .json in the tree.
    expect(iconFor("package.json", false)).not.toEqual(iconFor("tsconfig.json", false));
  });

  test("case does not matter", () => {
    expect(iconFor("README.md", false)).toEqual(iconFor("readme.md", false));
    expect(iconFor("Makefile", false)).toEqual(iconFor("makefile", false));
  });

  test("a dotfile has no extension — its name IS the extension", () => {
    // ".gitignore".split(".")[1] is "gitignore", which is not a file type.
    expect(iconFor(".gitignore", false)).not.toEqual(FILE);
    expect(iconFor(".unknownrc", false)).toEqual(FILE);
  });

  test("anything unrecognised still gets an icon rather than a blank column", () => {
    expect(iconFor("thing.qqq", false)).toEqual(FILE);
    expect(iconFor("noextension", false)).toEqual(FILE);
  });

  test("a generated directory is dimmed, not hidden", () => {
    expect(isNoise("node_modules", true)).toBe(true);
    expect(isNoise("src", true)).toBe(false);
    // A FILE called node_modules is not a dependency tree.
    expect(isNoise("node_modules", false)).toBe(false);
    expect(iconFor("node_modules", true).glyph).toBe(FOLDER.glyph);
    expect(iconFor("node_modules", true).tint).not.toBe(FOLDER.tint);
  });
});
