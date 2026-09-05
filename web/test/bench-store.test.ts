/*
 * What the bench remembers.
 *
 * The rules pinned here are the ones that decide whether the thing is usable
 * across a day rather than across a click: a tab set belongs to a CHECKOUT (so
 * changing worktree changes what you see and loses nothing), a session number
 * is never handed out twice (two tabs on one tmux session mirror each other,
 * which is the bug this app has already paid for once), and the window and the
 * button come back on screen whatever they were saved on — this machine runs
 * two monitors at different scales, and a position remembered in pixels comes
 * back outside the viewport.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const load = async () => await import(`../src/lib/benchStore.ts?t=${Math.random()}`) as typeof import("../src/lib/benchStore.ts");

const A = "/home/dev/orbit";
const B = "/home/dev/orbit-ORBIT-1042";

beforeEach(() => store.clear());

describe("tabs belong to a checkout", () => {
  it("keeps one set per root and switching roots loses neither", async () => {
    const b = await load();
    b.addTab(A, { kind: "term", title: "~/orbit" });
    b.setBenchRoot(B);
    b.addTab(B, { kind: "term", title: "~/orbit-1042" });

    expect(b.tabsFor(A)).toHaveLength(1);
    expect(b.tabsFor(B)).toHaveLength(1);
    expect(b.benchRoots().sort()).toEqual([A, B].sort());
  });

  it("hands out the smallest free session number, per checkout", async () => {
    const b = await load();
    const one = b.addTab(A, { kind: "term", title: "one" });
    const two = b.addTab(A, { kind: "term", title: "two" });
    expect([one.slot, two.slot]).toEqual([1, 2]);

    // Another checkout starts again at 1: the session name carries the
    // checkout, so the two never collide on the engine.
    expect(b.addTab(B, { kind: "term", title: "elsewhere" }).slot).toBe(1);

    // Closing the first frees ITS number rather than walking to 99.
    b.closeTab(A, one.id);
    expect(b.addTab(A, { kind: "term", title: "three" }).slot).toBe(1);
  });

  it("closing the active tab activates a neighbour, not nothing", async () => {
    const b = await load();
    const one = b.addTab(A, { kind: "term", title: "one" });
    const two = b.addTab(A, { kind: "term", title: "two" });
    b.activateTab(A, one.id);
    b.closeTab(A, one.id);
    expect(b.activeTabId(A)).toBe(two.id);
  });

  it("closing the last tab of a checkout forgets the checkout", async () => {
    const b = await load();
    const only = b.addTab(A, { kind: "term", title: "one" });
    b.closeTab(A, only.id);
    expect(b.benchRoots()).toEqual([]);
  });
});

describe("showing a file", () => {
  it("reuses the tab for the same file and only moves the line", async () => {
    const b = await load();
    const first = b.showFile(A, "src/api/calls.py", { line: 10 });
    const again = b.showFile(A, "src/api/calls.py", { line: 883 });
    expect(again.id).toBe(first.id);
    expect(b.tabsFor(A)).toHaveLength(1);
    expect(b.activeTab(A)?.line).toBe(883);
  });

  it("a copy of a ref is a different tab from the working tree's", async () => {
    const b = await load();
    b.showFile(A, "src/api/calls.py", { line: 10 });
    b.showFile(A, "src/api/calls.py", { line: 10, ref: "4e98366", readonly: true });
    expect(b.tabsFor(A)).toHaveLength(2);
    expect(b.activeTab(A)?.readonly).toBe(true);
  });
});

describe("the files share one editor", () => {
  it("puts every file tab on the reader's session", async () => {
    const b = await load();
    const one = b.showFile(A, "src/api/calls.py");
    const two = b.showFile(A, "src/api/models.py");
    expect(one.slot).toBe(b.READER_SLOT);
    expect(two.slot).toBe(b.READER_SLOT);
  });

  it("never hands the reader's session to a shell", async () => {
    const b = await load();
    // Fill every slot below the reader's, then ask for one more: the answer
    // must skip 90, or a shell would attach to the session holding somebody's
    // editor and tmux would mirror the two.
    for (let n = 0; n < b.READER_SLOT - 1; n++) b.addTab(A, { kind: "term", title: `t${n}` });
    expect(b.freeSlot(A)).toBe(b.READER_SLOT + 1);
  });
});

describe("the window and the button come back on screen", () => {
  it("clamps a geometry that would open off the edge", async () => {
    const b = await load();
    expect(b.clampGeom({ x: 140, y: -20, w: 64, h: 68 })).toEqual({ x: 36, y: 0, w: 64, h: 68 });
    // A window narrower than a tab bar is not a window.
    expect(b.clampGeom({ x: 0, y: 0, w: 2, h: 2 }).w).toBe(22);
  });

  it("clamps the button, which is the one that gets dragged to a corner", async () => {
    const b = await load();
    expect(b.clampFab({ x: 220, y: -8 })).toEqual({ x: 98, y: 4 });
  });

  it("saves in percentages, so another screen is another place and not another pixel", async () => {
    const b = await load();
    b.setBenchFab({ x: 12, y: 30 });
    const raw = JSON.parse(store.get("agentglass.bench.v1") || "{}");
    expect(raw.fab).toEqual({ x: 12, y: 30 });
  });
});

describe("what survives a reload", () => {
  it("brings back the tabs and never brings back the window", async () => {
    const b = await load();
    b.addTab(A, { kind: "term", title: "~/orbit" });
    b.openBench();
    expect(b.benchState().open).toBe(true);

    const again = await load();
    expect(again.tabsFor(A)).toHaveLength(1);
    // Reached for, not imposed: an app that starts with a window over the view
    // you asked for decided something for you.
    expect(again.benchState().open).toBe(false);
  });

  it("drops stored junk instead of rendering it", async () => {
    store.set("agentglass.bench.v1", JSON.stringify({
      byRoot: { [A]: { tabs: [{ id: "x", kind: "nonsense", title: "?", slot: 1 }, null, 7], active: "x" } },
    }));
    const b = await load();
    expect(b.benchRoots()).toEqual([]);
  });
});
