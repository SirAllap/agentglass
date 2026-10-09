/*
 * The Unstick step machine: close, wait until closed, reopen, wait until open and
 * following its branch, with the linked card read before and after. Every
 * failure point is a test, and each says what state the pull request was left in,
 * because "stopped" is not enough when the state is "closed".
 */
import { describe, expect, test } from "bun:test";
import {
  runUnstick, cardMove, cardSentence, CLOSED_WAIT_MS, SYNC_WAIT_MS,
  type CardReading, type Look, type StepNote, type UnstickDeps, type UnstickFacts,
} from "../../shared/unstick.ts";

const OLD = "c".repeat(40);
const NEW = "e".repeat(40);
const facts: UnstickFacts = {
  state: "OPEN", isDraft: false, author: true, canWrite: true, crossRepo: false, checksRunning: false,
  autoMerge: false, inMergeQueue: false, changesRequested: false, baseLocked: false,
  headSha: OLD, refSha: NEW, mergeState: "UNKNOWN",
};
type Ok = Extract<Look, { ok: true }>;
const open = (head = OLD, ref: string | null = NEW): Ok => ({ ok: true, state: "OPEN", headSha: head, refSha: ref, mergeState: "UNKNOWN" });
const closed = (): Ok => ({ ok: true, state: "CLOSED", headSha: OLD, refSha: NEW, mergeState: "UNKNOWN" });
const card = (status: string, updated = 1): CardReading => ({ id: "86abc", label: "ORBIT-1042", status, updated });

interface Script {
  full?: Look;
  /** Light looks in order; the last one repeats. */
  looks?: Look[];
  close?: { ok: boolean; error?: string };
  reopen?: { ok: boolean; error?: string };
  cards?: ({ ok: true; card: CardReading } | { ok: false; error: string })[] | null;
}

function rig(s: Script) {
  let t = 0;
  const calls: string[] = [];
  const cards = s.cards === undefined ? null : s.cards;
  let ci = 0;
  let li = 0;
  const deps: UnstickDeps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    look: async (full) => {
      calls.push(full ? "look-full" : "look");
      if (full) return s.full ?? { ...open(), facts };
      const ls = s.looks ?? [open()];
      return ls[Math.min(li++, ls.length - 1)]!;
    },
    card: cards ? async () => { calls.push("card"); return cards[Math.min(ci++, cards.length - 1)]!; } : null,
    close: async () => { calls.push("close"); return s.close ?? { ok: true }; },
    reopen: async () => { calls.push("reopen"); return s.reopen ?? { ok: true }; },
  };
  const notes: StepNote[] = [];
  return { deps, calls, notes, run: () => runUnstick(deps, (n) => notes.push(n)), clock: () => t };
}
const okFull = (over: Partial<UnstickFacts> = {}): Look => ({ ...open(), facts: { ...facts, ...over } });
const synced = open(NEW, NEW);

describe("runUnstick: the path that works", () => {
  test("close, closed, reopen, synced, card read before and after", async () => {
    const r = rig({ full: okFull(), looks: [closed(), synced], cards: [{ ok: true, card: card("QA COMPLETE") }, { ok: true, card: card("QA COMPLETE", 2) }] });
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.calls).toEqual(["look-full", "card", "close", "look", "reopen", "look", "card"]);
    expect(r.notes.filter((n) => n.status === "done").map((n) => n.step)).toEqual(["check", "card", "close", "closed", "reopen", "synced", "card-after"]);
    if (out.ok) expect(out.card.changed).toBe(false);
  });
  test("no linked card: the card steps are skipped, not failed", async () => {
    const r = rig({ full: okFull(), looks: [closed(), synced], cards: null });
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.notes.filter((n) => n.status === "skipped").map((n) => n.step)).toEqual(["card", "card-after"]);
  });
  test("waits while GitHub is slow: not closed on the first read, not synced on the first read", async () => {
    const r = rig({ full: okFull(), looks: [open(), open(), closed(), open(OLD, NEW), open(OLD, NEW), synced] });
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.calls.filter((c) => c === "look").length).toBe(6);
    expect(r.clock()).toBeGreaterThan(0);
  });
  test("the card moved while it was closed: the outcome says from what to what", async () => {
    const r = rig({ full: okFull(), looks: [closed(), synced], cards: [{ ok: true, card: card("QA COMPLETE") }, { ok: true, card: card("IN PROGRESS", 9) }] });
    const out = await r.run();
    expect(out.ok && out.card).toEqual({ changed: true, from: "QA COMPLETE", to: "IN PROGRESS" });
    expect(cardSentence("ORBIT-1042", { changed: true, from: "QA COMPLETE", to: "IN PROGRESS" })).toContain("moved from QA COMPLETE to IN PROGRESS");
  });
});

