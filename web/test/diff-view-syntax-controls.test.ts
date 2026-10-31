import { expect, test } from "bun:test";

/* The Diff view had no syntax theme picker, gear or bold toggle while the Git
   panel and a commit's diff had all three; only Settings changed the theme. Now
   the view and the commit modal draw ONE toolbar, so neither can drift again.
   Source-level: there is no renderer in this project. */
const read = async (f: string) => Bun.file(new URL(`../src/components/diff/${f}`, import.meta.url)).text();
const toolbar = await read("DiffToolbar.tsx");
const page = await read("DiffPage.tsx");
const modal = await read("PresetDiff.tsx");

test("the shared toolbar carries ignore-space, layout, wrap, bold, theme and the gear", () => {
  for (const needle of ["Ignore space", "Unified", "Wrap", "Bold", "<ThemePicker", "<DiffSettingsLink />"]) expect(toolbar).toContain(needle);
});

test("the view and the modal both draw it, and neither keeps a row of its own", () => {
  expect(page.slice(page.indexOf("function Body("))).toContain("<DiffToolbar ");
  expect(modal).toContain("<DiffToolbar");
  for (const src of [page, modal]) {
    expect(src.includes("<ThemePicker")).toBe(false);
    expect(src.includes("<Toggle")).toBe(false);
  }
});
