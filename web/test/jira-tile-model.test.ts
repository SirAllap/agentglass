/*
 * The rich Jira board tile, decision by decision: which state the header shows, whether the status chip shows, how many pull
 * requests draw inline, what a lone mention says, where the popover opens, and which one Jira action the tile offers. Each is
 * a pure function, so each is tested here and the component only draws the answer.
 */
import { describe, expect, test } from "bun:test";
import {
  childBar, compactPrChip, inlinePrs, ticketLayout, moveView, mentionChip, popoverPlacement, tileAction, tileOwner, tileHeader, tileStatusChip, type TilePr,
} from "../src/lib/jiraTileModel.ts";

const pr = (n: number, o: Partial<TilePr> = {}): TilePr => ({
  number: n, state: "OPEN", draft: false, url: `https://github.com/orbit/web/pull/${n}`, base: "main", branch: null,
  ci: { state: "passing", passed: 12, total: 12, failing: [], failed: 0 }, review: { kind: "approved", who: "JL" }, behind: null, additions: 5, deletions: 1, ...o,
});
const failing = (n: number) => pr(n, { ci: { state: "failing", passed: 10, total: 12, failing: ["e2e-export-queue", "lint"], failed: 2 }, review: { kind: "awaiting", who: "RA" } });

describe("the header shows the one thing that needs you", () => {
  test("a blocker comes first, even over failing checks", () => {
    expect(tileHeader({ blockedBy: ["ORBIT-1082"], worker: false, prs: [failing(495)] })).toMatchObject({ kind: "blocked", text: "Blocked by ORBIT-1082" });
  });
  test("a running worker says so when nothing blocks", () => {
    expect(tileHeader({ blockedBy: [], worker: true, prs: [] })).toMatchObject({ kind: "worker", text: "Worker running" });
  });
  test("failing checks name the count and the first failing check", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [failing(495), pr(480, { state: "MERGED" })] })).toMatchObject({ kind: "ci-failing", text: "2 checks failing · e2e-export-queue" });
  });
  test("an open PR nobody answered waits on the named reviewer", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [pr(512, { ci: { state: "running", passed: 9, total: 12, failing: [], failed: 0 }, review: { kind: "awaiting", who: "MK" } })] }))
      .toMatchObject({ kind: "waiting", text: "Waiting on MK · review" });
  });
  test("an approved open PR with green checks is ready, and leads with its number", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [pr(610)] })).toMatchObject({ kind: "ready", text: "Lead #610 approved · CI 12/12" });
  });
  test("a draft is not asked to be reviewed, so it does not wait", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [pr(9, { draft: true, review: { kind: "awaiting", who: "MK" } })] }).kind).toBe("quiet");
  });
  test("no PR, no blocker, no worker: nothing needs you", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [] })).toMatchObject({ kind: "quiet", text: "Nothing needs you" });
  });
  test("a merged PR alone needs nothing", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [pr(480, { state: "MERGED" })] }).kind).toBe("quiet");
  });
  test("CI not read yet never says failing or passing", () => {
    const h = tileHeader({ blockedBy: [], worker: false, prs: [pr(7, { ci: { state: "unknown", passed: 0, total: 0, failing: [], failed: 0 }, review: { kind: "unknown", who: null } })] });
    expect(h.kind).toBe("quiet");
  });
});

describe("the status chip shows only when the status is not the lane", () => {
  test("same as the lane: no chip", () => { expect(tileStatusChip("In development", "In development")).toBeNull(); });
  test("same up to case and spacing: no chip", () => { expect(tileStatusChip("In Development ", "in development")).toBeNull(); });
  test("different from the lane: the chip", () => { expect(tileStatusChip("Ready", "In development")).toBe("Ready"); });
  test("a lane that is not a status (grouped by person): the chip", () => { expect(tileStatusChip("To do", null)).toBe("To do"); });
});