describe("runUnstick: every failure point stops there and says what was left", () => {
  test("check: the read fails -> nothing changed, close never called", async () => {
    const r = rig({ full: { ok: false, error: "boom" } });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "check", pr: "open" });
    expect(r.calls).toEqual(["look-full"]);
  });
  test("check: no facts in the answer -> nothing changed", async () => {
    const r = rig({ full: open() });
    expect(await r.run()).toMatchObject({ ok: false, at: "check" });
    expect(r.calls).not.toContain("close");
  });
  test("check: it no longer looks stuck (fresh read) -> nothing closed, with the reason", async () => {
    const r = rig({ full: okFull({ refSha: OLD, mergeState: "CLEAN" }) });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "check", pr: "open" });
    if (!out.ok) expect(out.sentence).toContain("Nothing was changed");
    expect(r.calls).toEqual(["look-full"]);
  });
  test("check: branch ahead but mergeability decided since the panel looked -> refused, nothing closed", async () => {
    const r = rig({ full: okFull({ mergeState: "BEHIND" }) });
    expect(await r.run()).toMatchObject({ ok: false, at: "check", pr: "open", closeSent: false });
    expect(r.calls).not.toContain("close");
  });
  for (const [name, over] of [
    ["a check started running", { checksRunning: true }], ["auto-merge was armed", { autoMerge: true }],
    ["it went to the queue", { inMergeQueue: true }], ["it became a draft", { isDraft: true }],
    ["changes were requested", { changesRequested: true }],
  ] as const) {
    test(`check: ${name} since the panel looked -> refused before any close`, async () => {
      const r = rig({ full: okFull(over) });
      expect(await r.run()).toMatchObject({ ok: false, at: "check" });
      expect(r.calls).not.toContain("close");
    });
  }
  test("card: linked but unreadable before -> stops before closing", async () => {
    const r = rig({ full: okFull(), cards: [{ ok: false, error: "ClickUp 429" }] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "card", pr: "open" });
    expect(r.calls).toEqual(["look-full", "card"]);
  });
  test("close refused, still open -> nothing changed", async () => {
    const r = rig({ full: okFull(), looks: [open()], close: { ok: false, error: "GraphQL: not allowed" } });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "close", pr: "open" });
    if (!out.ok) expect(out.sentence).toContain("nothing was changed");
    expect(r.calls).not.toContain("reopen");
  });
  test("close reported a failure but the pull request IS closed -> says closed, reads the card after", async () => {
    const r = rig({ full: okFull(), looks: [closed()], close: { ok: false, error: "timeout" }, cards: [{ ok: true, card: card("QA COMPLETE") }, { ok: true, card: card("TO DO", 5) }] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "close", pr: "closed" });
    if (!out.ok) expect(out.card.changed).toBe(true);
  });
  test("close reported a failure and the state cannot be read -> unknown", async () => {
    const r = rig({ full: okFull(), looks: [{ ok: false, error: "net" }], close: { ok: false, error: "timeout" } });
    expect(await r.run()).toMatchObject({ ok: false, at: "close", pr: "unknown" });
  });
  test("closed wait: GitHub never reports closed in time, last read still open -> pr open, no reopen", async () => {
    const r = rig({ full: okFull(), looks: [open()] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "closed", pr: "open" });
    expect(r.calls).not.toContain("reopen");
    expect(r.clock()).toBeLessThanOrEqual(CLOSED_WAIT_MS);
  });
  test("closed wait: reads keep failing -> stops as unreadable, pr unknown", async () => {
    const r = rig({ full: okFull(), looks: [{ ok: false, error: "net" }] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "closed", pr: "unknown" });
    if (!out.ok) expect(out.sentence).toContain("could not be read");
  });
  test("closed wait: one blip in the reads does not stop it", async () => {
    const r = rig({ full: okFull(), looks: [{ ok: false, error: "blip" }, closed(), synced] });
    expect((await r.run()).ok).toBe(true);
  });
  test("reopen fails -> pull request closed, says so, card read after", async () => {
    const r = rig({ full: okFull(), looks: [closed()], reopen: { ok: false, error: "branch protection" }, cards: [{ ok: true, card: card("QA COMPLETE") }, { ok: true, card: card("TO DO", 5) }] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "reopen", pr: "closed" });
    if (!out.ok) { expect(out.sentence).toContain("is closed and could not be reopened"); expect(out.card.to).toBe("TO DO"); }
    expect(r.calls).not.toContain("look-synced");
  });
  test("sync wait: open again but the head never follows the branch -> open, timeout after two minutes", async () => {
    const r = rig({ full: okFull(), looks: [closed(), open(OLD, NEW)] });
    const out = await r.run();
    expect(out).toMatchObject({ ok: false, at: "synced", pr: "open" });
    expect(r.clock()).toBeLessThanOrEqual(CLOSED_WAIT_MS + SYNC_WAIT_MS);
    expect(r.clock()).toBeGreaterThanOrEqual(SYNC_WAIT_MS - 5000);
    if (!out.ok) expect(out.sentence).toContain("did not point it at the branch");
  });
  test("sync wait: still closed after the reopen -> pr closed", async () => {
    const r = rig({ full: okFull(), looks: [closed()] });
    expect(await r.run()).toMatchObject({ ok: false, at: "synced", pr: "closed" });
  });
  test("sync wait: reads fail -> unknown", async () => {
    const r = rig({ full: okFull(), looks: [closed(), { ok: false, error: "x" }] });
    expect(await r.run()).toMatchObject({ ok: false, at: "synced", pr: "unknown" });
  });
  test("a ref that cannot be read is never 'synced'", async () => {
    const r = rig({ full: okFull(), looks: [closed(), open(OLD, null)] });
    expect(await r.run()).toMatchObject({ ok: false, at: "synced" });
  });
  test("card after cannot be read: the run still succeeded, and says to check", async () => {
    const r = rig({ full: okFull(), looks: [closed(), synced], cards: [{ ok: true, card: card("QA COMPLETE") }, { ok: false, error: "429" }] });
    const out = await r.run();
    expect(out.ok).toBe(true);
    expect(r.notes.find((n) => n.step === "card-after" && n.status === "failed")?.text).toContain("Check its status yourself");
    if (out.ok) expect(out.card.changed).toBe(false);
  });
  test("a throwing dependency is a failure at that step, not an unhandled rejection", async () => {
    const r = rig({ full: okFull(), looks: [closed(), synced] });
    r.deps.close = async () => { throw new Error("socket closed"); };
    expect(await runUnstick(r.deps, () => {})).toMatchObject({ ok: false, at: "close" });
  });
});

