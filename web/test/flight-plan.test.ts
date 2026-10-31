import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  canGo, capStop, goBlocker, groupPlans, historyRows, lineDiff, matches, needsYou, needsYouPlan, nogoReason, openCount, pollRows, splitPlan, stationStates, subline, titleFrom, toPlan, when,
  type Finding, type Plan, type PlanDetail, type Run,
} from "../src/lib/flightPlan.ts";

const plan = (o: Partial<Plan> = {}): Plan => ({
  id: "fp_1", root: "/home/x/orbit", title: "Retry webhooks", request: "r", visual: false, planMd: "# Goal\nRetry.", planBytes: 12, mockups: [], state: "ready",
  decision: null, preflightRunId: null, taskId: null, autoRuns: 0, launched: null, reviewRounds: 0, stopReason: null, question: null, queued: false, createdBy: null, landedAt: null, lastReport: null, size: "M", createdAt: 1, updatedAt: 2, ...o,
});
const finding = (id: string, severity: Finding["severity"], action: Finding["action"] = null): Finding => ({ id, severity, title: "t", quote: "q", evidence: "e", action, note: null });
const run = (o: Partial<Run> = {}, fs: Finding[] = []): Run => ({
  id: "pf_1", createdAt: 1, root: "/home/x/orbit", moment: "before-launch", state: "done", requestedBy: "a", input: { files: ["/a"] }, error: null, taskId: null,
  certificate: { id: "pf_1", createdAt: 5, model: "sonnet", costUsd: 0.21, files: [{ path: "/a/plan.md", sha256: "9f2c", bytes: 2100 }], mockups: [], skipped: [], sawConversation: false, isolation: "x", findings: fs }, ...o,
});

describe("Go is about the plan, never the findings", () => {
  test("open blockers do not switch Go off", () => {
    const r = run({}, [finding("F1", "blocker"), finding("F2", "major", "ask")]);
    expect(openCount(r)).toBe(2);
    expect(canGo(plan())).toBe(true);
    expect(goBlocker(plan({ state: "ready", preflightRunId: r.id }))).toBeNull();
  });
  test("an empty plan, or a visual one with no mockup, has no Go", () => {
    expect(canGo(plan({ planMd: "", planBytes: 0 }))).toBe(false);
    expect(goBlocker(plan({ visual: true }))).toMatch(/mockup/);
    expect(canGo(plan({ visual: true, mockups: [{ path: "/m.png", kind: "image" }] }))).toBe(true);
  });
  test("a launched or sent-back plan cannot go again", () => {
    expect(canGo(plan({ state: "launched" }))).toBe(false);
    expect(canGo(plan({ state: "no-go" }))).toBe(false);
  });
  test("a plan that is Go but did not launch can try again", () => expect(canGo(plan({ state: "go" }))).toBe(true));
  test("No-go needs a reason", () => { expect(nogoReason("  ")).toBeNull(); expect(nogoReason(" split it ")).toBe("split it"); });
});

describe("trajectory", () => {
  test("the current station is the first that is neither done nor skipped", () => {
    expect(stationStates(plan({ planMd: "", planBytes: 0 }), null, true)).toEqual(["done", "cur", "skip", "todo", "todo", "todo", "todo"]);
    expect(stationStates(plan(), null, true)).toEqual(["done", "done", "skip", "cur", "todo", "todo", "todo"]);
    expect(stationStates(plan(), run({}, [finding("F1", "nit")]), true)).toEqual(["done", "done", "skip", "done", "cur", "todo", "todo"]);
    expect(stationStates(plan(), run({}, [finding("F1", "nit", "fix")]), true)).toEqual(["done", "done", "skip", "done", "done", "cur", "todo"]);
  });
  test("Preflight off skips both review stations; a visual plan waits at its mockup", () => {
    expect(stationStates(plan(), null, false)).toEqual(["done", "done", "skip", "skip", "skip", "cur", "todo"]);
    expect(stationStates(plan({ visual: true }), null, true)[2]).toBe("cur");
  });
  test("a launched plan is all done", () => expect(stationStates(plan({ state: "launched" }), run(), true).includes("cur")).toBe(false));
  test("a running Preflight is the current station", () => expect(stationStates(plan(), run({ state: "running", certificate: null }), true)[3]).toBe("cur"));
});

