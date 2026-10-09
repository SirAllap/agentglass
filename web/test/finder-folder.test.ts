/*
 * A folder in the finder's centre pane, and the bench action behind Enter.
 *
 * Two things went wrong on the installed build: a selected folder drew the
 * sentence "A folder — ⏎ to go in" as separate flex children, so a tall pane
 * spread the words down its height; and "To the bench" opened a tab named after
 * the file that was only a shell in the project. Both are decided here, in
 * values, so the pane and the rail cannot drift from the tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BrowseEntry } from "../../shared/types.ts";
import { FOLDER_HINT, PREVIEW_ROWS, benchOpen, folderPreview, goTo, previewChild, primaryAction, shellQuote } from "../src/lib/finderFolder.ts";
import { pathBar } from "../src/lib/paletteModel.ts";

const NOW = Date.UTC(2026, 8, 30, 12);
const day = 86_400_000;
const file = (name: string, bytes = 1200, age = 3): BrowseEntry => ({ name, kind: "file", bytes, items: null, mtime: NOW - age * day, hidden: false });
const dir = (name: string, items = 4): BrowseEntry => ({ name, kind: "dir", bytes: null, items, mtime: NOW - day, hidden: false });

describe("the folder preview", () => {
  test("folders first, icon kind, size or item count, then age", () => {
    const p = folderPreview("reports", [file("a.md", 4200), dir("drafts", 1), file("b.png"), dir("archive", 12)], NOW - 2 * day, 0, NOW);
    expect(p.rows.map((r) => r.name)).toEqual(["drafts", "archive", "a.md", "b.png"]);
    expect(p.rows[0]).toMatchObject({ isDir: true, kind: "dir", meta: "1 item · 1d ago" });
    expect(p.rows[2]).toMatchObject({ isDir: false, kind: "markdown", meta: "4.2 KB · 3d ago" });
    expect(p.count).toBe("4 items");
    expect(p.modified).toBe("2d ago");
    expect(p.hint).toBe("Enter opens it · → goes in");
    expect(FOLDER_HINT).toBe(p.hint);
  });

  test("only the first 30 are listed, and the rest is counted, not dropped", () => {
    const many = Array.from({ length: 45 }, (_, i) => file(`n${String(i).padStart(2, "0")}.ts`));
    const p = folderPreview("src", many, null, 0, NOW);
    expect(p.rows).toHaveLength(PREVIEW_ROWS);
    expect(p.more).toBe(15);
    expect(p.count).toBe("45 items");
    expect(p.modified).toBe("");
  });

  test("the listing's own 'more' is added, so a huge folder never claims fewer items", () => {
    const p = folderPreview("big", [file("a.ts")], null, 500, NOW);
    expect(p.count).toBe("501 items");
    expect(p.more).toBe(500);
  });

  test("type chips count files by extension over the whole folder, folders excluded", () => {
    const p = folderPreview("x", [dir("d"), file("a.ts"), file("b.ts"), file("c.md"), file("Makefile")], null, 0, NOW);
    expect(p.chips).toEqual([{ ext: "ts", count: 2 }, { ext: "md", count: 1 }, { ext: "", count: 1 }]);
  });

  test("an empty folder is empty, with one item less than none", () => {
    const p = folderPreview("nothing", [], null, 0, NOW);
    expect(p.empty).toBe(true);
    expect(p.rows).toEqual([]);
    expect(folderPreview("one", [file("a")], null, 0, NOW).count).toBe("1 item");
  });

  test("a locked entry stays listed and says so", () => {
    const p = folderPreview("home", [{ ...dir(".ssh"), locked: true }], null, 0, NOW);
    expect(p.rows[0]!.locked).toBe(true);
  });
});

describe("the action behind Enter, by kind", () => {
  test("a file with an editor opens in nvim; a folder opens a terminal; a picture has neither", () => {
    for (const k of ["markdown", "code", "html"] as const) expect(primaryAction(k)).toMatchObject({ id: "edit", label: "Edit in nvim" });
    expect(primaryAction("dir")).toMatchObject({ id: "terminal", label: "Terminal here" });
    for (const k of ["image", "pdf", "video", "audio", "binary", null] as const) expect(primaryAction(k)).toBeNull();
  });

  test("a file the viewer refused gets no editor, a folder still gets its terminal", () => {
    for (const k of ["markdown", "code", "html"] as const) expect(primaryAction(k, true)).toBeNull();
    expect(primaryAction("dir", true)).toMatchObject({ id: "terminal" });
  });

  test("nobody says 'To the bench' any more", () => {
    for (const f of ["../src/components/finder/InfoRail.tsx", "../src/components/finder/FileView.tsx", "../src/lib/finderFolder.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
      expect(src.includes("To the bench")).toBe(false);
    }
  });

  test("the folder pane is not the old scattered sentence", () => {
    const src = readFileSync(new URL("../src/components/finder/FileView.tsx", import.meta.url), "utf8");
    expect(src.includes("to go in")).toBe(false);
    expect(src.includes("Empty folder")).toBe(true);
  });
});

describe("what the bench is asked to open", () => {
  test("editing a file outside any project keeps the project as the bench's root and carries the exact path", () => {
    const o = benchOpen("edit", "/home/u/Documents/plans/q3 notes.md", "/home/u/code/orbit");
    expect(o).toEqual({ tab: "file", root: "/home/u/code/orbit", path: "/home/u/Documents/plans/q3 notes.md", title: "q3 notes.md" });
  });

  test("with no project the file's own folder is the root", () => {
    expect(benchOpen("edit", "/home/u/Documents/a.md", "")).toMatchObject({ tab: "file", root: "/home/u/Documents", path: "/home/u/Documents/a.md" });
  });

  test("terminal here types a cd to that folder, quoted as one word, Enter included", () => {
    const o = benchOpen("terminal", "/home/u/Documents/it's mine", "/home/u/code/orbit");
    expect(o).toEqual({ tab: "term", root: "/home/u/code/orbit", title: "it's mine", type: "cd '/home/u/Documents/it'\\''s mine'\r" });
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("a click in the centre goes by the file-manager model", () => {
  test("an entry of a folder's preview lists that folder and selects the entry", () => {
    expect(goTo(previewChild("/home/u/notes", "notes"))).toEqual({ browsePath: "/home/u/notes", name: "notes" });
    expect(goTo(previewChild("/home/u/notes/", "a.md"))).toEqual({ browsePath: "/home/u/notes", name: "a.md" });
  });
  test("a top-level entry lists the root", () => {
    expect(goTo("/etc")).toEqual({ browsePath: "/", name: "etc" });
  });
  test("the header crumbs are the path bar's: Home-based, never the account name", () => {
    const segs = pathBar("/home/ada/notes/orbit", "/home/ada");
    expect(segs.map((s) => s.label)).toEqual(["Home", "notes", "orbit"]);
    expect(segs.at(-1)!.last).toBe(true);
  });
  test("a crumb click selects that crumb inside its parent, agreeing with the bar", () => {
    const segs = pathBar("/home/ada/notes/orbit", "/home/ada");
    expect(goTo(segs[1]!.path)).toEqual({ browsePath: "/home/ada", name: "notes" });
  });
});
