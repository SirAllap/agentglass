// The agile cleanup flow: how many screens each mode shows for each plan shape,
// the PR view learning that a run ended, and the evidence-folder field. Names are invented.
import { afterAll, describe, expect, test } from "bun:test";
import { actionView, cleanupStep, leftAfter, needsLook, noteOf, type Plan, type Report } from "../src/lib/cleanupPr.ts";
import { addRoot, dropRoot, includeOf, isCustom, rootsOf, valuesOf } from "../src/lib/cleanupSettings.ts";
import { beginRun, currentCleanupNote, endRun, isRunning, showCleanupNote, subscribeRuns } from "../src/lib/cleanupEvents.ts";
import { offerFor, stateOfPlan } from "../src/lib/leftovers.ts";
import { cleanAfterMerge } from "../src/lib/cleanupRun.ts";
import { api } from "../src/lib/api.ts";

const item = (id: string, kind: string, bytes = 0) => ({ id, kind, target: `${kind}-${id}`, detail: "", bytes });
const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1", repo: "/w/orbit", pr: 322, title: "Retry queue", url: "", state: "MERGED", mergedAt: 1, notMerged: false,
  branch: "feat/ORBIT-1042-retry", slug: "ORBIT-1042", blocks: [], notes: [],
  items: [item("a", "docker-image", 4_000_000_000), item("b", "worktree", 3_000_000_000), item("c", "branch")],
  ...over,
});
const report = (over: Partial<Report> = {}): Report => ({
  ok: true, planId: "p1", freedBytes: 7_000_000_000, failed: 0, summary: "", remaining: { items: [], bytes: 0, blocks: [] },
  items: [{ id: "a", kind: "docker-image", target: "docker-image-a", status: "done", detail: "", bytes: 4_000_000_000 }, { id: "b", kind: "worktree", target: "worktree-b", status: "done", detail: "", bytes: 3_000_000_000 }],
  ...over,
});

describe("mode x plan shape: which screen the person sees", () => {
  const block = plan({ blocks: [{ kind: "dirty", why: "x" }] });
  const dominant = plan({ items: [item("a", "docker-image", 95_000_000_000), item("b", "worktree", 1_000_000_000)] });
  const history = plan({ items: [item("a", "docker-image", 2_000_000_000), item("h", "agent-history", 2_000_000_000)] });
  const empty = plan({ items: [item("o", "own-state")] });

  test("automatic is never a dialog, whatever the plan or who asked", () => {
    for (const p of [plan(), block, dominant, history, empty]) for (const via of ["merge-tick", "ask", "button"] as const) expect(cleanupStep("auto", via, p)).toBe("never");
  });
  test("off offers nothing", () => expect(cleanupStep("off", "button", plan())).toBe("never"));
  test("the tick at merge time runs a clean plan at once, with no dialog", () => expect(cleanupStep("atMerge", "merge-tick", plan())).toBe("direct"));
  test("the tick opens the dialog when the plan needs a look", () => {
    expect(cleanupStep("atMerge", "merge-tick", block)).toBe("dialog");
    expect(cleanupStep("atMerge", "merge-tick", plan({ notMerged: true }))).toBe("dialog");
    expect(cleanupStep("atMerge", "merge-tick", dominant)).toBe("dialog");
    expect(cleanupStep("atMerge", "merge-tick", history)).toBe("dialog");
  });
  test("one item at exactly 90 % still runs; past it, a look", () => {
    const edge = plan({ items: [item("a", "docker-image", 90), item("b", "worktree", 10)] });
    expect(needsLook(edge)).toBe("");
    expect(needsLook(plan({ items: [item("a", "docker-image", 91), item("b", "worktree", 9)] }))).toBe("dominant");
  });
  test("a plan with nothing listed has nothing to run", () => expect(cleanupStep("atMerge", "merge-tick", empty)).toBe("nothing"));
  test("Ask and the PR's own button keep the dialog", () => {
    expect(cleanupStep("ask", "ask", plan())).toBe("dialog");
    expect(cleanupStep("atMerge", "button", plan())).toBe("dialog");
    expect(cleanupStep("auto", "button", plan())).toBe("never"); // the server's job; the button is the person's own, not a modal started for them
  });
});