describe("the list", () => {
  const d = (p: Partial<Plan>, r: Run | null = null): PlanDetail => ({ plan: plan(p), run: r });
  test("groups: ready is awaiting Go, a running review or a draft is in progress, launched is launched, No-go is History only", () => {
    const g = groupPlans([d({ id: "a" }), d({ id: "b", state: "draft" }), d({ id: "c" }, run({ state: "running", certificate: null })), d({ id: "e", state: "launched" }), d({ id: "f", state: "no-go" })]);
    expect(g.awaiting.map((x) => x.plan.id)).toEqual(["a"]);
    expect(g.progress.map((x) => x.plan.id)).toEqual(["b", "c"]);
    expect(g.launched.map((x) => x.plan.id)).toEqual(["e"]);
  });
  test("the top bar says what waits", () => {
    expect(needsYou([])).toBeNull();
    expect(needsYou([d({})])).toBe("flight plan awaiting Go");
    expect(needsYou([d({}), d({ id: "z" })])).toBe("2 flight plans awaiting Go");
  });
  test("an open question or a refused plan raises the chip too, and the chip opens it", () => {
    const asking = d({ id: "q", state: "launched", updatedAt: 50, question: { id: "q1", by: "coordinator:orbit", at: 1, text: "Card or log?", choices: ["Card", "Log"], recommended: 0, answer: null } } as never);
    const refused = d({ id: "r", state: "launched", stopReason: "sensitive-diff", updatedAt: 5 } as never);
    expect(needsYou([asking])).toBe("flight plan needs you");
    expect(needsYou([asking, refused])).toBe("2 flight plans need you");
    expect(needsYouPlan([asking, refused])).toBe("r");
    expect(needsYou([d({ id: "z", state: "launched" } as never)])).toBeNull();
  });
  test("sublines", () => {
    expect(subline(plan({ state: "draft" }), null, 10)).toBe("writing the plan");
    expect(subline(plan({ taskId: "ORBIT-1042" }), run({}, [finding("F1", "major", "ask")]), 10)).toBe("ORBIT-1042 · M · 1 asks you");
  });
  test("filter and title", () => {
    expect(matches(plan(), "webhook")).toBe(true); expect(matches(plan(), "zzz")).toBe(false);
    expect(titleFrom("Cap deliveries per tenant\nmore")).toBe("Cap deliveries per tenant");
    expect(titleFrom("")).toBe("New flight plan");
    expect(titleFrom("x ".repeat(80)).length).toBeLessThanOrEqual(81);
  });
});

describe("history and the poll", () => {
  test("plans at Go or No-go, and checked tasks, newest first; open plans are not there", () => {
    const rows = historyRows(
      [{ plan: plan({ id: "a", state: "launched", launched: { at: 300, title: "t" } }), run: run() }, { plan: plan({ id: "b" }), run: null }, { plan: plan({ id: "c", state: "no-go", decision: { by: "p", at: 200, reason: "x" } }), run: null }],
      [run({ id: "pf_9", moment: "task-done", createdAt: 100 })],
    );
    expect(rows.map((r) => [r.key, r.verdict])).toEqual([["a", "go"], ["c", "no-go"], ["pf_9", "checked"]]);
  });
  test("findings show as advisory, never as a hold", () => {
    const rows = pollRows(plan(), run({}, [finding("F1", "blocker"), finding("F2", "nit", "fix")]), 0.5);
    expect(rows.find((r) => r.k === "Findings")).toEqual({ k: "Findings", v: "1 of 2 answered · they never block Go", light: "skip" });
    expect(rows.some((r) => r.light === "hold")).toBe(false);
  });
  test("wire shapes in either spelling", () => {
    expect(toPlan({ id: "x", plan_md: "hi", mockups: "[{\"path\":\"/m.png\",\"kind\":\"image\"}]", visual: 1, size: "L" })).toMatchObject({ planMd: "hi", visual: true, size: "L", mockups: [{ path: "/m.png" }] });
    expect(toPlan({ id: "x", planMd: "", planBytes: 40 }).planBytes).toBe(40);
  });
  test("dates", () => {
    const n = new Date(2026, 9, 27, 12).getTime();
    expect(when(n, n)).toBe("today"); expect(when(n - 86_400_000, n)).toBe("yesterday"); expect(when(new Date(2026, 9, 24, 9).getTime(), n)).toBe("Sat 24");
  });
});

