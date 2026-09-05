/*
 * The budget and the gate, which had never been introduced.
 *
 * Every cost tracker in this category reports: budget.ts already knew the
 * spend, gate.ts already held a tool call until a human answered, and
 * `grep -c budget server/src/gate.ts` was 0. A limit you are only told about by
 * a bar turning red on a dashboard nobody has open is a receipt.
 *
 * So these tests are about two things, and the second matters more than the
 * first. One: an over-budget project's next held call arrives carrying the
 * number, in words a person can act on from a lock screen. Two — every test
 * below the first group — that a budget can never, under any configuration,
 * turn into a block that was not already going to happen. A cost tracker that
 * accidentally halts somebody's agents is a worse product than one that only
 * reports, so "does not hold" is pinned harder here than "holds".
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Budget, BudgetStatus } from "../../shared/types.ts";
import type { budgetHoldFor as BudgetHoldFor } from "../src/budget.ts";
import { budgetStatus, overBudgetFor, budgetHoldReason, emptyBudget } from "../src/budget.ts";

// Config homes, one per budget arrangement. config.ts caches per resolved path
// and reloads when the path changes, so flipping XDG_CONFIG_HOME between tests
// is how a suite in one process gets to try more than one settings file.
const home = (name: string, budgets?: unknown): string => {
  const d = mkdtempSync(join(tmpdir(), `agx-gatebudget-${name}-`));
  if (budgets !== undefined) {
    mkdirSync(join(d, "agentglass"), { recursive: true });
    writeFileSync(join(d, "agentglass", "config.json"), JSON.stringify({ budgets }));
  }
  return d;
};

// A limit no fixture can be under, and one nothing can be over. Deliberately
// absurd on both ends: in a full `bun test` run db.ts may already be bound to
// another suite's database (it binds its file at import), so the spend these
// read is not knowable from here. Only the sign of the comparison is.
const OVER = { root: "", model: "", limit: 0.000001, period: "day" };
const UNDER = { root: "", model: "", limit: 1_000_000_000, period: "day" };

const NONE = home("none"); // no config.json at all — the shipped state
const OVER_HOME = home("over", [OVER]);
const UNDER_HOME = home("under", [UNDER]);

process.env.AGENTGLASS_DB = join(NONE, "gate.db");
process.env.XDG_CONFIG_HOME = NONE;

let gate: typeof import("../src/gate.ts");
let budget: typeof import("../src/budget.ts");
/* submitGate takes the reason rather than looking it up — see the note on its
 * third parameter. Production computes it exactly this way at the /gate route,
 * so the test calls the same function rather than a hand-rolled stand-in. */
const holdFor = (session: string) => budget.budgetHoldFor(session, false);
let db: typeof import("../src/db.ts");
let panewt: typeof import("../src/panewt.ts");

// Unique per run, deterministic per assertion — same reasoning as
// gate-durability.test.ts: fixed ids replay the previous run's recorded rows.
let seq = 0;
const newId = () => `${crypto.randomUUID().slice(0, 24)}${String(++seq).padStart(12, "0")}`;

const SESSION = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const PANE = "%77";

const req = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source_app: "orbit",
  session_id: SESSION,
  tool_name: "Bash",
  summary: "rm -rf build",
  ...over,
});

/** The one held request with this id, as the dashboard would receive it. */
const held = (id: string) => gate.pendingGates().find((g) => g.id === id)!;

/** A status built by the real evaluator with the spend injected, which is the
 *  seam budget.ts already offers — the arithmetic is not what is under test
 *  here, the scoping decision is. */
const status = (b: Partial<Budget>, spent: number): BudgetStatus =>
  budgetStatus([{ ...emptyBudget(), limit: 100, ...b }], Date.parse("2026-07-15T09:30:00Z"), () => spent)[0];

beforeAll(async () => {
  db = await import("../src/db.ts");
  panewt = await import("../src/panewt.ts");
  gate = await import("../src/gate.ts");
  budget = await import("../src/budget.ts");
  // The gate payload carries no cwd. The pane note the hook records does, and
  // it is the same path describeSession() already recovers the checkout from —
  // without it the session belongs to no project at all.
  panewt.notePaneAgent({ pane: PANE, sessionId: SESSION, transcriptPath: join(NONE, "t.jsonl"), cwd: "/home/u/code/orbit" });
  // Something for a budget to be over. The amount is whatever this model and
  // these tokens price out at; all the fixtures care about is that it is more
  // than a millionth of a dollar and less than a billion.
  db.insertEvent({
    source_app: "orbit",
    session_id: SESSION,
    hook_event_type: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: null,
    agent_id: null,
    agent_type: null,
    model_name: "claude-opus-4-8",
    is_error: 0,
    error_text: null,
    usage: { input_tokens: 200_000, output_tokens: 50_000, cache_creation_tokens: 0, cache_read_tokens: 0 },
    usage_is_cumulative: false,
    summary: "spent something",
    timestamp: Date.now(),
    payload: { project_path: "/home/u/code/orbit" },
    chat: null,
  } as any);
});

