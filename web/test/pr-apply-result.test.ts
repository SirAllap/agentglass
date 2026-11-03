import { describe, expect, test } from "bun:test";
import { applyResult, CLOSE_AFTER_MS, startSteps, type Outcomes } from "../src/lib/prApplyResult.ts";
import { handOverPlan, type HandOverInput } from "../src/lib/prHandOver.ts";

// Hand-over of a pull request by dana-r to mara-k, with its ORBIT-1042 card in ClickUp.
const base: HandOverInput = {
  mode: "reviewers", handOver: true, author: "dana-r", picked: ["mara-k"],
  tracker: { kind: "clickup", card: "ORBIT-1042", status: "in progress" },
  card: { mirror: true, people: [], status: "in review" },
};
const plan = handOverPlan(base);
const ok = { state: "ok" } as const;
const busy = { state: "busy" } as const;

describe("before and while it runs", () => {
  test("nothing started: no rows, Done as the plan left it", () => {
    const r = applyResult(plan, {});
    expect(r).toMatchObject({ phase: "idle", rows: [], retry: [], locked: false, closeAfterMs: null, toast: null });
    expect(r.done).toEqual({ label: "Hand over", disabled: false });
  });
  test("running: one row per system, spinner on both, Done is Working… and the list is locked", () => {
    const r = applyResult(plan, startSteps({}, plan.steps.map((s) => s.id)));
    expect(r.phase).toBe("working");
    expect(r.rows.map((x) => [x.label, x.state])).toEqual([["GitHub", "busy"], ["ClickUp", "busy"]]);
    expect(r.done).toEqual({ label: "Working…", disabled: true });
    expect(r.locked).toBe(true);
    expect(r.closeAfterMs).toBeNull();
  });
  test("the step text is the row's small line, without the system repeated", () => {
    const r = applyResult(plan, startSteps({}, plan.steps.map((s) => s.id)));
    expect(r.rows.map((x) => x.text)).toEqual(["Request mara-k", "Assign mara-k · move to in review"]);
  });
  test("one answer in, one still out: still working", () => {
    const r = applyResult(plan, { "gh-reviewers": ok, "card-assign": busy, "card-status": busy });
    expect(r.phase).toBe("working");
    expect(r.rows.map((x) => x.state)).toEqual(["ok", "busy"]);
  });
});

describe("everything passed", () => {
  const all: Outcomes = { "gh-reviewers": ok, "card-assign": ok, "card-status": ok };
  test("closes after half a second and toasts the plan", () => {
    const r = applyResult(plan, all);
    expect(r).toMatchObject({ phase: "done", closeAfterMs: CLOSE_AFTER_MS, retry: [] });
    expect(CLOSE_AFTER_MS).toBe(500);
    expect(r.toast).toBe("Request mara-k on GitHub · assign mara-k on ClickUp · move to in review");
  });
});