describe("the toast line", () => {
  test("one line with the card and the size freed", () => {
    const n = noteOf(plan(), report());
    expect(n.text).toBe("Cleaned ORBIT-1042 · 7.0 GB freed");
    expect(n.tone).toBe("ok");
    expect(n.lines).toHaveLength(2);
  });
  test("a partial failure says so and what is left", () => {
    const n = noteOf(plan(), report({ failed: 1, items: [{ id: "b", kind: "worktree", target: "w", status: "failed", detail: "busy", bytes: 0 }], remaining: { items: [item("b", "worktree", 3e9)], bytes: 3e9, blocks: [] } }));
    expect(n.text).toContain("with 1 problem");
    expect(n.text).toContain("1 left");
    expect(n.tone).toBe("warn");
  });
});

describe("the PR view after a run", () => {
  test("nothing left says Cleaned up with the size, never Leftovers, and draws no button", () => {
    const v = actionView(plan({ items: [item("o", "own-state")] }), 6_400_000_000);
    expect(v.badge).toBe("Cleaned up · 6.4 GB freed");
    expect(offerFor(stateOfPlan(plan({ items: [item("o", "own-state")] }), false), "panel").button).toBe(false);
  });
  test("what remains after a partial failure is what is shown", () => {
    const v = actionView(plan({ items: [item("b", "worktree", 3_000_000_000)] }), 4_000_000_000);
    expect(v.badge).toBe("Leftovers 3.0 GB");
    expect(offerFor(stateOfPlan(plan({ items: [item("b", "worktree", 3_000_000_000)] }), false), "panel").button).toBe(true);
  });
  test("a report's own re-read decides; no re-read says nothing", () => {
    expect(leftAfter(report())).toBe(0);
    expect(leftAfter(report({ remaining: { items: [item("b", "worktree"), item("o", "own-state")], bytes: 0, blocks: [] } }))).toBe(1);
    expect(leftAfter(report({ remaining: null }))).toBeNull();
    expect(leftAfter({})).toBeNull();
  });
});

describe("runs announce their end", () => {
  test("a second run of one PR is refused until the first ends; every view hears both ends", () => {
    const seen: string[] = [];
    const off = subscribeRuns((e) => seen.push(`${e.pr}:${e.phase}`));
    expect(beginRun("/w/orbit", 7)).toBe(true);
    expect(beginRun("/w/orbit", 7)).toBe(false);
    expect(isRunning("/w/orbit", 7)).toBe(true);
    expect(beginRun("/w/orbit", 8)).toBe(true); // another PR is independent
    endRun("/w/orbit", 7, report());
    endRun("/w/orbit", 8);
    expect(isRunning("/w/orbit", 7)).toBe(false);
    expect(beginRun("/w/orbit", 7)).toBe(true);
    endRun("/w/orbit", 7);
    off();
    expect(seen).toEqual(["7:start", "8:start", "7:end", "8:end", "7:start", "7:end"]);
  });
});

