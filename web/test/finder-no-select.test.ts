import { describe, expect, test } from "bun:test";

// Clicking a Devices row painted its label blue: the chrome was selectable text.
// Strata's chrome is never selectable; only a file's own text and the inputs are.
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const dir = new URL("../src/components/finder/machine/", import.meta.url);
const src = async (f: string) => await Bun.file(new URL(f, dir)).text();
const popover = await src("Popover.tsx");
const ops = await src("FinderOpsUI.tsx");
const peek = await src("FolderPeek.tsx");
const body = await src("PreviewBody.tsx");
const finder = await src("MachineFinder.tsx");

const rule = (sel: string) => {
  const at = css.indexOf(sel);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("the finder's chrome is not selectable text", () => {
  test("one rule turns selection off under the finder root and in its menus", () => {
    const r = rule("[data-machine-finder], [data-finder-menu] {");
    expect(r).toMatch(/(^|[\s{;])user-select: none/);
    expect(r).toContain("-webkit-user-select: none");
  });
  test("a file's text, inputs and the editor stay selectable", () => {
    const r = rule("[data-machine-finder] :is(");
    expect(r).toMatch(/(^|[\s{;])user-select: text/);
    for (const k of ["input", "textarea", "[contenteditable]", "[data-selectable]", ".xterm"]) expect(r).toContain(k);
  });
  test("the root and every menu the finder draws carry the markers", () => {
    expect(finder).toContain("<div ref={root} data-machine-finder");
    expect(popover).toContain('role="menu" data-finder-menu');
    expect(ops.match(/data-finder-menu/g)?.length).toBe(2);
    expect(peek).toContain("data-finder-menu");
  });
  test("the preview body is the one selectable region", () => {
    expect(body).toContain("<div ref={bodyRef} data-selectable");
  });
});