describe("partial failure", () => {
  test("the card fails after GitHub passed: the card row offers to retry only itself", () => {
    const r = applyResult(plan, { "gh-reviewers": ok, "card-assign": { state: "fail", status: 503 }, "card-status": { state: "fail", status: 503 } });
    expect(r.phase).toBe("partial");
    expect(r.rows[0]).toMatchObject({ label: "GitHub", state: "ok", retry: [], retryLabel: null });
    expect(r.rows[1]).toMatchObject({
      label: "ClickUp", state: "fail", retryLabel: "Retry only ClickUp",
      text: "ClickUp answered 503. Nothing was changed on the card.",
    });
    expect(r.retry).toEqual(["card-assign", "card-status"]);
  });
  test("GitHub fails after the card passed: never sends the card again", () => {
    const r = applyResult(plan, { "gh-reviewers": { state: "fail" }, "card-assign": ok, "card-status": ok });
    expect(r.rows[0]).toMatchObject({ state: "fail", text: "GitHub did not answer.", retryLabel: "Retry only GitHub" });
    expect(r.retry).toEqual(["gh-reviewers"]);
  });
  test("Done stays off as Working…, the picker stays open, nothing is toasted", () => {
    const r = applyResult(plan, { "gh-reviewers": ok, "card-assign": { state: "fail" }, "card-status": ok });
    expect(r.done).toEqual({ label: "Working…", disabled: true });
    expect(r).toMatchObject({ closeAfterMs: null, toast: null, locked: true });
  });
  test("inside the card row, the step that passed is not retried and the line says so", () => {
    const r = applyResult(plan, { "gh-reviewers": ok, "card-assign": ok, "card-status": { state: "fail", status: 502 } });
    expect(r.rows[1].retry).toEqual(["card-status"]);
    expect(r.rows[1].text).toBe("ClickUp answered 502. Already done: assign mara-k on ClickUp.");
    expect(r.retry).toEqual(["card-status"]);
  });
  test("while the other row is still out, a failure waits: it is not partial yet", () => {
    const r = applyResult(plan, { "gh-reviewers": { state: "fail" }, "card-assign": busy, "card-status": busy });
    expect(r.phase).toBe("working");
    expect(r.rows[0].retryLabel).toBe("Retry only GitHub");
  });
  test("every row failed: the same rows, each with its own retry", () => {
    const r = applyResult(plan, { "gh-reviewers": { state: "fail" }, "card-assign": { state: "fail" }, "card-status": { state: "fail" } });
    expect(r.phase).toBe("failed");
    expect(r.retry).toEqual(["gh-reviewers", "card-assign", "card-status"]);
  });
});

describe("retrying", () => {
  test("starting a retry sets only the failed steps busy and keeps the passed outcomes", () => {
    const out: Outcomes = { "gh-reviewers": ok, "card-assign": { state: "fail" }, "card-status": { state: "fail" } };
    const next = startSteps(out, applyResult(plan, out).retry);
    expect(next["gh-reviewers"]).toEqual(ok);
    expect(next["card-assign"]).toEqual(busy);
    expect(out["card-assign"]).toEqual({ state: "fail" });
    const r = applyResult(plan, next);
    expect(r.phase).toBe("working");
    expect(r.rows.map((x) => x.state)).toEqual(["ok", "busy"]);
  });
  test("a retry that passes finishes the whole thing", () => {
    expect(applyResult(plan, { "gh-reviewers": ok, "card-assign": ok, "card-status": ok }).phase).toBe("done");
  });
});

describe("a plan with GitHub only", () => {
  test("one row, and it closes when it passes", () => {
    const only = handOverPlan({ ...base, tracker: { kind: null } });
    const r = applyResult(only, { "gh-reviewers": ok });
    expect(r.rows.map((x) => x.label)).toEqual(["GitHub"]);
    expect(r.phase).toBe("done");
    expect(r.toast).toBe("Request mara-k on GitHub");
  });
  test("an empty plan never reads as done", () => {
    const none = handOverPlan({ ...base, picked: [], card: { mirror: true, people: [], status: null } });
    expect(applyResult(none, {})).toMatchObject({ phase: "idle", rows: [], done: { disabled: true } });
  });
});

describe("what a refusal in words says", () => {
  test("a card that changed underneath says so, in the service's own sentence", () => {
    const r = applyResult(plan, { "gh-reviewers": ok, "card-assign": { state: "fail", error: "somebody changed this card while you had it open." }, "card-status": { state: "fail", error: "somebody changed this card while you had it open." } });
    expect(r.rows[1]!.text).toBe("ClickUp said: somebody changed this card while you had it open. Nothing was changed on the card.");
  });
  test("a status code wins over a sentence", () => {
    const r = applyResult(plan, { "gh-reviewers": { state: "fail", status: 503, error: "x" }, "card-assign": busy, "card-status": busy });
    expect(r.rows[0]!.text).toBe("GitHub answered 503.");
  });
});