describe("which budget a call is over", () => {
  test("a budget with no root is 'everything', and covers a directory we could not place", () => {
    // The gate often cannot place one: a hook that never reported a pane leaves
    // the cwd empty. "Everything" still means everything.
    expect(overBudgetFor("", [status({ root: "" }, 140)])).not.toBeNull();
    expect(overBudgetFor("/home/u/code/orbit", [status({ root: "" }, 140)])).not.toBeNull();
  });

  test("a budget WITH a root does not cover a directory we could not place", () => {
    // The failure mode this exists to prevent: an unknown session inheriting
    // some other project's limit and being annotated as over a budget nobody
    // set for it. Guessing which project an agent is in is how the wrong fleet
    // gets stopped.
    expect(overBudgetFor("", [status({ root: "/home/u/code/orbit" }, 140)])).toBeNull();
  });

  test("and does not cover a different project that merely shares a prefix", () => {
    // ~/code/orbit-web is not inside ~/code/orbit, however much a `startsWith`
    // on the bare path would like it to be.
    expect(overBudgetFor("/home/u/code/orbit-web", [status({ root: "/home/u/code/orbit" }, 140)])).toBeNull();
    expect(overBudgetFor("/home/u/code/orbit/server", [status({ root: "/home/u/code/orbit" }, 140)])).not.toBeNull();
  });

  test("under the limit is not over it, and neither is the warning band", () => {
    expect(overBudgetFor("/home/u/code/orbit", [status({ root: "" }, 10)])).toBeNull();
    // 80% is where the dashboard starts warning. A warning is not a reason to
    // put a sentence in front of somebody who is holding a phone.
    expect(overBudgetFor("/home/u/code/orbit", [status({ root: "" }, 85)])).toBeNull();
    // The boundary itself: 100% is over, exactly as budgetStatus grades it.
    expect(overBudgetFor("/home/u/code/orbit", [status({ root: "" }, 100)])).not.toBeNull();
  });

  test("no budgets at all is null, not zero", () => {
    expect(overBudgetFor("/home/u/code/orbit", [])).toBeNull();
  });

  test("when several are over, the worst one is the one you are shown", () => {
    const mild = status({ root: "" }, 101);
    const bad = status({ root: "/home/u/code/orbit", limit: 10 }, 60); // 600%
    expect(overBudgetFor("/home/u/code/orbit", [mild, bad])!.budget.root).toBe("/home/u/code/orbit");
    expect(overBudgetFor("/home/u/code/orbit", [bad, mild])!.budget.root).toBe("/home/u/code/orbit");
  });
});

describe("the sentence a person reads", () => {
  const s = status({ root: "/home/u/code/orbit", limit: 40, period: "month" }, 42.1);

  test("says the limit, what has been spent, and which project", () => {
    const r = budgetHoldReason(s);
    expect(r).toContain("$42.10");
    expect(r).toContain("$40.00");
    expect(r).toContain("this month");
    expect(r).toContain("orbit");
  });

  test("and says what happens if they do nothing — which is that it proceeds", () => {
    // The fact every spend warning leaves out. Without it the line reads like a
    // block, and somebody scrambles to approve a call that was never going to
    // be stopped.
    expect(budgetHoldReason(s, false)).toMatch(/proceeds/);
    expect(budgetHoldReason(s, false)).not.toMatch(/denied/);
  });

  test("unless the operator has chosen fail-closed, in which case it says denied", () => {
    expect(budgetHoldReason(s, true)).toMatch(/denied/);
    expect(budgetHoldReason(s, true)).not.toMatch(/proceeds/);
  });
});

