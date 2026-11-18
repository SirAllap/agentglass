/*
 * Round 4 of the tab-switch leak (.agx-tmp/design.md). Two real bugs, both
 * pinned here by literally extracting and RUNNING the decision-path code —
 * the round-3 fixture below (frozen at the commit this branch started from)
 * for "before", the live source for "after" — rather than re-describing the
 * logic by hand or going red on a missing import.
 *
 * Bug 1 — the stale tab. `activeWindow` (the tab strip, optimistic:
 * `pendingWindow ?? tmuxWindows.find(active)?.id`) and `focusWin` (what fed
 * the chip bar's and the side pane's branch/card/diff count, NOT optimistic:
 * `tmuxWindows.find(active)?.id` alone) were two separate expressions over
 * the same `tmuxWindows` in the same render. Fix: one shared pure function,
 * `resolveActiveWindow` (lib/sidePane.ts), feeding both.
 *
 * Bug 2 — the visible reload on a revisit. Even with bug 1 fixed, the
 * `focusKey` detection effect (TerminalPanel.tsx, ~2279-2372) reset to
 * "detecting" (blank chip, no card/branch/diff) on EVERY focus-key change
 * whose agent session was not currently vouching for it — which is every
 * plain mouse click back to a tab, since vouching needs a live agent still
 * reporting, not just "we resolved this pane once already". The pane's own
 * warm identity-store answer (lib/paneIdentity.ts, written on every resolve,
 * read by key, never cleared on a focus change) was sitting right there and
 * was not consulted. Fix: the "known" calc also reads `identityOf(focusKey)`,
 * so a revisit with ANY previously-resolved answer skips "detecting"
 * entirely — a skeleton is now for a genuine first visit only. The `lastFacts`
 * per-tab shadow cache in `SidePaneFor` — a second, ad hoc attempt at the same
 * warm-cache job, which literally wrote this render's `at` under `p.tab`
 * whether or not it belonged there — is deleted outright: with bug 2 fixed,
 * `at`/`pr` are already correct and non-null for a resolved tab, so nothing
 * is left for it to paper over.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTabFactsStore } from "../src/lib/tabFacts.ts";
import { resolveActiveWindow as resolveActiveWindowReal } from "../src/lib/sidePane.ts";

const liveSrc = () => readFileSync(join(import.meta.dir, "..", "src", "components", "TerminalPanel.tsx"), "utf8");
/** Frozen at the commit this branch (sidepane4) started from — the "before" for every test below. */
const oldSrc = () => readFileSync(join(import.meta.dir, "fixtures", "round3-terminal-panel.tsx.txt"), "utf8");


/** A window's active-state exactly as the server's `t:"tmux"` frame shapes it. */
type Win = { id: string; active: boolean };

/** The exact right-hand side of `const <name> = ...;` in `src`, extracted — not retyped. */
function rhsOf(src: string, declStart: string): string {
  const i = src.indexOf(declStart);
  if (i < 0) throw new Error(`not found in source: ${declStart}`);
  const start = i + declStart.length;
  const end = src.indexOf(";", start);
  return src.slice(start, end).trim();
}

/** Builds a real, callable function from a right-hand-side expression sliced out of actual source text. */
function fnFromRhs(params: string[], rhs: string): (...args: unknown[]) => unknown {
  // eslint-disable-next-line no-new-func
  return new Function(...params, `return (${rhs});`) as (...args: unknown[]) => unknown;
}

describe("bug 1 — the strip and the chip/pane source, driven from the actual decision-path code", () => {
  it("old: `focusWin` is its own expression, with no `pendingWindow` in it — the fixture still has the bug", () => {
    const o = oldSrc();
    const rhs = rhsOf(o, "const focusWin = ");
    expect(rhs).toBe('focusSess?.tmuxWindows?.find((w) => w.active)?.id ?? ""');
    expect(rhs).not.toContain("pendingWindow");
  });

  it("new: `focusWin` and `activeWindow` both call `resolveActiveWindow` with the same `pendingWindow`", () => {
    const n = liveSrc();
    expect(rhsOf(n, "const focusWin = ")).toBe('resolveActiveWindow(pendingWindow, focusSess?.tmuxWindows ?? []) ?? ""');
    expect(rhsOf(n, "const activeWindow = ")).toBe("resolveActiveWindow(pendingWindow, tmuxWindows)");
  });

  it("4 tabs, all 12 ordered pairs, RUNNING the extracted expressions: old diverges on every pair, new never does", () => {
    const tabs = ["A", "B", "C", "D"];
    const card = (id: string): { root: string; branch: string } => ({ root: `/code/orbit-${id}`, branch: `ORBIT-${id}` });
    /** Stands in for "whatever this tab's card is", by id — any map would do. */
    const cardOf = new Map<string, { root: string; branch: string }>();

    const o = oldSrc();
    const n = liveSrc();
    const oldFocusWin = fnFromRhs(["focusSess"], rhsOf(o, "const focusWin = ")) as (focusSess: { tmuxWindows: Win[] }) => string;
    const oldActiveWindow = fnFromRhs(["pendingWindow", "tmuxWindows"], rhsOf(o, "const activeWindow = ")) as (p: string | null, w: Win[]) => string | null;
    const newFocusWin = fnFromRhs(["resolveActiveWindow", "pendingWindow", "focusSess"], rhsOf(n, "const focusWin = ")) as (r: typeof resolveActiveWindowReal, p: string | null, focusSess: { tmuxWindows: Win[] }) => string;
    const newActiveWindow = fnFromRhs(["resolveActiveWindow", "pendingWindow", "tmuxWindows"], rhsOf(n, "const activeWindow = ")) as (r: typeof resolveActiveWindowReal, p: string | null, w: Win[]) => string | null;

    let oldMismatches = 0;
    let newMismatches = 0;
    let pairs = 0;
    for (const from of tabs) {
      for (const to of tabs) {
        if (from === to) continue;
        pairs++;
        cardOf.clear();
        for (const id of tabs) cardOf.set(id, card(id));

        // tmux's own pushed list still has `from` active — the click has not
        // round-tripped to the server and back yet. This is the ONE render
        // right after the click.
        const staleWindows: Win[] = tabs.map((t) => ({ id: t, active: t === from }));
        const pendingWindow = to; // set synchronously by the click handler

        const sideTabOld = oldActiveWindow(pendingWindow, staleWindows);
        const focusWinOld = oldFocusWin({ tmuxWindows: staleWindows });
        expect(sideTabOld).toBe(to); // the strip was always honest
        if ((cardOf.get(focusWinOld)?.branch ?? null) !== card(to).branch) oldMismatches++;

        const sideTabNew = newActiveWindow(resolveActiveWindowReal, pendingWindow, staleWindows);
        const focusWinNew = newFocusWin(resolveActiveWindowReal, pendingWindow, { tmuxWindows: staleWindows });
        expect(sideTabNew).toBe(to);
        expect(focusWinNew).toBe(to);
        if ((cardOf.get(focusWinNew)?.branch ?? null) !== card(to).branch) newMismatches++;
      }
    }
    expect(pairs).toBe(12);
    expect(oldMismatches).toBe(12); // the fixture: every pair shows the PREVIOUS tab's card
    expect(newMismatches).toBe(0); // the fix: every pair shows the CLICKED tab's card
  });
});