describe("the plan fold", () => {
  test("two sections shown, the rest named", () => {
    const s = splitPlan("# Goal\na\n## Behaviour\nb\n## Out of scope\nc\n## Tests\nd\n## Rollback\ne");
    expect(s.head).toContain("Behaviour"); expect(s.head).not.toContain("Tests");
    expect(s.rest.map((r) => r.title)).toEqual(["Out of scope", "Tests", "Rollback"]);
  });
  test("a heading inside a code fence is not a section; no headings, nothing to fold", () => {
    expect(splitPlan("# A\n```\n# not\n```\n# B\nx\n# C\ny").rest.map((r) => r.title)).toEqual(["C"]);
    expect(splitPlan("just text").rest).toEqual([]);
  });
});

describe("the plan against an earlier version", () => {
  test("lines kept, added and removed come out in reading order", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "x" }, { kind: "same", text: "c" }, { kind: "add", text: "d" },
    ]);
    expect(lineDiff("same", "same").every((r) => r.kind === "same")).toBe(true);
  });
  test("past the ceiling it says everything changed instead of building the table", () => {
    const big = Array.from({ length: 2001 }, (_, i) => `l${i}`).join("\n");
    const d = lineDiff(big, "x");
    expect(d.filter((r) => r.kind === "del")).toHaveLength(2001);
    expect(d.filter((r) => r.kind === "add")).toHaveLength(1);
  });
});

describe("capStop", () => {
  test("a run the cap stopped gives what it spent, its own cap and the one-off to offer", () => {
    const r = run({ state: "failed", certificate: null, error: "stopped at the cap: spent $0.52 of $0.50", input: { budgetUsd: 0.5, files: ["/a.md", "/b.md"] } });
    expect(capStop(r, 2)).toEqual({ spent: 0.52, cap: 0.5, files: 2, once: 1 });
  });
  test("the one-off stops at the server's $5, and an older error without the amount still counts", () => {
    expect(capStop(run({ state: "failed", certificate: null, error: "exceeded budget", input: { budgetUsd: 4 } }), 0.5)).toEqual({ spent: null, cap: 4, files: 0, once: 5 });
  });
  test("any other failure is not a cap stop", () => {
    expect(capStop(run({ state: "failed", certificate: null, error: "the reviewer gave no JSON (exit 1)" }), 0.5)).toBeNull();
    expect(capStop(run(), 0.5)).toBeNull();
    expect(capStop(null, 0.5)).toBeNull();
  });
});

describe("what the plans list adds to a plan", () => {
  test("reviewedVersion, the builder's tab and the slots come off the wire; a made-up builder does not", () => {
    const p = toPlan({ id: "x", reviewedVersion: 2, builder: "gone", goneAt: 1000, stateSince: 900, slotHolders: [{ id: "fp_1", title: "Cache avatar lookups" }, { nope: 1 }] });
    expect(p).toMatchObject({ reviewedVersion: 2, builder: "gone", goneAt: 1000, stateSince: 900, slotHolders: [{ id: "fp_1", title: "Cache avatar lookups" }] });
    expect(toPlan({ id: "x", reviewed_version: 3 }).reviewedVersion).toBe(3);
    const none = toPlan({ id: "x", builder: "somewhere" });
    expect(none.builder).toBeUndefined();
    expect(none.reviewedVersion).toBeNull();
  });
});

describe("the detail says what is true", () => {
  const src = (p: string): string => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
  test("'edited after Preflight' compares versions, never the clock", () => {
    const tab = src("src/components/flightPlan/PlansTab.tsx");
    expect(tab).toContain("plan.reviewedVersion != null && plan.version != null && plan.version !== plan.reviewedVersion");
    expect(tab).not.toContain("plan.updatedAt > run.certificate.createdAt");
  });
  test("the copy that could be false is gone", () => {
    const poll = src("src/components/flightPlan/GoPoll.tsx");
    expect(poll).not.toContain("handed to the builder in its own tab");
    expect(src("src/lib/flightPlan.ts")).not.toMatch(/Awaiting Go|In progress/);
  });
  test("a closed tab is labelled as seen, and there is no Spent row", () => {
    const f = src("src/lib/flightPilot.ts");
    expect(f).toContain('k: "Tab seen closed"');
    expect(f).not.toMatch(/k: "Spent"/);
  });
});
