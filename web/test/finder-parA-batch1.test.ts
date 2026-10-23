/*
 * Parity rows 81 (the filter box counts what it filters), 106 (Type is a sort
 * heading like the others) and 109 (the List's Modified column is worded as
 * the rest of the finder words dates). Rules about source are asserted
 * against source: there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import { filterPlaceholder } from "../src/lib/finderMiller.ts";

const column = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
const views = await Bun.file(new URL("../src/components/finder/machine/FolderViews.tsx", import.meta.url)).text();

describe("row 81: the filter placeholder counts the folder", () => {
  test("Strata's wording, singular and plural", () => {
    expect(filterPlaceholder(1)).toBe("Filter 1 item…");
    expect(filterPlaceholder(12)).toBe("Filter 12 items…");
    expect(filterPlaceholder(0)).toBe("Filter 0 items…");
  });
  test("the column uses it, counted on the whole folder so it does not change while typing", () => {
    expect(column).toContain("filterPlaceholder(state?.total ?? display.rows.length)");
    expect(column).not.toContain("Filter this column…");
  });
});

describe("row 106 and 109: the List's headings", () => {
  test("Type sorts like Name, Size and Modified", () => {
    expect(views).toContain('head("type", "Type")');
    expect(views).not.toMatch(/<span[^>]*>Type<\/span>/);
  });
  test("Modified is drawn with strataWhen, not the short ago()", () => {
    expect(views).toContain("strataWhen(r.mtime)");
    expect(views).not.toContain("{ago(r.mtime)}");
  });
});
