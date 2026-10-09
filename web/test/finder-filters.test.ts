/*
 * Narrowing a listing: a glob typed into the box, and the chips of kinds that
 * are there. The fixture is the shape of a real evidence folder — a few
 * screenshots, their pages, a note — because the reported failure was a glob
 * on exactly that, answering "Nothing in here matches".
 */
import { describe, expect, test } from "bun:test";
import { chipLabel, extChips, extOf, globToRegExp, hasGlob, matchGlob, passesExts, toggleExt } from "../src/lib/finderFilters.ts";
import { readPath } from "../src/lib/finderQuery.ts";

const FOLDER = ["01-home.png", "02-list.png", "03-detail.PNG", "mock-a.html", "mock-b.html", "notes.md", "Makefile", ".env"];

describe("what counts as a glob", () => {
  test("stars, questions, alternations and classes", () => {
    for (const g of ["*.png", "shot-?.png", "*.{png,html}", "img[0-9].png"]) expect(hasGlob(g)).toBe(true);
  });
  test("a name that only contains a bracket or a lone brace is a name", () => {
    for (const n of ["notes", "a.b.c", "{oops}", "[]", "retry-policy.md"]) expect(hasGlob(n)).toBe(false);
  });
});

describe("matching a glob", () => {
  test("*.png keeps the pngs, in either case, and nothing else", () => {
    expect(FOLDER.filter((n) => matchGlob("*.png", n))).toEqual(["01-home.png", "02-list.png", "03-detail.PNG"]);
  });
  test("an alternation is one pattern for several kinds", () => {
    expect(FOLDER.filter((n) => matchGlob("*.{png,html}", n))).toHaveLength(5);
  });
  test("? is one character, and a class is one of a set", () => {
    expect(matchGlob("mock-?.html", "mock-a.html")).toBe(true);
    expect(matchGlob("mock-?.html", "mock-ab.html")).toBe(false);
    expect(matchGlob("0[12]-*", "02-list.png")).toBe(true);
    expect(matchGlob("0[12]-*", "03-detail.PNG")).toBe(false);
    expect(matchGlob("0[!12]-*", "03-detail.PNG")).toBe(true);
  });
  test("a dot is a dot, not any character", () => {
    expect(matchGlob("*.md", "notesXmd")).toBe(false);
  });
  test("a pattern without a slash is about the name, wherever the row's path puts it", () => {
    expect(matchGlob("*.png", "docs/shots/01-home.png")).toBe(true);
  });
  test("with a slash it is about the path, and * does not cross a folder", () => {
    expect(matchGlob("docs/*.png", "docs/a.png")).toBe(true);
    expect(matchGlob("docs/*.png", "docs/shots/a.png")).toBe(false);
    expect(matchGlob("docs/**/*.png", "docs/shots/a.png")).toBe(true);
  });
  test("regex metacharacters in a name are literal", () => {
    expect(matchGlob("a+b(1).*", "a+b(1).txt")).toBe(true);
    expect(matchGlob("a+b(1).*", "aab1.txt")).toBe(false);
    expect(globToRegExp("[")).not.toBeNull();
  });
});

describe("the reported case, end to end through the path reader", () => {
  test("a typed path with a glob tail lists the folder and filters by the tail", () => {
    const p = readPath("~/Documents/projects/orbit/shots/*.png", "/home/u", "/home/u");
    expect(p).toEqual({ dir: "/home/u/Documents/projects/orbit/shots", tail: "*.png", atFolder: false });
    expect(hasGlob(p!.tail)).toBe(true);
    expect(FOLDER.filter((n) => matchGlob(p!.tail, n))).toHaveLength(3);
  });
});

describe("kind chips", () => {
  test("extensions, lowercase, with dotfiles and bare names as 'none'", () => {
    expect(extOf("A.PNG")).toBe("png");
    expect(extOf("docs/x.tar.gz")).toBe("gz");
    expect(extOf(".env")).toBe("");
    expect(extOf("Makefile")).toBe("");
  });
  test("counted, most common first, ties alphabetical", () => {
    expect(extChips(FOLDER)).toEqual([
      { ext: "png", count: 3 }, { ext: "html", count: 2 }, { ext: "", count: 2 }, { ext: "md", count: 1 },
    ]);
    expect(extChips(FOLDER).map(chipLabel)).toEqual(["png", "html", "none", "md"]);
  });
  test("nothing listed, no chips", () => { expect(extChips([])).toEqual([]); });
  test("clicking toggles, several are an OR, none is no filter", () => {
    let sel: string[] = [];
    sel = toggleExt(sel, "png");
    expect(FOLDER.filter((n) => passesExts(n, sel))).toHaveLength(3);
    sel = toggleExt(sel, "md");
    expect(FOLDER.filter((n) => passesExts(n, sel))).toHaveLength(4);
    sel = toggleExt(toggleExt(sel, "png"), "md");
    expect(sel).toEqual([]);
    expect(FOLDER.filter((n) => passesExts(n, sel))).toHaveLength(FOLDER.length);
  });
});