describe("own PRs: inline, or lead plus +N", () => {
  const n = (k: number) => Array.from({ length: k }, (_, i) => pr(600 + i));
  test("none", () => { expect(inlinePrs([])).toEqual({ inline: [], more: 0 }); });
  test("one and two draw inline", () => {
    expect(inlinePrs(n(1)).more).toBe(0);
    expect(inlinePrs(n(2))).toMatchObject({ more: 0 });
    expect(inlinePrs(n(2)).inline).toHaveLength(2);
  });
  test("three or more: the lead and +N", () => {
    const r = inlinePrs(n(10));
    expect(r.inline).toHaveLength(1);
    expect(r.more).toBe(9);
  });
  test("the lead is the open one, not the newest merged", () => {
    const r = inlinePrs([pr(700, { state: "MERGED" }), pr(5), pr(6, { state: "CLOSED" })]);
    expect(r.inline[0]!.number).toBe(5);
  });
});

describe("a mention is a link icon and a count", () => {
  test("none: nothing", () => { expect(mentionChip(0)).toBeNull(); });
  test("one", () => { expect(mentionChip(1)).toEqual({ count: 1, tip: "1 mention" }); });
  test("three", () => { expect(mentionChip(3)).toEqual({ count: 3, tip: "3 mentions" }); });
});

describe("the popover stays inside its lane and never covers a header", () => {
  const lane = { left: 100, top: 40, right: 436, bottom: 900 };
  const pop = { w: 300, h: 200 };
  test("opens below the anchor when there is room", () => {
    const p = popoverPlacement({ left: 150, top: 300, right: 190, bottom: 326 }, lane, pop);
    expect(p).toMatchObject({ top: 330, flip: false });
  });
  test("flips above when the lane runs out below", () => {
    const p = popoverPlacement({ left: 150, top: 800, right: 190, bottom: 826 }, lane, pop);
    expect(p.flip).toBe(true);
    expect(p.top + pop.h).toBeLessThanOrEqual(800 - 4);
  });
  test("never above the lane's top edge, even when neither side fits", () => {
    const tiny = { left: 100, top: 40, right: 436, bottom: 200 };
    const p = popoverPlacement({ left: 150, top: 100, right: 190, bottom: 126 }, tiny, pop);
    expect(p.top).toBeGreaterThanOrEqual(tiny.top);
  });
  test("slides left so the right edge stays in the lane", () => {
    const p = popoverPlacement({ left: 400, top: 300, right: 430, bottom: 326 }, lane, pop);
    expect(p.left + pop.w).toBeLessThanOrEqual(lane.right);
    expect(p.left).toBeGreaterThanOrEqual(lane.left);
  });
  test("a lane narrower than the popover pins it to the lane's left", () => {
    const narrow = { left: 100, top: 40, right: 332, bottom: 900 };
    const p = popoverPlacement({ left: 120, top: 300, right: 150, bottom: 326 }, narrow, pop);
    expect(p.left).toBe(100);
  });
});

describe("the Jira actions the tile offers (never an action on the PR)", () => {
  const base = { blockedBy: [] as string[], worker: false, header: "quiet" as "quiet" | "waiting" | "ci-failing" | "blocked" | "worker", nextStatus: "In review" as string | null, writable: true };
  test("blocked: open the blocking card, runs at once", () => {
    expect(tileAction({ ...base, blockedBy: ["ORBIT-1082"], header: "blocked" }).primary).toEqual({ kind: "open-blocker", label: "Open ORBIT-1082", key: "ORBIT-1082", all: "ORBIT-1082", count: 1, disabled: null });
  });
  test("a worker is running: open it", () => {
    expect(tileAction({ ...base, worker: true, header: "worker" }).primary).toMatchObject({ kind: "open-worker", label: "Open worker" });
  });
  test("a blocker wins over a worker", () => {
    expect(tileAction({ ...base, blockedBy: ["ORBIT-1"], worker: true, header: "blocked" }).primary?.kind).toBe("open-blocker");
  });
  test("waiting on a reviewer: move to the next step", () => {
    expect(tileAction({ ...base, header: "waiting" }).primary).toMatchObject({ kind: "move-next", label: "Move to In review", to: "In review", disabled: null });
  });
  test("no next step: no primary at all, never a flight plan", () => {
    expect(tileAction({ ...base, header: "waiting", nextStatus: null }).primary).toBeNull();
  });
  test("failing checks: the next move, assign on hover, never a flight plan", () => {
    const a = tileAction({ ...base, header: "ci-failing" });
    expect(a.primary).toMatchObject({ kind: "move-next", label: "Move to In review" });
    expect(a.secondary).toMatchObject({ kind: "assign", label: "Assign" });
  });
  test("Changes in Jira off: Jira writes are disabled and name the setting", () => {
    const a = tileAction({ ...base, header: "waiting", writable: false });
    expect(a.primary?.disabled).toContain("Changes in Jira");
    expect(a.secondary?.disabled).toContain("Changes in Jira");
  });
  test("opening never needs the write switch", () => {
    expect(tileAction({ ...base, blockedBy: ["X-1"], header: "blocked", writable: false }).primary?.disabled).toBeNull();
  });
  test("blocked or worker tiles offer no second action", () => {
    expect(tileAction({ ...base, worker: true, header: "worker" }).secondary).toBeNull();
  });
});

