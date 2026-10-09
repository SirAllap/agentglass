// The stack marks, asserted against their source: this project has no renderer
// to mount them, so what they must never do is read as text.
//
//   - they write nothing to GitHub (the feature reads; the only call it adds is
//     one cached lookup by branch),
//   - the token is the house's 20px box and the control's slots are fixed,
//   - no tracker's column is spelled out in code,
//   - nothing moves when the mark appears: the card reserves the spine's height
//     and the token takes the slot the base branch had,
//   - there is one list of trunks, not a copy in every screen.
import { describe, expect, test } from "bun:test";

const src = async (p: string) => await Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");
const marks = code(await src("components/StackMarks.tsx"));
const board = await src("components/TriageBoard.tsx");
const panel = await src("components/PrPanel.tsx");
const store = code(await src("lib/prBaseStore.ts"));
const detect = code(await src("lib/prStack.ts"));
const css = await src("index.css");
const stackCss = css.slice(css.indexOf("Stacked pull requests: the spine"));

describe("stack marks read, they never write", () => {
  test("the marks and the store call the API only for the one lookup", () => {
    for (const [name, text] of [["StackMarks", marks], ["prBaseStore", store], ["prStack", detect]] as const) {
      const calls = [...text.matchAll(/\bapi\.([A-Za-z]+)\(/g)].map((m) => m[1]);
      expect(calls.filter((c) => c !== "prForHead"), name).toEqual([]);
    }
  });
  test("neither imports a way to post", () => {
    expect(marks).not.toMatch(/\bpost\(|\bpatch\(|method: "(POST|PUT|PATCH|DELETE)"/);
    expect(store).not.toMatch(/\bpost\(|method: "(POST|PUT|PATCH|DELETE)"/);
  });
});

describe("size and slots", () => {
  test("the token is MIN_BOX tall and the spine's box is never under it", () => {
    expect(marks).toMatch(/const BOX = MIN_BOX;/);
    expect(marks).toMatch(/style: CSSProperties = \{ height: BOX \}/);
    expect(stackCss).toMatch(/\.agx-stk-b \{[^}]*min-height: 20px/);
  });
  test("the control is 150px with a fixed 24px slot at each end, so stepping moves nothing", () => {
    expect(stackCss).toMatch(/\.agx-stk-c \{[^}]*width: 150px/);
    expect(stackCss).toMatch(/\.agx-stk-ar \{ width: 24px; \}/);
    expect(marks).toMatch(/<Step dir="prev"[\s\S]*<Step dir="next"/);
    // an absent neighbour disables the button, it does not remove it
    expect(marks).toMatch(/disabled=\{!to\}/);
  });
  test("the card reserves the spine's height, and the token sits where the base branch did", () => {
    expect(board).toMatch(/minHeight: stack \? spineHeight\(stack\.spine\) : undefined/);
    /* Between the arrow of the stand line and the token there is no new row. */
    const at = board.indexOf("<BaseToken");
    const from = board.lastIndexOf("→</span>", at);
    expect(from).toBeGreaterThan(0);
    expect(board.slice(from, at)).not.toMatch(/<div|<br/);
  });
});

describe("one list of trunks, and no company in the code", () => {
  test("the board and the panel take the trunk test from prStack, not a copy", () => {
    expect(board).not.toMatch(/const TRUNKS = new Set/);
    expect(panel).not.toMatch(/const TRUNKS = new Set/);
    expect(board).toMatch(/isTrunkBranch/);
    expect(panel).toMatch(/isTrunkBranch/);
  });
  test("no tracker's column name is spelled in the marks", () => {
    expect(marks).not.toMatch(/ready for qa|in development|code review/i);
  });
});

describe("accessible by more than colour", () => {
  test("every spine and token carries a sentence as its name and title", () => {
    expect(marks).toMatch(/role="img" aria-label=\{label\} title=\{label\}/);
    expect(marks).toMatch(/"aria-label": sentence/);
  });
  test("a tick and a cross are drawn icons, never typed characters", () => {
    expect(marks).not.toMatch(/[✓✕×]/);
  });
  test("the ladder closes on Escape and on a click outside, like every menu", () => {
    expect(marks).toMatch(/e\.key === "Escape"/);
    expect(marks).toMatch(/addEventListener\("mousedown"/);
  });
});
