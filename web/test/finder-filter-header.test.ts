/*
 * A pane's filter field, its header and its tab stop, as Strata has them: the keys of the field, what a press outside does,
 * the close button, the column popover's keys, and where Tab lands. Rules about source are asserted against source.
 */
import { describe, expect, test } from "bun:test";
import { filterKey, filterKeptBy } from "../src/lib/finderKeys.ts";
import { vimKey } from "../src/lib/finderMenu.ts";

const col = await Bun.file(new URL("../src/components/finder/machine/Column.tsx", import.meta.url)).text();
const vl = await Bun.file(new URL("../src/components/finder/machine/VirtualList.tsx", import.meta.url)).text();
const mk = await Bun.file(new URL("../src/components/finder/machine/useMenuKeys.ts", import.meta.url)).text();
const pop = await Bun.file(new URL("../src/components/finder/machine/Popover.tsx", import.meta.url)).text();
const fm = await Bun.file(new URL("../src/components/finder/machine/MachineFinder.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");

const some = { value: "rep", results: 3, selected: true };
describe("filter field keys", () => {
  test("Space acts on a selected result, types otherwise, and Shift+Space always types", () => {
    expect(filterKey({ key: " " }, some)).toBe("space");
    expect(filterKey({ key: " " }, { ...some, selected: false })).toBe("type");
    expect(filterKey({ key: " ", shift: true }, some)).toBe("type");
  });
  test("Down goes to the results, and stays with none", () => {
    expect(filterKey({ key: "ArrowDown" }, some)).toBe("down");
    expect(filterKey({ key: "ArrowDown" }, { ...some, results: 0 })).toBe("stay");
  });
  test("Up is swallowed", () => expect(filterKey({ key: "ArrowUp" }, some)).toBe("stay"));
  test("Enter and Right open the result only with a query and a result", () => {
    expect(filterKey({ key: "Enter" }, some)).toBe("activate");
    expect(filterKey({ key: "ArrowRight" }, some)).toBe("activate");
    expect(filterKey({ key: "Enter" }, { ...some, value: "" })).toBe("stay");
    expect(filterKey({ key: "ArrowRight" }, { ...some, value: "" })).toBe("type");
    expect(filterKey({ key: "Enter" }, { ...some, results: 0 })).toBe("stay");
  });
  test("Esc, and Backspace on an empty field, dismiss it", () => {
    expect(filterKey({ key: "Escape" }, some)).toBe("done");
    expect(filterKey({ key: "Backspace" }, { ...some, value: "" })).toBe("done");
    expect(filterKey({ key: "Backspace" }, some)).toBe("type");
  });
  test("a chord is the field's own", () => expect(filterKey({ key: " ", ctrl: true }, some)).toBe("type"));
});

describe("what a press outside does", () => {
  test("the field, the funnel and the pane's rows keep it; elsewhere dismisses", () => {
    expect(filterKeptBy({ inField: true, inToggle: false, inResults: false })).toBe(true);
    expect(filterKeptBy({ inField: false, inToggle: true, inResults: false })).toBe(true);
    expect(filterKeptBy({ inField: false, inToggle: false, inResults: true })).toBe(true);
    expect(filterKeptBy({ inField: false, inToggle: false, inResults: false })).toBe(false);
  });
  test("the field listens for it", () => {
    const f = code(col).slice(code(col).indexOf("export function FilterField("));
    expect(f).toContain('"pointerdown"');
    expect(f).toContain("filterKeptBy(");
  });
});

describe("column popover keys", () => {
  test("h j k l are the arrows; Shift keeps the letter", () => {
    expect([..."hjkl"].map((k) => vimKey(k))).toEqual(["ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight"]);
    expect(vimKey("J", true)).toBe("J");
    expect(vimKey("Enter")).toBe("Enter");
  });
  test("the sort popover is the column one, and Backspace closes it", () => {
    expect(col).toContain('label="Sort" column>');
    expect(code(pop)).toContain("column, onBackspace: onClose");
    expect(code(mk)).toContain('e.key === "Backspace" && back.current');
  });
  test("only the sort popover has them", () => expect(code(fm)).not.toContain(" column>"));
});

describe("header", () => {
  test("a close button on every pane but the first, closing this one and the ones beyond", () => {
    expect(col).toContain('aria-label="Close this pane"');
    expect(fm).toContain("onClosePane={i > 0 ?");
    const f = code(fm); const at = f.indexOf("const closeColumn");
    expect(f.slice(at, f.indexOf("\n", at))).toContain("t.slice(0, i)");
    expect(f).toContain('closeColumn(focusCol)');
  });
  test("the pane under the pointer lights its header", () => {
    expect(col).toContain("onMouseEnter={() => setHover(true)}");
    expect(col).toContain('data-hovered={hover ? "" : undefined}');
  });
});

describe("one filter at a time", () => {
  test("opening one turns the others off, and leaving the folder turns it off", () => {
    const f = code(fm);
    expect(f).toContain("{ [path]: f[path] ?? \"\" }");
    expect(f).toContain("trail.includes(k)");
    expect(f).toContain("finding={findAt === c.path}");
  });
});

describe("Tab stops", () => {
  test("a listing is a stop, and in Columns only the active pane's is", () => {
    expect(vl).toContain("tabIndex={tabStop ? 0 : -1}");
    expect(col).toContain("tabStop={focused}");
  });
  test("an empty or loading pane has a surface that takes focus, and the resize edge is no stop", () => {
    expect(col).toContain("data-surface tabIndex={focused ? 0 : -1}");
    expect(col).toContain("aria-valuenow={Math.round(width)} tabIndex={-1}");
  });
});
