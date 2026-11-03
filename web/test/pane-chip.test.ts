/*
 * The pane chip's decisions, without a DOM: which mode a machine gets, which
 * parts the chip has and in which order, what is cut from a branch name, what
 * the checks are allowed to say, and which of two readings of a pull request
 * wins. Plus the four reliability rules the chip must keep, each broken on
 * purpose before it was trusted.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { globalStubs } from "./stubGlobal.ts";
import {
  barKey, bufferPlacement, pillNameChars, chipNameChars, branchLabel, checksOf, prChipLabel, chipParts, cutMiddle, defaultPaneBarMode, freshestPr, pillPlacement, prForPane, prState, reviewOf, CHECKS_FRESH_MS, NARROW_W,
} from "../src/lib/paneChip.ts";
import type { ChecksView } from "../src/lib/paneChip.ts";
import { forgetPrFacts, notePrs, prFactOf } from "../src/lib/prFacts.ts";
import { PaneBar } from "../src/components/terminal/PaneBar.tsx";
import { PaneChipStatus } from "../src/components/terminal/PaneChipStatus.tsx";
import { PaneChipHover } from "../src/components/terminal/PaneChipHover.tsx";
import { readFileSync } from "node:fs";
import type { PrCheckRollup } from "../../shared/types.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
const pref = await import("../src/lib/paneActionsPref.ts");

beforeEach(() => { store.clear(); forgetPrFacts(); });

describe("the default mode", () => {
  test("a machine with no history gets Summary; one with ANY state keeps the thin line", () => {
    expect(defaultPaneBarMode(false)).toBe("summary");
    expect(defaultPaneBarMode(true)).toBe("edge");
  });

  test("new install: nothing stored, so Summary — and it is written down", () => {
    expect(pref.settlePaneBarMode()).toBe("summary");
    expect(store.get("agentglass.term.paneBar")).toBe("summary");
  });

  test("existing install: any prior key means the edge line, and the app's own first writes do not change the answer", () => {
    store.set("agentglass.theme", "porcelain");
    expect(pref.settlePaneBarMode()).toBe("edge");
    // Settled once: a later launch, with more keys by then, reads the same.
    store.set("agentglass.something.new", "1");
    expect(pref.paneActionsMode()).toBe("edge");
  });

  test("a new install stays Summary on the next launch even though the app has written keys by then", () => {
    pref.settlePaneBarMode();
    store.set("agentglass.theme", "graphite");
    expect(pref.paneActionsMode()).toBe("summary");
  });

  test("the old key still reads: its 'off' stays off, on a machine that has no new key yet", () => {
    store.set("agentglass.term.paneActions", "off");
    expect(pref.paneActionsMode()).toBe("off");
  });

  test("a choice is kept, and a different one replaces it", () => {
    pref.setPaneActionsMode("always");
    expect(pref.paneActionsMode()).toBe("always");
    pref.setPaneActionsMode("off");
    expect(pref.paneActionsMode()).toBe("off");
  });

  test("the edge marker persists, and the line is the absent key", () => {
    expect(pref.paneMarker()).toBe("line");
    pref.setPaneMarker("arrow");
    expect(pref.paneMarker()).toBe("arrow");
    expect(store.get("agentglass.term.paneMarker")).toBe("arrow");
    pref.setPaneMarker("line");
    expect(store.has("agentglass.term.paneMarker")).toBe(false);
  });
});

describe("parts and their order", () => {
  const wide = { kind: "worktree" as const, hasPr: true, hasCard: true, ahead: 2, behind: 0, width: 800 };

  test("the order is fixed, whatever is present", () => {
    expect(chipParts(wide).parts).toEqual(["kind", "name", "copy", "sep", "sync", "card", "pr", "diff"]);
    expect(chipParts({ ...wide, ahead: 0, hasCard: false }).parts).toEqual(["kind", "name", "copy", "sep", "pr", "diff"]);
  });

  test("a worktree with no pull request keeps the slot; a main checkout has none", () => {
    expect(chipParts({ ...wide, hasPr: false }).parts).toContain("pr");
    expect(chipParts({ ...wide, kind: "main", hasPr: false }).parts).not.toContain("pr");
  });

  test("outside, no repo and loading have no controls beyond the name", () => {
    for (const kind of ["outside", "none", "loading"] as const) expect(chipParts({ ...wide, kind }).parts).toEqual(["kind", "name"]);
  });

  test("a narrow pane drops the words, then copy and sync; the order stays", () => {
    const narrow = chipParts({ ...wide, width: NARROW_W - 1 });
    expect(narrow.words).toBe(false);
    expect(narrow.parts).toEqual(["kind", "name", "card", "pr", "diff"]);
  });
});

describe("the branch name", () => {
  const B = "ORBIT-1042-retry-webhook-delivery";
  test("the card id is greyed and kept while the whole name fits", () => {
    expect(branchLabel(B, "ORBIT-1042", 60)).toEqual({ pre: "ORBIT-1042-", text: "retry-webhook-delivery" });
  });
  test("the card id is the first thing dropped, then the middle is cut", () => {
    expect(branchLabel(B, "ORBIT-1042", 30)).toEqual({ pre: "", text: "retry-webhook-delivery" });
    const long = "ORBIT-1063-move-invoice-pdf-rendering-off-the-request-thread-into-the-worker-queue";
    const cut = branchLabel(long, "ORBIT-1063", 30);
    expect(cut.pre).toBe("");
    expect(cut.text.length).toBeLessThanOrEqual(30);
    expect(cut.text).toContain("…");
    expect(cut.text.endsWith("worker-queue")).toBe(true);
  });
  test("a branch with no card prefix is just cut in the middle", () => {
    expect(branchLabel("feature/x", "ORBIT-1", 60)).toEqual({ pre: "", text: "feature/x" });
    expect(cutMiddle("abcdefghijklmnopqrstuvwxyz", 10)).toContain("…");
  });
});

const roll = (over: Partial<PrCheckRollup> = {}): PrCheckRollup => ({ total: 12, success: 12, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [], ...over });

describe("the checks say only what was read", () => {
  const now = 1_000_000;
  test("no reading yet is not green: it is none-read-yet", () => {
    expect(checksOf(null, now).state).toBe("none-read-yet");
    expect(checksOf(undefined, now).state).toBe("none-read-yet");
  });
  test("a fresh reading says passing, running or failing", () => {
    expect(checksOf({ checks: roll(), at: now }, now).state).toBe("passing");
    expect(checksOf({ checks: roll({ pending: 3, allDone: false, verdict: null, success: 9 }), at: now }, now)).toMatchObject({ state: "running", passed: 9, total: 12 });
    const f = checksOf({ checks: roll({ failure: 2, success: 10, verdict: "red", failing: [{ name: "lint" }, { name: "test-api" }] as never }), at: now }, now);
    expect(f).toMatchObject({ state: "failing", passed: 10, total: 12, failing: ["lint", "test-api"] });
  });
  test("a failed read is neutral, never the last colour", () => {
    expect(checksOf({ checks: null, at: now }, now).state).toBe("error");
  });
  test("an expired read is neutral too", () => {
    expect(checksOf({ checks: roll(), at: now - CHECKS_FRESH_MS - 1 }, now).state).toBe("error");
  });
});

describe("one datum, one source", () => {
  const open = { number: 322, state: "OPEN" as const, isDraft: false, reviewDecision: null };

  test("the Pull requests view says merged, the chip says merged", () => {
    const readAtPane = freshestPr(open, 0, prFactOf("acme/orbit", 322));
    expect(prState(readAtPane)).toBe("open");
    notePrs("acme/orbit", [{ ...open, state: "MERGED" }], 5_000);
    expect(prState(freshestPr(open, 0, prFactOf("acme/orbit", 322)))).toBe("merged");
  });

  test("an older reading never replaces a newer one", () => {
    notePrs("acme/orbit", [{ ...open, state: "MERGED" }], 9_000);
    notePrs("acme/orbit", [open], 4_000);
    expect(prFactOf("acme/orbit", 322)?.state).toBe("MERGED");
  });

  test("the chip's own newer reading beats an older stored one", () => {
    notePrs("acme/orbit", [{ ...open, state: "MERGED" }], 1_000);
    expect(prState(freshestPr({ ...open, state: "OPEN" }, 2_000, prFactOf("acme/orbit", 322)))).toBe("open");
  });

  test("merged and closed have no review to wait for", () => {
    expect(reviewOf("APPROVED", "merged")).toBe("none");
    expect(reviewOf("CHANGES_REQUESTED", "open")).toBe("changes");
    expect(reviewOf("REVIEW_REQUIRED", "draft")).toBe("pending");
  });
});

describe("never stale across panes", () => {
  const held = { root: "/w/orbit-1042", branch: "ORBIT-1042-retry", pr: { number: 318 } };
  test("the pull request is this pane's own branch's, or nothing", () => {
    expect(prForPane(held, "/w/orbit-1042", "ORBIT-1042-retry")).toBe(held);
    // The pane moved to another branch: the old one is gone at once.
    expect(prForPane(held, "/w/orbit-1042", "ORBIT-1057-footer")).toBeNull();
    expect(prForPane(held, "/w/other", "ORBIT-1042-retry")).toBeNull();
    expect(prForPane(null, "/w/orbit-1042", "ORBIT-1042-retry")).toBeNull();
  });
});

describe("Summary's pill keeps clear of text", () => {
  const o = { cols: 100, pillCols: 28 };
  test("clear of the last line, it stays at the foot", () => {
    expect(pillPlacement({ ...o, lastEnd: 45, aboveEnd: 90 })).toEqual({ lift: false, translucent: false });
  });
  test("a last line that reaches under it lifts the pill", () => {
    expect(pillPlacement({ ...o, lastEnd: 80, aboveEnd: 10 })).toEqual({ lift: true, translucent: true });
  });
  test("with the row above occupied too it has nowhere to go and turns translucent", () => {
    expect(pillPlacement({ ...o, lastEnd: 80, aboveEnd: 90 })).toEqual({ lift: false, translucent: true });
  });
  test("the cursor counts as text: a prompt that has run under the pill moves it", () => {
    expect(pillPlacement({ ...o, lastEnd: 73, aboveEnd: 0 }).lift).toBe(true);
  });
});

describe("the three triggers draw", () => {
  const FOOT = { left: 0, top: 400, width: 700 };
  const draw = (p: Record<string, unknown>) => renderToStaticMarkup(React.createElement(PaneBar, {
    foot: FOOT, near: false, branch: "ORBIT-1042-retry", dirty: 3, onDown: () => {}, onGit: () => {}, onDiff: () => {}, onCopy: () => {}, ...p,
  } as never));

  test("Always open is pinned open in the strip the slot kept", () => {
    const html = draw({ mode: "always" });
    expect(html).toContain('data-open="1"');
    expect(html).toContain('data-mode="always"');
    expect(html).toContain(`top:${FOOT.top - 36}px`);
    expect(html).not.toContain("data-pane-seam");
  });
  test("Summary draws the pill and no band", () => {
    const html = draw({ mode: "summary", pr: { number: 318, title: "x", state: "open" } });
    expect(html).toContain("data-pane-pill");
    expect(html).toContain("#318");
    expect(html).toContain('data-open="0"');
  });
  test("Summary's pill names the branch whole, card id greyed, when the pane has room", () => {
    const html = draw({ mode: "summary", branch: "ORBIT-1042-retry-webhook-delivery", card: { id: "ORBIT-1042", priority: null, status: null, inApp: true }, pr: { number: 318, title: "x", state: "open" } });
    expect(html).toContain("retry-webhook-delivery");
    expect(html).toContain("#318");
    // A main checkout names its repository too.
    expect(draw({ mode: "summary", kind: "main", repo: "orbit", branch: "main" })).toContain("orbit · main");
  });
  test("Summary's pill steps up when asked", () => {
    expect(draw({ mode: "summary", pill: { lift: true, translucent: true } })).toContain(`top:${FOOT.top - 5 - 22 - 26}px`);
  });
  test("Edge: the line by default, the arrow when asked", () => {
    expect(draw({ mode: "edge" })).toContain("data-pane-seam");
    const arrow = draw({ mode: "edge", marker: "arrow" });
    expect(arrow).toContain("data-pane-arrow");
    expect(arrow).not.toContain("data-pane-seam");
  });
  test("outside this project offers its project; a pane with no repo does not", () => {
    const out = draw({ mode: "always", kind: "outside", note: "orbit-billing · outside this project (orbit)", noteAction: { label: "Open its project", onClick: () => {} } });
    expect(out).toContain("Open its project");
    expect(draw({ mode: "always", kind: "none", note: "~/Downloads — no repo scanned here" })).not.toContain("Open its project");
  });
  test("each part is one tab stop, the first reachable and the rest walked by arrows", () => {
    const html = draw({ mode: "always", ahead: 1, pr: { number: 318, title: "x", state: "open" }, onPr: () => {} });
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect((html.match(/data-chip-stop/g)?.length ?? 0)).toBeGreaterThan(3);
  });
});

describe("the status segment is one boundary", () => {
  const props = (checks: Parameters<typeof PaneChipStatus>[0]["checks"], over: Record<string, unknown> = {}) => ({
    pr: { number: 322, title: "x", state: "open" as const }, checks, review: "none" as const, card: null, worktree: true, words: true,
    stop: () => ({}), onPr: () => {}, onCard: () => {}, onNew: () => {}, onReach: () => {}, ...over,
  });
  const draw = (p: object) => renderToStaticMarkup(React.createElement(PaneChipStatus, p as never));
  const none = { state: "none-read-yet" as const, passed: 0, total: 0, failing: [] };

  test("no rollup yet: a dashed ring, no arc, no running comet, no failing count", () => {
    const html = draw(props(none));
    expect(html).toContain('stroke-dasharray="2.1 2.4"');
    expect(html).not.toContain("agx-halo-arc");
    expect(html).not.toContain("agx-halo-spin");
    expect(html).not.toContain("agx-halo-cnt");
    expect(html).toContain("checks not read yet");
  });
  test("a failed rollup read is the neutral state: the same dashed ring, never a last colour", () => {
    const html = draw(props({ state: "error", passed: 0, total: 0, failing: [] }));
    expect(html).toContain('stroke-dasharray="2.1 2.4"');
    expect(html).not.toContain("agx-halo-arc");
    expect(html).toContain("could not be read");
  });
  test("failing: a thicker red arc and the count, said in the label too", () => {
    const html = draw(props({ state: "failing", passed: 10, total: 12, failing: ["lint", "test-api"] }));
    expect(html).toContain("var(--error)");
    expect(html).toContain('class="agx-halo-cnt text-[10px]">2×<');
    expect(html).toContain("2 failing");
  });
  test("running: one comet, and only then", () => {
    expect(draw(props({ state: "running", passed: 7, total: 12, failing: [] }))).toContain("agx-halo-spin");
    expect(draw(props({ state: "passing", passed: 12, total: 12, failing: [] }))).not.toContain("agx-halo-spin");
  });
  test("merged freezes the ring and never shows a comet or a count", () => {
    const html = draw(props({ state: "failing", passed: 10, total: 12, failing: ["lint"] }, { pr: { number: 311, title: "x", state: "merged" } }));
    expect(html).toContain("data-frozen");
    expect(html).not.toContain("agx-halo-cnt");
    expect(html).not.toContain("agx-halo-spin");
  });
  test("review is a badge only when somebody decided", () => {
    expect(draw(props(none, { review: "approved" }))).toContain("agx-halo-rv");
    expect(draw(props(none, { review: "changes" }))).toContain("agx-halo-rv");
    expect(draw(props(none, { review: "pending" }))).not.toContain("agx-halo-rv");
  });
  test("a worktree with no pull request keeps the new slot; a main checkout draws nothing", () => {
    const empty = { ...props(none), pr: null };
    expect(draw(empty)).toContain("No pull request");
    expect(draw({ ...empty, worktree: false })).toBe("");
  });
  test("the card wears its status colour as a tint and its priority as the flag", () => {
    const html = draw(props(none, { card: { id: "ORBIT-1042", status: "In review", statusColor: "#a35bd8", priority: "high", inApp: true } }));
    expect(html).toContain("--sc:#a35bd8");
    expect(html).toContain("ORBIT-1042");
  });
});

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("Always open draws a chip under every pane, each with its own data", () => {
  const term = read("components/TerminalPanel.tsx");
  test("every slot gets its own foot and its own bar", () => {
    expect(term).toContain("const [slotFoots, setSlotFoots]");
    expect(term).toContain("paneIds.map((id, i) => {");
    expect(term).toContain("<SlotBar key={id} sessId={id}");
    // The focused slot keeps the richer read; the others are not left empty.
    expect(term).toContain("i === focusIdx");
  });
  test("a slot reads for itself, keyed by its own session, window and pane", () => {
    const slot = term.slice(term.indexOf("function SlotBar("), term.indexOf("/** Priority → the colour the chip wears."));
    expect(slot).toContain("const key = `${sessId}:${win}:${pane}`;");
    // A reading that is not this slot's key is nothing: no answer crosses panes.
    expect(slot).toContain("seen && seen.key === key ? seen : null");
    expect(slot).toContain("useBranchPr(open, wt?.root");
  });
  test("the pull request of a pane is that pane's live branch's, through one hook for every pane", () => {
    expect(term).toContain("function useBranchPr(");
    expect(term).toContain("return prForPane(raw, prRoot, prBranch);");
    expect(term).toContain("const chipPr = useBranchPr(open, prRoot, prBranch,");
  });
});

describe("the hover card says how far behind", () => {
  const card = (behind?: number) => renderToStaticMarkup(React.createElement(PaneChipHover, {
    pr: { number: 322, title: "x", state: "open" }, checks: { state: "none-read-yet", passed: 0, total: 0, failing: [] }, review: "none", card: null, behind,
  }));
  test("N commits, singular for one, nothing for none", () => {
    expect(card(2)).toContain("2 commits behind its upstream");
    expect(card(1)).toContain("1 commit behind its upstream");
    expect(card(0)).not.toContain("behind");
    expect(card()).not.toContain("behind");
  });
});

describe("the real way in", () => {
  test("nothing says Tab reaches the bar: Ctrl+Shift+B does, and the shell keeps Tab", () => {
    const picker = read("components/PaneBarPicker.tsx");
    expect(picker).toContain("Ctrl+Shift+B");
    expect(picker).not.toMatch(/\bTab (from|reaches)/);
    const bar = read("components/terminal/PaneBar.tsx");
    expect(bar).toContain("Ctrl+Shift+B focuses it");
    expect(bar).toContain('aria-label="Pane bar (Ctrl+Shift+B)"');
    // The chord is taken from the shell only when a bar is on screen.
    const term = read("components/TerminalPanel.tsx");
    expect(term).toContain('(e.key === "B" || e.key === "b") && focusPaneBar()');
  });
  test("Esc gives the keyboard back to the terminal, from the bar and from the pill", () => {
    expect(barKey("Escape", 3, 6)).toEqual({ escape: true });
    const bar = read("components/terminal/PaneBar.tsx");
    // Both the toolbar and the Summary pill hand Esc to onEscape...
    expect(bar.match(/p\.onEscape\?\.\(\)/g)?.length).toBe(2);
    // ...and the panel's onEscape puts the keyboard on the pane's own terminal, for every slot.
    const term = read("components/TerminalPanel.tsx");
    expect(term).toContain("onEscape={focusTerm}");
    expect(term.match(/sess\?\.term\.focus\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  test("the arrows walk the controls, clamped; Home and End jump", () => {
    expect(barKey("ArrowRight", 2, 6)).toEqual({ focus: 3 });
    expect(barKey("ArrowRight", 5, 6)).toEqual({ focus: 5 });
    expect(barKey("ArrowLeft", 0, 6)).toEqual({ focus: 0 });
    expect(barKey("Home", 4, 6)).toEqual({ focus: 0 });
    expect(barKey("End", 1, 6)).toEqual({ focus: 5 });
    expect(barKey("a", 1, 6)).toBeNull();
    expect(barKey("ArrowRight", -1, 0)).toBeNull();
  });
});

describe("Summary's pill, read off a real buffer", () => {
  const buf = (rows: string[], cursor: [number, number]) => ({
    viewportY: 0, cursorX: cursor[0], cursorY: cursor[1],
    getLine: (y: number) => rows[y] === undefined ? undefined : { translateToString: (_t?: boolean, a = 0, b?: number) => rows[y]!.slice(a, b).replace(/\s+$/, "") },
  });
  const o = { c0: 0, c1: 99, bottom: 4, cellW: 7 };
  test("a short last line leaves the pill at the foot", () => {
    expect(bufferPlacement(buf(["", "", "", "", "  bypass permissions on (shift+tab to cycle)"], [0, 3]), o)).toEqual({ lift: false, translucent: false });
  });
  test("a long last line lifts it", () => {
    const long = "  bypass permissions on (shift+tab to cycle)" + " ".repeat(20) + "ctx 82% · 3 agents";
    expect(bufferPlacement(buf(["", "", "", "", long], [0, 3]), o).lift).toBe(true);
  });
  test("the cursor standing under the pill counts as text", () => {
    expect(bufferPlacement(buf(["", "", "", "", ""], [90, 4]), o).lift).toBe(true);
  });
});

describe("the pill's branch width", () => {
  const long = "ORBIT-1042-VR-Agents-showing-busy-blue-when-accepting-gold-bar-before-placing-call";
  test("a wide pane keeps the whole readable name, card id greyed", () => {
    const l = branchLabel(long, "ORBIT-1042", pillNameChars(2400, true, true));
    expect(l).toEqual({ pre: "ORBIT-1042-", text: long.slice(11) });
  });
  test("a medium pane cuts the middle on word boundaries", () => {
    const l = branchLabel(long, "ORBIT-1042", pillNameChars(300, false, false));
    expect(l.text).toBe("VR-Agents-showing…before-placing-call");
  });
  test("a narrow pane never asks for fewer than 24 characters", () => {
    expect(pillNameChars(200, true, true)).toBe(24);
    expect(branchLabel(long, "ORBIT-1042", 24).text.length).toBeLessThanOrEqual(24);
  });
});

describe("the expanded bar's branch width", () => {
  const long = "ORBIT-1042-VR-Agents-showing-busy-blue-when-accepting-gold-bar-before-placing-call";
  const facts = (width: number) => chipParts({ kind: "worktree", hasPr: true, hasCard: true, ahead: 0, behind: 0, width });
  test("a wide pane budgets the whole name, a narrow one never under 24", () => {
    const w = facts(2400);
    expect(chipNameChars(2400, w.parts, w.words)).toBeGreaterThan(long.length);
    const n = facts(300);
    expect(chipNameChars(300, n.parts, n.words)).toBe(24);
  });
  test("a wide pane draws the name whole with the card id greyed", () => {
    const html = renderToStaticMarkup(React.createElement(PaneBar, {
      foot: { left: 0, top: 400, width: 2400 }, near: false, mode: "always", kind: "worktree", branch: long, dirty: 0,
      card: { id: "ORBIT-1042", priority: null, status: null, inApp: true }, pr: { number: 318, title: "x", state: "open" },
      onDown: () => {}, onGit: () => {}, onDiff: () => {}, onCopy: () => {},
    } as never));
    expect(html).toContain("VR-Agents-showing-busy-blue-when-accepting-gold-bar-before-placing-call");
    expect(html).toContain('var(--text4)">ORBIT-1042-</span>');
  });
});

describe("the pull-request chip names the review as the review", () => {
  const err: ChecksView = { state: "error", passed: 0, total: 0, failing: [] };
  test("an approval over unreadable checks does not read as a pass", () => {
    const l = prChipLabel({ number: 318, state: "open" }, err, "approved");
    expect(l).toContain("checks could not be read, review approved");
    expect(l).not.toMatch(/, approved/);
  });
  test("changes, pending and none keep their own words", () => {
    expect(prChipLabel({ number: 318, state: "open" }, err, "changes")).toContain(", changes requested");
    expect(prChipLabel({ number: 318, state: "open" }, err, "pending")).toContain(", review pending");
    expect(prChipLabel({ number: 318, state: "open" }, err, null)).toBe("Pull request 318, open, checks could not be read. Opens Pull requests.");
  });
});
