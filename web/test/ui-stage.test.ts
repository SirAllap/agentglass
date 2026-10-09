/*
 * What a staged request does inside the window, without a renderer: the handler
 * leaves a draft and a request to open the pull request and does nothing else,
 * the mailbox expires, the plan refuses where the screen's own button would not
 * be there, and the "prepared by" mark and the hold behave. The text of the
 * panel itself is held by ui-stage-guard.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { ControlCmd } from "../../shared/types.ts";
import type { UiCtx } from "../src/lib/uiActions.ts";
import type { PrDetail } from "../../shared/types.ts";

const stubGlobal = globalStubs();
stubGlobal("window", new EventTarget());
const stored = new Map<string, string>();
stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k), clear: () => stored.clear(), key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
// Nothing a staging handler does may reach the network: any call is a failure of the test.
const fetched: unknown[] = [];
stubGlobal("fetch", ((...a: unknown[]) => { fetched.push(a); throw new Error("a staging handler must not fetch"); }) as unknown as typeof fetch);

const { runControl } = await import("../src/lib/uiActions.ts");
const { latchStage, peekStage, clearStage, subscribeStage, STAGE_TTL_MS, markPrepared, clearPrepared, preparedFor, preparedSnapshot, subscribePrepared, markedAt } = await import("../src/lib/stageIntent.ts");
const { prJump, clearPrJump } = await import("../src/lib/prJump.ts");
const { planStage } = await import("../src/lib/stagePlan.ts");
const { STAGE_HOLD_MS, preparedLine } = await import("../src/lib/stageHold.ts");

const ui = (id: string, args: Record<string, unknown>) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;
function ctx(as?: string) {
  const calls: unknown[][] = [];
  const c = { goView: (...a: unknown[]) => { calls.push(["goView", ...a]); }, as } as unknown as UiCtx;
  return { c, calls };
}
const ARGS = {
  "pr.merge.stage": { repo: "acme/orbit", number: 42, method: "squash", subject: "Add the thing", body: "Why." },
  "pr.comment.stage": { repo: "acme/orbit", number: 42, body: "Looks right." },
  "pr.review.stage": { repo: "acme/orbit", number: 42, verdict: "approve" },
  "card.move.stage": { repo: "acme/orbit", number: 42, status: "Ready for QA" },
} as const;

beforeEach(() => { clearStage(); clearPrJump(); fetched.length = 0; });
afterEach(() => { clearStage(); clearPrJump(); });

describe("a stage handler", () => {
  for (const id of Object.keys(ARGS) as (keyof typeof ARGS)[]) {
    it(`${id}: latches the draft under the caller's name, asks for the pull request, opens the view, and touches no network`, () => {
      const k = ctx("review-bot");
      expect(runControl(ui(id, ARGS[id]), k.c)).toBe(id);
      const r = peekStage();
      expect(r).toMatchObject({ id, by: "review-bot", a: ARGS[id] });
      expect(prJump()).toMatchObject({ repo: "acme/orbit", number: 42 });
      expect(k.calls).toEqual([["goView", "pr"]]);
      expect(fetched).toEqual([]);
    });
  }

  it("a caller with no name is shown as 'an agent', never as nothing", () => {
    runControl(ui("pr.comment.stage", ARGS["pr.comment.stage"]), ctx().c);
    expect(peekStage()?.by).toBe("an agent");
  });

  it("a frame with a bad argument runs nothing and latches nothing (the window's second look)", () => {
    const k = ctx("x");
    expect(runControl(ui("pr.comment.stage", { repo: "acme/orbit", number: 42, body: "a‮b" }), k.c)).toBeNull();
    expect(runControl(ui("pr.merge.stage", { ...ARGS["pr.merge.stage"], method: "force" }), k.c)).toBeNull();
    expect(peekStage()).toBeNull();
    expect(k.calls).toEqual([]);
  });

  it("the second request replaces the first and has a higher number", () => {
    runControl(ui("pr.comment.stage", ARGS["pr.comment.stage"]), ctx("a").c);
    const first = peekStage()!;
    runControl(ui("pr.comment.stage", ARGS["pr.comment.stage"]), ctx("b").c);
    expect(peekStage()!.n).toBeGreaterThan(first.n);
    expect(peekStage()!.by).toBe("b");
  });
});

describe("the mailbox", () => {
  it("expires: a request nobody was there for does not open at the next visit", () => {
    latchStage({ id: "pr.comment.stage", a: ARGS["pr.comment.stage"] }, "x");
    const at = peekStage()!.at;
    expect(peekStage(at + STAGE_TTL_MS)).not.toBeNull();
    expect(peekStage(at + STAGE_TTL_MS + 1)).toBeNull();
  });
  it("is cleared by the panel, and subscribers hear both", () => {
    let heard = 0;
    const off = subscribeStage(() => { heard++; });
    latchStage({ id: "pr.comment.stage", a: ARGS["pr.comment.stage"] }, "x");
    clearStage();
    off();
    expect(heard).toBe(2);
    expect(peekStage()).toBeNull();
  });
  it("one failing subscriber does not stop the rest", () => {
    let ok = false;
    const a = subscribeStage(() => { throw new Error("boom"); });
    const b = subscribeStage(() => { ok = true; });
    latchStage({ id: "pr.comment.stage", a: ARGS["pr.comment.stage"] }, "x");
    a(); b();
    expect(ok).toBe(true);
  });
});

describe("the prepared mark", () => {
  it("is per box, replaced by a newer one, cleared on send, and announced", () => {
    let heard = 0;
    const off = subscribePrepared(() => { heard++; });
    const v0 = preparedSnapshot();
    markPrepared("say|u", "bot");
    const a = preparedFor("say|u")!;
    expect(a.by).toBe("bot");
    markPrepared("say|u", "bot2");
    expect(preparedFor("say|u")!.n).toBeGreaterThan(a.n);
    expect(preparedFor("review|u")).toBeNull();
    clearPrepared("say|u");
    clearPrepared("say|u");
    off();
    expect(preparedFor("say|u")).toBeNull();
    expect(heard).toBe(3);
    expect(preparedSnapshot()).toBeGreaterThan(v0);
  });
  it("the mark is written next to the text (it survives a reload) and removed with it", () => {
    markPrepared("say|persist", "bot");
    expect(JSON.parse(stored.get("agentglass.pr.prepared") ?? "{}")).toMatchObject({ "say|persist": "bot" });
    clearPrepared("say|persist");
    expect(JSON.parse(stored.get("agentglass.pr.prepared") ?? "{}")).not.toHaveProperty("say|persist");
  });
  it("a box keyed on markedAt does not remount when its mark is cleared (a send, a dismiss), only when a new one arrives", () => {
    expect(markedAt("say|key")).toBe(0);
    markPrepared("say|key", "bot");
    const first = markedAt("say|key");
    expect(first).toBeGreaterThan(0);
    clearPrepared("say|key");
    expect(markedAt("say|key")).toBe(first);
    markPrepared("say|key", "bot");
    expect(markedAt("say|key")).toBeGreaterThan(first);
  });
  it("the line names the sender as a label in quotes and says nothing is sent until the person presses", () => {
    const l = preparedLine("bot");
    expect(l).toContain('"bot"');
    expect(l).toContain("an agent");
    expect(l).toContain("nothing is sent until you press");
  });
  it("the hold is about a second", () => expect(STAGE_HOLD_MS).toBeGreaterThanOrEqual(800));
});

describe("planStage: only where the screen's own button would be there", () => {
  const open = { number: 42, state: "OPEN", mergeState: "CLEAN", mergeable: "MERGEABLE", baseRefName: "main", viewerDidAuthor: false, mergePolicy: undefined, threads: [], checksAll: [] } as unknown as PrDetail;
  const req = (id: keyof typeof ARGS) => ({ id, a: ARGS[id], by: "bot", n: 1, at: 0 }) as never;
  it("an open, mergeable pull request takes all four", () => {
    for (const id of Object.keys(ARGS) as (keyof typeof ARGS)[]) expect(planStage(req(id), open), id).toMatchObject({ ok: true });
  });
  it("a closed or merged pull request takes none, and says so", () => {
    for (const state of ["CLOSED", "MERGED"]) for (const id of Object.keys(ARGS) as (keyof typeof ARGS)[]) {
      const p = planStage(req(id), { ...open, state } as never);
      expect(p.ok, `${state} ${id}`).toBe(false);
      expect((p as { why: string }).why).toContain("not open");
    }
  });
  it("a merge is not staged while GitHub would not merge it", () => {
    for (const mergeState of ["DIRTY", "BLOCKED", "BEHIND", "DRAFT", "UNKNOWN"]) {
      expect(planStage(req("pr.merge.stage"), { ...open, mergeState } as never).ok, mergeState).toBe(false);
    }
    expect(planStage(req("pr.comment.stage"), { ...open, mergeState: "DIRTY" } as never).ok).toBe(true);
  });
  it("a merge is not staged where the screen's own button is refused: a freeze, no permission, a conflict, a draft", () => {
    for (const patch of [
      { gate: { permission: "READ" } }, { gate: { permission: "TRIAGE" } }, { gate: { locked: true, permission: "WRITE" } },
      { mergeable: "CONFLICTING" }, { isDraft: true },
    ]) {
      const p = planStage(req("pr.merge.stage"), { ...open, ...patch } as never);
      expect(p.ok, JSON.stringify(patch)).toBe(false);
      expect((p as { why: string }).why).toContain("cannot be merged from here");
    }
    // The same pull request still takes a comment and a review.
    expect(planStage(req("pr.comment.stage"), { ...open, gate: { permission: "READ" } } as never).ok).toBe(true);
  });
  it("a method the repository forbids is not staged", () => {
    const p = planStage(req("pr.merge.stage"), { ...open, mergePolicy: { allowed: ["merge"], auto: false, deletesBranch: false } } as never);
    expect(p.ok).toBe(false);
    expect((p as { why: string }).why).toContain("squash");
  });
  it("one's own pull request cannot be reviewed", () => {
    expect(planStage(req("pr.review.stage"), { ...open, viewerDidAuthor: true } as never).ok).toBe(false);
    expect(planStage(req("pr.comment.stage"), { ...open, viewerDidAuthor: true } as never).ok).toBe(true);
  });
});