describe("runUnstick: closeSent says whether automations could have fired", () => {
  test("stopped before any close: false", async () => {
    expect(await rig({ full: okFull({ isDraft: true }) }).run()).toMatchObject({ ok: false, closeSent: false });
    expect(await rig({ full: okFull(), looks: [open()], close: { ok: false, error: "no" } }).run()).toMatchObject({ ok: false, at: "close", closeSent: false });
  });
  test("open again but never followed its branch: still true, the close went out", async () => {
    expect(await rig({ full: okFull(), looks: [closed(), open(OLD, NEW)] }).run()).toMatchObject({ ok: false, at: "synced", pr: "open", closeSent: true });
  });
  test("accepted close that GitHub still shows open: true", async () => {
    expect(await rig({ full: okFull(), looks: [open()] }).run()).toMatchObject({ ok: false, at: "closed", pr: "open", closeSent: true });
  });
});

describe("cardMove", () => {
  test("same status in another case is not a move; a different one is", () => {
    expect(cardMove(card("QA Complete"), card("qa complete ")).changed).toBe(false);
    expect(cardMove(card("QA COMPLETE"), card("TO DO"))).toEqual({ changed: true, from: "QA COMPLETE", to: "TO DO" });
  });
  test("a missing reading on either side is never a move", () => {
    expect(cardMove(null, card("TO DO")).changed).toBe(false);
    expect(cardMove(card("TO DO"), null).changed).toBe(false);
  });
});
