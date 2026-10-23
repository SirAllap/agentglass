import { describe, expect, test } from "bun:test";

// Two controls for one job are one control too many. Strata keeps one of each; so does the finder.
const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const machine = await read("MachineFinder.tsx");
const column = await read("Column.tsx");

describe("the header", () => {
  const header = code(machine.slice(machine.indexOf("Toggle sidebar (Ctrl+B)") - 400, machine.indexOf("onClick={onClose}")+40));
  test("holds Strata's controls and no second search, no copy-path button", () => {
    for (const label of ["Toggle sidebar", "Search (Ctrl+K)", "Appearance", "Settings", "Close the finder"]) expect(header).toContain(label);
    expect(header).not.toContain("Copy path");
    expect(header).not.toContain("Search Home");
    expect((header.match(/name="search"/g) ?? []).length).toBe(1);
  });
  test("back, forward and parent are in the header only in Icons and List, as in Strata", () => {
    const at = header.indexOf('prefs.view !== "columns"');
    expect(at).toBeGreaterThan(0);
    for (const label of ['aria-label="Back"', 'aria-label="Forward"', 'aria-label="Parent folder"']) expect(header.indexOf(label)).toBeGreaterThan(at);
  });
});

describe("the column header", () => {
  const header = code(column.slice(column.indexOf("<header"), column.indexOf("</header>")));
  test("is the title and Strata's four buttons: refresh, direction, sort options, filter, and a close button past the first pane", () => {
    expect((header.match(/<button /g) ?? []).length).toBe(5);
    for (const label of ["Refresh", "Ascending — click to reverse", "Sort options", "Filter this pane"]) expect(header).toContain(label);
  });
  test("has no count badge and no options menu", () => {
    expect(header).not.toContain("toLocaleString");
    expect(column).not.toContain("Column options");
  });
});