const kid = (key: string, kind: "done" | "progress" | "todo" | "blocked") => ({ key, status: kind, kind });

describe("umbrella: children bar and the blocked child", () => {
  test("no children: no bar", () => { expect(childBar([])).toBeNull(); expect(childBar(undefined)).toBeNull(); });
  test("done of total, one square per child in order", () => {
    const b = childBar([kid("A-1", "done"), kid("A-2", "progress"), kid("A-3", "blocked"), kid("A-4", "todo")])!;
    expect(b).toMatchObject({ done: 1, total: 4, hidden: 0, blocked: { key: "A-3", count: 1 } });
    expect(b.squares).toEqual(["done", "progress", "blocked", "todo"]);
  });
  test("the first blocked child is the one to open; the count says how many", () => {
    expect(childBar([kid("A-1", "blocked"), kid("A-2", "blocked")])!.blocked).toEqual({ key: "A-1", count: 2 });
  });
  test("two rows max: squares past 28 fold into a hidden count", () => {
    const b = childBar(Array.from({ length: 40 }, (_, i) => kid(`A-${i}`, "todo")))!;
    expect(b.squares).toHaveLength(28);
    expect(b.hidden).toBe(12);
    expect(b.total).toBe(40);
  });
  test("the header names the blocked child", () => {
    expect(tileHeader({ blockedBy: [], worker: false, prs: [], children: [kid("ORBIT-1209", "blocked")] })).toMatchObject({ kind: "child-blocked", text: "1 child blocked · ORBIT-1209" });
    expect(tileHeader({ blockedBy: [], worker: false, prs: [], children: [kid("A-1", "blocked"), kid("A-2", "blocked")] }).text).toBe("2 children blocked · A-1");
  });
  test("a blocker of its own still comes first", () => {
    expect(tileHeader({ blockedBy: ["X-1"], worker: false, prs: [], children: [kid("A-1", "blocked")] }).kind).toBe("blocked");
  });
  test("the action opens the blocked child, at once", () => {
    const a = tileAction({ blockedBy: [], worker: false, header: "child-blocked", nextStatus: "Done", writable: false, childKey: "ORBIT-1209" });
    expect(a.primary).toEqual({ kind: "open-child", label: "Open blocked child", key: "ORBIT-1209", disabled: null });
  });
});

describe("the action's own states: Moving… and Move failed · Retry", () => {
  const primary = { kind: "move-next" as const, label: "Move to In review", to: "In review", disabled: null };
  test("rest: the action's label, not busy, no error", () => {
    expect(moveView(undefined, primary)).toEqual({ label: "Move to In review", busy: false, error: null, retryTo: null });
  });
  test("in flight: Moving…, busy, the click does nothing", () => {
    expect(moveView({ phase: "moving", to: "In review" }, primary)).toEqual({ label: "Moving…", busy: true, error: null, retryTo: null });
  });
  test("failed: the reason from the board's own result, and Retry aims at the same status", () => {
    expect(moveView({ phase: "failed", to: "In review", reason: "transition not allowed for this card" }, primary))
      .toEqual({ label: "Move to In review", busy: false, error: "Move failed: transition not allowed for this card", retryTo: "In review" });
  });
  test("a failure is said even when the tile now offers something else", () => {
    const fp = { kind: "flight-plan" as const, label: "Start flight plan", disabled: null };
    expect(moveView({ phase: "failed", to: "X", reason: "no" }, fp).error).toBe("Move failed: no");
  });
  test("a move still running never relabels an action that is not a move", () => {
    const fp = { kind: "flight-plan" as const, label: "Start flight plan", disabled: null };
    expect(moveView({ phase: "moving", to: "X" }, fp).label).toBe("Start flight plan");
  });
});