describe("a held call from a project that is over its budget", () => {
  test("arrives carrying the reason", () => {
    process.env.XDG_CONFIG_HOME = OVER_HOME;
    const id = newId();
    gate.submitGate(req(id), 60_000, holdFor(req(id).session_id)); // held: nobody decides it here
    const g = held(id);
    expect(g.budget).toBeTruthy();
    expect(g.budget).toMatch(/^Over budget · \$/);
    expect(g.budget).toMatch(/proceeds/);
  });

  test("without the reason eating the summary, which is a different fact", () => {
    // `summary` is what the agent wants to run, and it is what the action log
    // and the gate history quote back. The budget line goes stale the moment
    // the period rolls over; folding the two together would put a snapshot of
    // last month's spend in the permanent record of a `rm -rf build`.
    process.env.XDG_CONFIG_HOME = OVER_HOME;
    const id = newId();
    gate.submitGate(req(id), 60_000, holdFor(req(id).session_id));
    expect(held(id).summary).toBe("rm -rf build");
    expect(db.getGate(id)!.summary).toBe("rm -rf build");
  });
});

describe("what a budget must never do", () => {
  test("a project under its budget is annotated with nothing", () => {
    process.env.XDG_CONFIG_HOME = UNDER_HOME;
    const id = newId();
    gate.submitGate(req(id), 60_000, holdFor(req(id).session_id));
    expect(held(id).budget).toBeUndefined();
  });

  test("and no budget set at all is the shipped state: nothing changes", () => {
    // The default install. Nobody who never asked for budgets should be able to
    // tell this feature exists.
    process.env.XDG_CONFIG_HOME = NONE;
    const id = newId();
    gate.submitGate(req(id), 60_000, holdFor(req(id).session_id));
    expect(held(id).budget).toBeUndefined();
  });

  test("a session whose project cannot be recovered is not annotated by a scoped budget", () => {
    // No pane note for this session id, so the gate cannot say which checkout
    // it is in — and a budget that named a checkout must not be applied on a
    // guess. Whole-machine budgets still apply; that is the case above.
    process.env.XDG_CONFIG_HOME = home("scoped", [{ ...OVER, root: "/home/u/code/orbit" }]);
    const id = newId();
    gate.submitGate(req(id, { session_id: crypto.randomUUID() }), 60_000);
    expect(held(id).budget).toBeUndefined();
  });

  test("and being over budget does not change what a timeout resolves to", async () => {
    // The load-bearing one. Fail-open is the shipped policy: a hold nobody
    // answers auto-allows, and its reason stays EMPTY so the hook falls through
    // to Claude Code's own permission prompt instead of force-allowing. A
    // budget adds words to the hold; if it also filled that reason it would
    // silently skip the prompt the gate exists to raise.
    process.env.XDG_CONFIG_HOME = OVER_HOME;
    const id = newId();
    const wait = gate.submitGate(req(id), 1, holdFor(req(id).session_id)); // floored to 1s by submitGate
    expect(held(id).budget).toBeTruthy();
    const out = await wait;
    expect(out.decision).toBe("allow");
    expect(out.reason).toBe("");
    expect(db.getGate(id)!.resolution).toBe("timeout");
  }, 10_000);
});

describe("AGENTGLASS_GATE_FAILCLOSED", () => {
  test("changes what the held call says will happen, and nothing else", async () => {
    // A second module registry = a second process reading a different
    // environment, sharing only the database. Indirected through a variable
    // because the query string is what forces a second instance and tsc cannot
    // resolve it as a literal specifier.
    process.env.XDG_CONFIG_HOME = OVER_HOME;
    process.env.AGENTGLASS_GATE_FAILCLOSED = "1";
    const closed = "../src/gate.ts?failclosed=1";
    try {
      const fresh = await import(closed) as typeof import("../src/gate.ts");
      const id = newId();
      // failClosed true here: this block is the fail-closed module, and the
      // reason has to say what THAT module will do when nobody answers.
      const wait = fresh.submitGate(req(id), 1, budget.budgetHoldFor(req(id).session_id, true));
      const g = fresh.pendingGates().find((x) => x.id === id)!;
      // Same three facts, opposite ending: here, doing nothing denies.
      expect(g.budget).toMatch(/^Over budget · \$/);
      expect(g.budget).toMatch(/denied/);
      // And the outcome is the one fail-closed already produced — the budget
      // did not deny anything, the operator's policy did.
      const out = await wait;
      expect(out.decision).toBe("deny");
      expect(out.reason).toMatch(/fail-closed/);
    } finally {
      delete process.env.AGENTGLASS_GATE_FAILCLOSED;
      process.env.XDG_CONFIG_HOME = NONE;
    }
  }, 10_000);
});