describe("bug 2, superseded: 'detecting' is now a plain record lookup, not a vouching gate", () => {
  /*
   * Round 4 fixed the blank-on-revisit bug by making the identity cache a
   * SECOND warm source beside live-agent vouching. Round 5 (lib/tabFacts.ts)
   * removes the gate (and the agent-vouching memory) outright: a tab's
   * record is the one and only answer, written by a resolve and read as it
   * stands — there is no "is anybody currently vouching for this" question
   * left to ask, so a plain mouse revisit was never a special case to fix.
   */
  it("old: the gate needed a live-vouching agent OR nothing", () => {
    const o = oldSrc();
    expect(o).toContain("vouchedSeen(");
  });

  it("new: no vouching concept anywhere in the live source — the record alone decides", () => {
    const n = liveSrc();
    expect(n).not.toContain("vouchedSeen(");
    expect(n).not.toContain("wtSeen");
    expect(n).toContain("setWtDetecting(!liveTabFacts.get(focusWin));");
  });

  it("RUNNING the real store: a plain mouse revisit (nobody vouching, no live read) still answers from the record", () => {
    const store = createTabFactsStore();
    store.write("@A", { root: "/code/orbit-A", branch: "ORBIT-A" });
    // Away, then back — no agent, no fresh read, exactly a plain click.
    store.setActive("@B");
    store.setActive("@A");
    expect(store.get("@A")?.root).toBe("/code/orbit-A"); // the fix: the warm answer, no blank frame
    // A tab truly never written answers undefined, honestly — the one case
    // "detecting" is still correct for.
    expect(store.get("@never-focused")).toBeUndefined();
  });
});

describe("the per-tab shadow cache (`lastFacts`) is gone, not just quiet", () => {
  it("old: SidePaneFor writes this render's `at` under `p.tab` unconditionally, then falls back to it", () => {
    const o = oldSrc();
    expect(o).toContain('const lastFacts = new Map<string, { at: GitRepoRef; pr: SidePaneFactsProps["pr"]; prRoot: string }>();');
    expect(o).toContain("if (p.at) lastFacts.set(p.tab, { at: p.at, pr: p.pr, prRoot: p.prRoot });");
  });

  it("new: deleted outright — SidePaneFor is a pass-through", () => {
    const n = liveSrc();
    expect(n).not.toContain("const lastFacts");
    expect(n).toContain("function SidePaneFor(p: SidePaneFactsProps) {\n  return <SidePaneWithFacts {...p} />;\n}");
  });
});

describe("no visible reload: a revisit is a read, never a clear", () => {
  it("a revisited tab never passes through a null/blank value on its way back to its own answer", () => {
    // With the record itself as the only answer (no vouching gate to clear
    // it first), every frame of a revisit reads the SAME stored root —
    // there is no long-way-round through "detecting" to miss.
    const store = createTabFactsStore();
    store.write("A", { root: "/code/orbit-A", branch: "ORBIT-A" });
    const framesSeenDuringRevisit: (string | null)[] = [];
    framesSeenDuringRevisit.push(store.get("A")?.root ?? null); // frame 1: render right after the click
    framesSeenDuringRevisit.push(store.get("A")?.root ?? null); // frame 2: the effect has run, nothing changed

    expect(framesSeenDuringRevisit).toEqual(["/code/orbit-A", "/code/orbit-A"]);
    expect(framesSeenDuringRevisit.some((f) => f === null)).toBe(false);
  });

  it("a genuine first visit (nothing written yet) still shows a skeleton, never another tab's answer", () => {
    const store = createTabFactsStore();
    expect(store.get("B")).toBeUndefined(); // detecting — correct for a true first visit
  });
});
