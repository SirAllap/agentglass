/*
 * Parity rows 70 and 72 (a column's header), 86 and 111 (row heights), 89 (the
 * badge on hover), 95 (a cut row), 119 and 123 (the Icons cards), 229 and 230
 * (the words). Rules about source are asserted against source: there is no
 * renderer here.
 */
import { describe, expect, test } from "bun:test";
import { middleSplit, rowHeight } from "../src/lib/finderMiller.ts";
import { failedNote } from "../src/lib/finderOps.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const column = await read("components/finder/machine/Column.tsx");
const views = await read("components/finder/machine/FolderViews.tsx");
const machine = await read("components/finder/machine/MachineFinder.tsx");
const css = await read("index.css");

describe("rows 70 and 72: a column's header", () => {
  test("31 px tall, bold, padded 5 5 4 12 under the 3 px bar", () => {
    expect(column).toContain('minHeight: 31, padding: "5px 5px 4px 12px"');
    expect(column).toMatch(/title=\{folderPath\} aria-label=\{title\}[^>]*fontWeight: 700/);
  });
  test("a long title gives way in the middle and keeps its last characters", () => {
    expect(middleSplit("report")).toEqual(["report", ""]);
    const [head, tail] = middleSplit("quarterly-planning-notes-final");
    expect(head + tail).toBe("quarterly-planning-notes-final");
    expect(tail.length).toBe(8);
  });
});

describe("rows 86 and 111: row heights", () => {
  test("26 compact and 42 airy at the default text size, growing with it", () => {
    expect(rowHeight("compact", 13)).toBe(26);
    expect(rowHeight("airy", 13)).toBe(42);
    expect(rowHeight("compact", 18)).toBeGreaterThan(rowHeight("compact", 13));
  });
});

describe("row 89: the badge", () => {
  test("it is always in the row and the pointer or the choice brings it", () => {
    expect(column).toContain('className="agx-fm-badge');
    expect(css).toContain(".agx-fm-row:hover .agx-fm-badge { opacity: 1; }");
    expect(css).toContain(".agx-fm-badge { opacity: 0; }");
  });
});

describe("row 95: a cut row", () => {
  test("a Cut fades its rows to 0.65 in the three views, only in the folder it was cut from", () => {
    expect(column).toContain("export const CUT_OPACITY = 0.65;");
    for (const t of [column, views]) expect(t).toContain("cut?.has(r.name) ? CUT_OPACITY");
    expect(machine).toContain('ops.clip?.mode === "cut" && ops.clip.dir === path');
  });
});

describe("rows 119 and 123: the Icons cards", () => {
  test("airy pads the grid 5, the card 5 7 and the tile 3 apart", () => {
    expect(views).toContain('padding: airy ? "0 5px" : "0 8px"');
    expect(views).toContain('padding: "5px 7px", margin: 3');
    expect(machine).toContain("density={prefs.density}");
  });
  test("a 14 px details line under the name: the items of a folder, the size of a file", () => {
    expect(views).toContain("data-details");
    expect(views).toContain("height: CARD.details");
    expect(views).toContain("lineHeight: `${CARD.details}px`");
  });
});

describe("row 230: failures worded as Strata words them", () => {
  test("the heading of the operation, then the server's reason", () => {
    expect(failedNote("rename", "exists")).toBe("Unable to rename item: exists");
    expect(failedNote("trash", undefined)).toBe("Unable to move to Trash");
    expect(failedNote("restore", undefined)).toBe("Unable to restore");
    expect(failedNote("empty-trash", undefined)).toBe("Unable to empty Trash");
    expect(failedNote("copy", "disk full")).toBe("Unable to complete operation: disk full");
  });
  test("an unreadable folder and a stopped job", () => {
    expect(column).toContain("Unable to open directory");
  });
});
