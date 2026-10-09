/*
 * A menu opened from the bench goes when the bench does.
 *
 * Menus are portaled to the body so a scrolling parent cannot clip them, which
 * also means the bench's DOM no longer holds them: hiding the window with the
 * chord left a people picker floating over the view until a click landed
 * somewhere. The decision is one name (who owns the layer), one announcement
 * (the owner is hidden), and every layer watching that name closing itself.
 *
 * There is no renderer here, so the hook is covered where it can be: the owner
 * decision and the watch are pure, the bench announces from its store, and a
 * source guard holds each shared floating component to the hook.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { globalStubs } from "./stubGlobal";
import { announceHidden, BENCH_OWNER, decideOwner, ownerOfElement, watchOwner } from "../src/lib/layerOwner.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage);

const inBench = { closest: (sel: string) => (sel === "[data-bench-root]" ? {} : null) } as unknown as Element;
const outside = { closest: () => null } as unknown as Element;

const offs: Array<() => void> = [];
const watch = (owner: string | null, fn: () => void) => { const off = watchOwner(owner, fn); offs.push(off); return off; };
afterEach(() => { while (offs.length) offs.pop()!(); });

describe("who owns a layer", () => {
  it("is the bench when the trigger sits inside the bench window", () => {
    expect(ownerOfElement(inBench)).toBe(BENCH_OWNER);
  });
  it("is nobody for a trigger outside it, or no trigger at all", () => {
    expect(ownerOfElement(outside)).toBeNull();
    expect(ownerOfElement(null)).toBeNull();
    expect(ownerOfElement(undefined)).toBeNull();
  });
  it("falls back to the board's owner when the layer has no anchor in the page", () => {
    expect(decideOwner(null, BENCH_OWNER)).toBe(BENCH_OWNER);
    expect(decideOwner(outside, null)).toBeNull();
  });
  it("lets the element win: a trigger inside the bench is the bench's whatever the board says", () => {
    expect(decideOwner(inBench, null)).toBe(BENCH_OWNER);
  });
});

describe("the bench hides", () => {
  it("closes every layer it owns, once each", () => {
    let a = 0, b = 0;
    watch(BENCH_OWNER, () => a++);
    watch(BENCH_OWNER, () => b++);
    announceHidden(BENCH_OWNER);
    expect([a, b]).toEqual([1, 1]);
  });
  it("leaves a layer opened outside the bench alone", () => {
    let n = 0;
    watch(null, () => n++);
    watch("somewhere-else", () => n++);
    announceHidden(BENCH_OWNER);
    expect(n).toBe(0);
  });
  it("does not call a layer that already closed", () => {
    let n = 0;
    const off = watch(BENCH_OWNER, () => n++);
    off();
    announceHidden(BENCH_OWNER);
    expect(n).toBe(0);
  });
  it("lets a layer unwatch itself while the announcement is running", () => {
    let n = 0;
    const off = watch(BENCH_OWNER, () => { n++; off(); });
    watch(BENCH_OWNER, () => n++);
    announceHidden(BENCH_OWNER);
    expect(n).toBe(2);
  });
});

describe("the bench's store announces on the toggle", () => {
  const load = async () => await import(`../src/lib/benchStore.ts?t=${Math.random()}`) as typeof import("../src/lib/benchStore.ts");

  it("announces when an open bench is hidden, by toggle or by close", async () => {
    const b = await load();
    let n = 0;
    watch(BENCH_OWNER, () => n++);
    b.openBench();
    expect(n).toBe(0);
    b.toggleBench();
    expect(n).toBe(1);
    b.openBench();
    b.closeBench();
    expect(n).toBe(2);
  });
  it("does not announce for a close of a bench that was not open, or for resizing it", async () => {
    const b = await load();
    let n = 0;
    watch(BENCH_OWNER, () => n++);
    b.closeBench();
    b.openBench();
    b.setBenchZoom(1.2);
    b.setBenchGrown(true);
    expect(n).toBe(0);
  });
});

/* Source, because this repo has no renderer: the rule is about how the next
   floating component gets written. A component that forgets the hook is one
   more menu that stays behind. */
describe("every shared floating component closes with its owner", () => {
  const SRC = resolve(import.meta.dir, "..", "src");
  const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");
  const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");

  const WITH_HOOK = [
    "components/Select.tsx",
    "components/PeoplePick.tsx",
    "components/AnchoredMenu.tsx",
    "components/ContextMenu.tsx",
    "components/StatusPanel.tsx",
    "components/FacetMenu.tsx",
    "components/BasePicker.tsx",
    "components/tasks/FilterBuilder.tsx",
    "components/tasks/EmojiPicker.tsx",
    "components/FilterPresets.tsx",
    "components/diff/DiffControls.tsx",
    "components/diff/DiffPage.tsx",
    "components/StackMarks.tsx",
    "components/TasksPanel.tsx",
    "components/PrPanel.tsx",
    "lib/useDismiss.ts",
  ];
  for (const f of WITH_HOOK) {
    it(`${f} uses useCloseWithOwner`, () => {
      expect(code(f)).toMatch(/useCloseWithOwner\(/);
    });
  }

  it("the ad hoc Tasks menus each carry it: status band, priority, sprint, field, tags, card hop", () => {
    const src = code("components/TasksPanel.tsx");
    expect(src).toMatch(/useCloseWithOwner\([^\n]*open: statusOpen/);
    expect(src).toMatch(/useCloseWithOwner\([^\n]*open: adding/);
    expect(src.match(/useCloseWithOwner\(/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it("the questions put to the person answer no, never yes", () => {
    const confirm = code("components/ConfirmDialog.tsx");
    expect(confirm).toMatch(/useOwnedQuestion\(pending, \(\) => open\.current\?\.resolve\(open\.current\.input \? null : false\)\)/);
    const merge = code("components/MergeDialog.tsx");
    expect(merge).toMatch(/useOwnedQuestion\(pending, \(\) => open\.current\?\.resolve\(null\)\)/);
  });

  it("the bench window is marked, a board in it says so, and the store announces", () => {
    expect(code("components/bench/FloatingBench.tsx")).toContain("OWNER_ATTR");
    expect(code("components/workspace/Workspace.tsx")).toMatch(/LayerOwner\.Provider value=\{inBench \? BENCH_OWNER : null\}/);
    expect(code("lib/benchStore.ts")).toMatch(/if \(hidden\) announceHidden\(BENCH_OWNER\)/);
  });

  /* The card in modal mode is not a floating layer: it is drawn inside the
     board's own panel, so it travels with the board and is never left over a
     view the board is not in. Moved into a Portal it would be the one thing
     that stays behind when the bench hides. */
  it("the card detail modal stays inside the board's panel, not in a portal", () => {
    const src = code("components/TasksPanel.tsx");
    const at = src.indexOf('{cardMode === "modal" && picked && (');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 200)).toContain('className="absolute inset-0');
    expect(src.slice(at, at + 200)).not.toContain("<Portal");
  });

  it("a closed layer hands no focus back to a window that is being hidden", () => {
    const sel = code("components/Select.tsx");
    expect(sel).toMatch(/useCloseWithOwner\(\(\) => setOpen\(false\)/);
  });
});