describe("cleaning right after the merge", () => {
  const real = { plan: api.cleanupPlan, run: api.cleanupRun };
  afterAll(() => { api.cleanupPlan = real.plan; api.cleanupRun = real.run; showCleanupNote(null); });
  const withPlan = (p: Plan, ran: { n: number }) => {
    api.cleanupPlan = (async () => ({ ok: true, plan: p })) as typeof api.cleanupPlan;
    api.cleanupRun = (async () => { ran.n++; return report(); }) as typeof api.cleanupRun;
  };
  test("a clean plan runs once and ends in one toast, no dialog", async () => {
    const ran = { n: 0 }; showCleanupNote(null); withPlan(plan(), ran);
    expect(await cleanAfterMerge("/w/orbit", 322)).toBe("done");
    expect(ran.n).toBe(1);
    expect(currentCleanupNote()?.text).toBe("Cleaned ORBIT-1042 · 7.0 GB freed");
    expect(isRunning("/w/orbit", 322)).toBe(false);
  });
  test("progress while it runs is the toast, not a modal; the result replaces it", async () => {
    showCleanupNote(null);
    let during: ReturnType<typeof currentCleanupNote> = null;
    api.cleanupPlan = (async () => ({ ok: true, plan: plan() })) as typeof api.cleanupPlan;
    api.cleanupRun = (async () => { during = currentCleanupNote(); return report(); }) as typeof api.cleanupRun;
    expect(await cleanAfterMerge("/w/orbit", 322)).toBe("done");
    expect(during).toMatchObject({ tone: "run", text: "Cleaning ORBIT-1042\u2026" });
    expect(currentCleanupNote()?.tone).toBe("ok");
    const run = (await Bun.file(new URL("../src/lib/cleanupRun.ts", import.meta.url)).text()).replace(/^\s*(\/\*|\*|\/\/).*$/gm, "");
    expect(run).not.toMatch(/setCleanupAfter|<CleanupDialog|open\(/); // the direct path opens no window of its own
  });
  test("a plan with a block runs nothing and hands the dialog back", async () => {
    const ran = { n: 0 }; showCleanupNote(null); withPlan(plan({ blocks: [{ kind: "dirty", why: "x" }] }), ran);
    expect(await cleanAfterMerge("/w/orbit", 322)).toBe("dialog");
    expect(ran.n).toBe(0);
    expect(currentCleanupNote()).toBeNull();
  });
  test("a refused run frees the guard and hands the dialog back", async () => {
    showCleanupNote(null);
    api.cleanupPlan = (async () => ({ ok: true, plan: plan() })) as typeof api.cleanupPlan;
    api.cleanupRun = (async () => ({ ok: false, error: "plan changed" })) as typeof api.cleanupRun;
    expect(await cleanAfterMerge("/w/orbit", 322)).toBe("dialog");
    expect(isRunning("/w/orbit", 322)).toBe(false);
  });
});

describe("evidence folders", () => {
  test("a folder must be a full path, not broad, not listed twice", () => {
    expect(addRoot([], "~/Documents/projects/orbit/")).toEqual({ ok: true, list: ["~/Documents/projects/orbit"] });
    expect(addRoot([], "docs/evidence")).toMatchObject({ ok: false });
    expect(addRoot([], "/home/a/../b")).toMatchObject({ ok: false });
    expect(addRoot([], "/home")).toMatchObject({ ok: false });
    expect(addRoot([], "  ")).toMatchObject({ ok: false });
    expect(addRoot(["/w/evidence"], "/w/evidence")).toMatchObject({ ok: false });
  });
  test("what the server holds is shown as strings only, and a drop removes one", () => {
    expect(rootsOf(["/w/e", 3, "", null])).toEqual(["/w/e"]);
    expect(rootsOf(undefined)).toEqual([]);
    expect(dropRoot(["/w/a", "/w/b"], "/w/a")).toEqual(["/w/b"]);
  });
  test("a project on the defaults is not custom; ticking the session history makes it so", () => {
    expect(isCustom(valuesOf("ask", 0, null))).toBe(false);
    expect(isCustom(valuesOf("ask", 0, [...includeOf(null), "agent-history"]))).toBe(true);
  });
});

describe("wiring, asserted against source", async () => {
  const src = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url)).text();
  const [action, dialog, panel] = [await src("components/CleanupPrAction.tsx"), await src("components/CleanupDialog.tsx"), await src("components/PrPanel.tsx")];
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
  test("the PR badge hears a run end instead of waiting for its own dialog", () => {
    expect(code(action)).toContain("subscribeRuns(");
    expect(code(action)).not.toMatch(/setInterval|setTimeout/);
  });
  test("the dialog takes the per-PR guard and closes a clean finish into the toast, not a Done screen", () => {
    expect(code(dialog)).toContain("beginRun(repo, pr)");
    expect(code(dialog)).toContain("showCleanupNote(");
    expect(code(dialog)).not.toContain("AUTO_CLOSE_MS");
  });
  test("the merge hands the PR to the direct run, and opens the dialog only when it says so", () => {
    expect(code(panel)).toContain("cleanAfterMerge(root, detail.number)");
    expect(code(panel)).not.toMatch(/if \(merged && choice\.cleanup\) setCleanupAfter/);
  });
});
