/*
 * The decisions behind the Machine tab's columns, pulled out of the screen.
 *
 * There is no renderer in this project, so everything a column decides — which
 * rows exist, in what order, which of them is on screen, where an arrow key
 * lands — is a function here and is asserted here. The screen only draws it.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PREFS, completePath, crumbs, filterRows, groupRows, itemsLabel, keyStep, readPrefs, sortRows,
  typeGroup, visibleWindow, writePrefs, type Row,
} from "../src/lib/finderMiller.ts";

const row = (name: string, kind: Row["kind"] = "file", bytes: number | null = 1, mtime = 0, items: number | null = null, hidden = name.startsWith(".")): Row =>
  ({ name, kind, bytes, mtime, items, hidden });

describe("order", () => {
  const rows = [row("b.txt", "file", 5, 30), row("zeta", "dir", null, 10, 3), row("a.md", "file", 50, 20), row("Alpha", "dir", null, 40, 0)];
  test("name: folders first, then files, each case-insensitive and numeric-aware", () => {
    expect(sortRows(rows, "name", "asc").map((r) => r.name)).toEqual(["Alpha", "zeta", "a.md", "b.txt"]);
    const n = [row("img10.png"), row("img2.png"), row("img1.png")];
    expect(sortRows(n, "name", "asc").map((r) => r.name)).toEqual(["img1.png", "img2.png", "img10.png"]);
  });
  test("descending flips each group and still keeps folders first", () => {
    expect(sortRows(rows, "name", "desc").map((r) => r.name)).toEqual(["zeta", "Alpha", "b.txt", "a.md"]);
  });
  test("size and date sort the files; a folder has no size and falls back to its name", () => {
    expect(sortRows(rows, "size", "desc").map((r) => r.name)).toEqual(["Alpha", "zeta", "a.md", "b.txt"]);
    expect(sortRows(rows, "modified", "desc").map((r) => r.name)).toEqual(["Alpha", "zeta", "b.txt", "a.md"]);
  });
  test("it never mutates its input", () => {
    const copy = [...rows];
    sortRows(rows, "size", "asc");
    expect(rows).toEqual(copy);
  });
});

describe("what is shown", () => {
  const rows = [row(".env"), row("a.md"), row("src", "dir"), row("Notes.TXT")];
  test("dotted rows stay out unless asked for", () => {
    expect(filterRows(rows, "", false).map((r) => r.name)).toEqual(["a.md", "src", "Notes.TXT"]);
    expect(filterRows(rows, "", true).length).toBe(4);
  });
  test("the column filter is a case-insensitive substring of the name", () => {
    expect(filterRows(rows, "NOTE", false).map((r) => r.name)).toEqual(["Notes.TXT"]);
  });
  test("a filter that names a dotted row finds it only when hidden ones are shown", () => {
    expect(filterRows(rows, "env", false)).toEqual([]);
    expect(filterRows(rows, "env", true).map((r) => r.name)).toEqual([".env"]);
  });
});

describe("group by type", () => {
  test("folders, then the kinds in a fixed order, with a header row before each group", () => {
    const g = groupRows([row("a.py"), row("src", "dir"), row("p.png"), row("n.md"), row("blob")]);
    expect(g.map((x) => (x.header ? `# ${x.header}` : x.row!.name))).toEqual([
      "# Folders", "src", "# Documents", "n.md", "# Code", "a.py", "# Images", "p.png", "# Other", "blob",
    ]);
  });
  test("an empty group draws no header", () => {
    expect(groupRows([row("a.py")]).map((x) => x.header ?? x.row!.name)).toEqual(["Code", "a.py"]);
  });
  test("typeGroup agrees with the palette's own idea of a code file", () => {
    expect(typeGroup(row("x.tsx"))).toBe("Code");
    expect(typeGroup(row("x.json"))).toBe("Data");
    expect(typeGroup(row("x.mp3"))).toBe("Media");
    expect(typeGroup(row("x.zip"))).toBe("Archives");
  });
});

describe("the window of a virtual list", () => {
  test("100,000 rows with a 400px viewport put a handful of rows in the DOM", () => {
    const w = visibleWindow({ count: 100000, top: 0, height: 400, rowH: 28, overscan: 4 });
    expect(w.start).toBe(0);
    expect(w.end - w.start).toBeLessThan(25);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((100000 - w.end) * 28);
  });
  test("scrolled to the middle the padding above and below add up to the rows not drawn", () => {
    const w = visibleWindow({ count: 100000, top: 28 * 50000, height: 400, rowH: 28, overscan: 4 });
    expect(w.start).toBe(50000 - 4);
    expect(w.padTop + w.padBottom + (w.end - w.start) * 28).toBe(100000 * 28);
  });
  test("past the end it clamps, and an empty list is an empty window", () => {
    const w = visibleWindow({ count: 10, top: 99999, height: 400, rowH: 28, overscan: 2 });
    expect(w.end).toBe(10);
    expect(w.start).toBeLessThanOrEqual(10);
    expect(visibleWindow({ count: 0, top: 0, height: 400, rowH: 28, overscan: 4 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });
});

describe("the arrows", () => {
  const cols = [{ rows: 5, sel: 2, dirs: [1, 2] }, { rows: 3, sel: null, dirs: [] }];
  test("down and up move inside the focused column and stop at the ends", () => {
    expect(keyStep({ col: 0, row: 2 }, "ArrowDown", cols)).toEqual({ col: 0, row: 3 });
    expect(keyStep({ col: 0, row: 4 }, "ArrowDown", cols)).toEqual({ col: 0, row: 4 });
    expect(keyStep({ col: 0, row: 0 }, "ArrowUp", cols)).toEqual({ col: 0, row: 0 });
  });
  test("right enters the next column only when the selected row is a folder that has one", () => {
    expect(keyStep({ col: 0, row: 2 }, "ArrowRight", cols)).toEqual({ col: 1, row: 0 });
    expect(keyStep({ col: 0, row: 3 }, "ArrowRight", cols)).toEqual({ col: 0, row: 3 });
  });
  test("left goes back a column onto the row it came from, and stops at the first", () => {
    expect(keyStep({ col: 1, row: 1 }, "ArrowLeft", cols)).toEqual({ col: 0, row: 2 });
    expect(keyStep({ col: 0, row: 1 }, "ArrowLeft", cols)).toEqual({ col: 0, row: 1 });
  });
  test("Home and End jump to the ends of the column", () => {
    expect(keyStep({ col: 0, row: 2 }, "Home", cols)).toEqual({ col: 0, row: 0 });
    expect(keyStep({ col: 0, row: 2 }, "End", cols)).toEqual({ col: 0, row: 4 });
  });
  test("an empty column keeps the cursor where it is", () => {
    expect(keyStep({ col: 0, row: 0 }, "ArrowDown", [{ rows: 0, sel: null, dirs: [] }])).toEqual({ col: 0, row: 0 });
  });
});

describe("the path bar", () => {
  test("home is drawn as ~ and every crumb knows the path it goes to", () => {
    expect(crumbs("/home/ann/Documents/orbit", "/home/ann")).toEqual([
      { label: "~", path: "/home/ann" }, { label: "Documents", path: "/home/ann/Documents" }, { label: "orbit", path: "/home/ann/Documents/orbit" },
    ]);
  });
  test("outside home the first crumb is the root", () => {
    expect(crumbs("/mnt/disk/x", "/home/ann")).toEqual([{ label: "/", path: "/" }, { label: "mnt", path: "/mnt" }, { label: "disk", path: "/mnt/disk" }, { label: "x", path: "/mnt/disk/x" }]);
  });
  test("the root alone is one crumb, and a path that only looks like home is not home", () => {
    expect(crumbs("/", "/home/ann")).toEqual([{ label: "/", path: "/" }]);
    expect(crumbs("/home/annabel/x", "/home/ann")[0]).toEqual({ label: "/", path: "/" });
  });
});

describe("completing a typed path", () => {
  const dirs = ["Documents", "Downloads", "Desktop", "docs-old"];
  test("the part after the last slash narrows the folders offered, case-insensitively", () => {
    expect(completePath("~/Do", "/home/ann", dirs)).toEqual({ dir: "/home/ann", picks: ["Documents", "Downloads", "docs-old"] });
  });
  test("a trailing slash means the folder is committed and everything in it is offered", () => {
    expect(completePath("/home/ann/", "/home/ann", dirs).picks).toEqual(dirs);
  });
  test("a single unambiguous match is what Tab fills in", () => {
    const r = completePath("~/Des", "/home/ann", dirs);
    expect(r.picks).toEqual(["Desktop"]);
  });
  test("a relative spelling is not guessed at: it has no directory", () => {
    expect(completePath("Doc", "/home/ann", dirs).dir).toBeNull();
  });
});

describe("labels", () => {
  test("a folder says how many items, and a capped count says so", () => {
    expect(itemsLabel(0)).toBe("No items");
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(9999)).toBe("9999+ items");
    expect(itemsLabel(null)).toBe("");
  });
});

describe("remembered preferences", () => {
  test("nothing stored is the defaults, and junk is the defaults", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs("{not json")).toEqual(DEFAULT_PREFS);
  });
  test("a stored value is read back, and a field of the wrong type falls back on its own", () => {
    const p = readPrefs(JSON.stringify({ view: "list", textSize: 15, density: 3, hidden: "yes", sidebar: false }));
    expect(p.view).toBe("list");
    expect(p.textSize).toBe(15);
    expect(p.density).toBe(DEFAULT_PREFS.density);
    expect(p.hidden).toBe(DEFAULT_PREFS.hidden);
    expect(p.sidebar).toBe(false);
  });
  test("the text size is held to the range the layout was drawn for", () => {
    expect(readPrefs(JSON.stringify({ textSize: 99 })).textSize).toBe(18);
    expect(readPrefs(JSON.stringify({ textSize: 1 })).textSize).toBe(11);
  });
  test("what is written is what is read", () => {
    const p = { ...DEFAULT_PREFS, view: "icons" as const, group: true, hidden: true };
    expect(readPrefs(writePrefs(p))).toEqual(p);
  });
});

import { canEdit, displayRows, gridStep, indexOfName, joinPath, parentOf, rowHeight } from "../src/lib/finderMiller.ts";

describe("what a column draws", () => {
  const all = [row(".git", "dir"), row("b.py"), row("src", "dir"), row("a.md"), row("img.png")];
  const base = { needle: "", hidden: false, group: false, sortKey: "name" as const, sortDir: "asc" as const };
  test("rows and items agree, and every row knows where it sits among the items", () => {
    const d = displayRows(all, { ...base, group: true });
    expect(d.items.length).toBeGreaterThan(d.rows.length);
    d.rows.forEach((r, i) => expect(d.items[d.itemOfRow[i]!]!.row).toBe(r));
  });
  test("the keyboard walks rows in the order they are drawn, group by group", () => {
    expect(displayRows(all, { ...base, group: true }).rows.map((r) => r.name)).toEqual(["src", "a.md", "b.py", "img.png"]);
    expect(displayRows(all, base).rows.map((r) => r.name)).toEqual(["src", "a.md", "b.py", "img.png"]);
  });
  test("hidden and needle apply before grouping", () => {
    expect(displayRows(all, { ...base, hidden: true }).rows.map((r) => r.name)[0]).toBe(".git");
    expect(displayRows(all, { ...base, needle: "py" }).rows.map((r) => r.name)).toEqual(["b.py"]);
  });
});

describe("tiles", () => {
  test("left and right step by one, up and down by a row, and all stop at the ends", () => {
    expect(gridStep(5, 20, 4, "ArrowRight")).toBe(6);
    expect(gridStep(5, 20, 4, "ArrowDown")).toBe(9);
    expect(gridStep(5, 20, 4, "ArrowUp")).toBe(1);
    expect(gridStep(1, 20, 4, "ArrowUp")).toBe(0);
    expect(gridStep(18, 20, 4, "ArrowDown")).toBe(19);
    expect(gridStep(0, 0, 4, "ArrowDown")).toBe(0);
  });
});

describe("paths and sizes", () => {
  test("parent and join are inverses, and the root is its own end", () => {
    expect(parentOf("/home/ann/x")).toBe("/home/ann");
    expect(parentOf("/home")).toBe("/");
    expect(parentOf("/")).toBeNull();
    expect(parentOf("docs")).toBeNull();
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/ann/", "x")).toBe("/home/ann/x");
  });
  test("a name with a space or an accent is just a name", () => {
    expect(joinPath("/home/ann", "Año nuevo.txt")).toBe("/home/ann/Año nuevo.txt");
    expect(indexOfName([row("Año nuevo.txt")], "Año nuevo.txt")).toBe(0);
    expect(indexOfName([], null)).toBe(-1);
  });
  test("airy rows are taller than compact ones at every text size", () => {
    for (const s of [11, 13, 18]) expect(rowHeight("airy", s)).toBeGreaterThan(rowHeight("compact", s));
    expect(rowHeight("compact", 13)).toBe(28);
  });
});

describe("what the editor is offered for", () => {
  test("text and source are editable; pictures, archives, media and binaries are not", () => {
    for (const n of ["a.md", "x.py", "Makefile", "notes", ".env", "logo.svg", "a.JSON"]) expect(canEdit(n)).toBe(true);
    for (const n of ["a.png", "b.PDF", "c.zip", "d.mp3", "e.sqlite", "f.woff2"]) expect(canEdit(n)).toBe(false);
  });
});

import { canEditRow } from "../src/lib/finderMiller.ts";
describe("the bench never follows a link", () => {
  test("a link, a locked row and a binary are not offered; a plain text file is", () => {
    expect(canEditRow(row("a.md"))).toBe(true);
    expect(canEditRow(row("to-etc", "link"))).toBe(false);
    expect(canEditRow({ ...row("a.md"), locked: true })).toBe(false);
    expect(canEditRow(row("a.zip"))).toBe(false);
  });
});
