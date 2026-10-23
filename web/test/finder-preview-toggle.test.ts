/*
 * The preview's own × closes the panel, and a person who pressed it by accident
 * has to be able to open it again without knowing Space does that. A source rule:
 * there is no renderer here, so the header is read as text.
 */
import { describe, expect, test } from "bun:test";
import { reopensPreview } from "../src/lib/finderPreview.ts";

const src = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();

test("the header carries a toggle for the preview panel that says whether it is open", () => {
  const at = src.indexOf('aria-label="Toggle the preview panel (Space)"');
  expect(at).toBeGreaterThan(0);
  const tag = src.slice(src.lastIndexOf("<button", at), src.indexOf("</button>", at));
  expect(tag).toContain("aria-pressed=");
  expect(tag).toContain("prefs.preview");
  expect(tag).toContain("setPeek");
});

test("the open/closed state is one of the stored preferences, so reopening keeps it", () => {
  expect(src).toMatch(/setPrefs\(\{ preview: !prefs\.preview \}\)/);
});

test("Enter and double-click on a file go to the desktop's application; only the preview's button opens the bench", () => {
  const body = (from: string) => { const at = src.indexOf(from); return src.slice(at, src.indexOf("\n", at)); };
  const open = body("open: (dir, row) =>");
  const enter = body('case "enter": {') + body("else if (!deepest.row.locked)");
  expect(open).toContain("openDefault(");
  expect(open).not.toContain("onBench(");
  expect(enter).toContain("openDefault(");
  expect(enter).not.toContain("onBench(");
});

describe("a click reopens a closed preview", () => {
  test("only a plain click on a file while it is closed", () => {
    expect(reopensPreview({ open: false, folder: false, modified: false })).toBe(true);
    expect(reopensPreview({ open: true, folder: false, modified: false })).toBe(false);
    expect(reopensPreview({ open: false, folder: true, modified: false })).toBe(false);
    expect(reopensPreview({ open: false, folder: false, modified: true })).toBe(false);
  });
});

test("the click path asks for the reopen before it picks", () => {
  const at = src.indexOf("const onPickMod = useCallback(");
  const body = src.slice(at, src.indexOf("}, [columns, choose", at));
  expect(body).toContain("reopen.current(row)");
  expect(body.indexOf("reopen.current(row)")).toBeLessThan(body.indexOf("pick(col, row)"));
});