describe("narrow lane: the ticket drops its second row and the base branch", () => {
  test("232px (the narrow case): number, state and CI only", () => { expect(ticketLayout(232)).toEqual({ facts: false, base: false }); });
  test("the board's 280px comfortable lane keeps everything", () => { expect(ticketLayout(280)).toEqual({ facts: true, base: true }); });
  test("336px keeps everything", () => { expect(ticketLayout(336)).toEqual({ facts: true, base: true }); });
  test("the edge: 259 drops, 260 keeps", () => { expect(ticketLayout(259).facts).toBe(false); expect(ticketLayout(260).facts).toBe(true); });
  test("a width nobody measured keeps everything rather than hiding facts", () => { expect(ticketLayout(0)).toEqual({ facts: true, base: true }); });
});

describe("compactPrChip: the one chip a compact tile keeps", () => {
  const pr = (number: number, state: TilePr["state"] = "OPEN", draft = false) => ({ number, state, draft });
  test("no own PR, no chip", () => { expect(compactPrChip([])).toBeNull(); });
  test("one PR: that PR, nothing more", () => { expect(compactPrChip([pr(7)])).toEqual({ lead: pr(7), more: 0 }); });
  test("several: the open one leads, the rest count as +N", () => {
    const c = compactPrChip([pr(9, "MERGED"), pr(5, "OPEN", true), pr(3), pr(8, "CLOSED")]);
    expect(c?.lead.number).toBe(3);
    expect(c?.more).toBe(3);
  });
});

describe("the PR tickets' CSS", () => {
  const css = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../src/index.css"), "utf8") as string;
  test("a stacked ticket does not take a zero flex basis (it collapsed to a thin line in a column)", () => {
    expect(css).not.toMatch(/\.agx-jt-prs > \.agx-jt-pr \{\s*flex: 1 1 0;/);
    expect(css).toMatch(/\.agx-jt-prs:not\(:has\(\.agx-jt-more\)\) > \.agx-jt-pr \{\s*flex: 0 0 auto;/);
  });
});

describe("tile actions depend on state and owner", () => {
  const b = { blockedBy: [] as string[], worker: false, header: "quiet" as const, nextStatus: null as string | null, writable: true };
  test("a done card offers nothing", () => {
    expect(tileAction({ ...b, done: true, owner: "me" })).toEqual({ primary: null, secondary: null });
  });
  test("somebody else's card offers nothing", () => {
    expect(tileAction({ ...b, owner: "other" })).toEqual({ primary: null, secondary: null });
  });
  test("a card nobody holds offers one action, named for what it does", () => {
    const a = tileAction({ ...b, owner: "nobody" });
    expect(a.primary).toMatchObject({ kind: "assign", label: "Choose an owner" });
    expect(a.secondary).toBeNull();
  });
  test("my card moves to the next status when there is one, and its second action is Hand over", () => {
    const a = tileAction({ ...b, nextStatus: "In review", owner: "me" });
    expect(a.primary).toMatchObject({ kind: "move-next", to: "In review" });
    expect(a.secondary).toMatchObject({ kind: "assign", label: "Hand over" });
  });
  test("an owner unknown keeps today's behaviour", () => {
    expect(tileAction(b).secondary?.label).toBe("Assign");
  });
  test("owner comes from mine, then from the assignee list", () => {
    expect(tileOwner({ mine: true, assignees: ["a"] })).toBe("me");
    expect(tileOwner({ mine: false, assignees: ["b"] })).toBe("other");
    expect(tileOwner({ mine: false, assignees: [] })).toBe("nobody");
  });
  test("a face marked me counts as mine even when the flag is missing", () => {
    expect(tileOwner({ people: [{ me: true }], assignees: ["a"] })).toBe("me");
  });
  test("an unknown account is unknown, never someone else", () => {
    expect(tileOwner({ assignees: ["a"] })).toBeUndefined();
    expect(tileAction({ ...b, nextStatus: "In review", owner: tileOwner({ assignees: ["a"] }) }).primary?.kind).toBe("move-next");
  });
});

describe("a card without the assignee list", () => {
  test("is read as nobody's, never a crash", () => {
    expect(tileOwner({ mine: false })).toBe("nobody");
    expect(tileOwner({})).toBe("nobody");
  });
});
