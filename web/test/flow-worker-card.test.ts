/*
 * What a worker card says, without a renderer: the step, the chain it runs on,
 * the tries its own failing arrow allows, the Required lock and the live
 * numbers. The card component only paints this, so the words are asserted here
 * and the source rule keeps the project's review cap out of it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roleById, validateFlow, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { DEFAULT_REVIEW_ROUNDS } from "../../shared/reviewSettings.ts";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { workerCardModel, workerCardText, type LiveCounts } from "../src/lib/workerCardView.ts";
import { workerCardMenu } from "../src/lib/workerCardMenu.ts";
import { flowOnScreen } from "../src/components/orchestration/flow/flowScreenCopy.ts";

const shipped = (): Flow => ({ ...templateFlow(), blocks: [] });
const f = shipped();
const card = (id: string, counts?: LiveCounts | null) => workerCardModel(f, roleById(f, id)!, counts);

describe("the card's words", () => {
  test("Tries is the fail edge's own cap, not the project's review cap", () => {
    // The app is handed what `readFlow` builds: the reviewer's arrow carries the project's cap, and every other arrow keeps its own number.
    const cap = DEFAULT_REVIEW_ROUNDS + 2;
    const handed: Flow = { ...f, edges: f.edges.map((e) => (e.on === "fail" && e.from === "inspector" ? { ...e, maxRounds: cap } : e)) };
    const on = (id: string) => workerCardModel(handed, roleById(handed, id)!);
    expect(on("inspector").attempts).toEqual({ of: cap, word: `${cap} tries` });
    // Two, not the cap: the verifier's own arrow, which the server leaves alone.
    expect(on("verifier").attempts).toEqual({ of: 2, word: "2 tries" });
    expect(on("planner").attempts).toBeNull();
  });

  test("the chain is resolvedChain when the policy resolved one, and chain otherwise", () => {
    const resolved = { ...f, roster: f.roster.map((r) => (r.id === "builder" ? { ...r, resolvedChain: [{ engine: "opencode", model: "glm-4.6" }, { engine: "claude", model: "haiku" }] } : r)) };
    const m = workerCardModel(resolved, roleById(resolved, "builder")!);
    expect(m.chain).toEqual([
      { engine: "opencode", model: "glm-4.6", first: true },
      { engine: "claude", model: "haiku", first: false },
    ]);
    // The summary panel and "Copy settings as text" print the same chain the card draws, not the base one.
    expect(m.chainWord).toBe("glm-4.6 (OpenCode) → haiku (Claude Code)");
    const own = { ...f, roster: f.roster.map((r) => (r.id === "docs" ? { ...r, chain: [{ engine: "opencode", model: "big-pickle" }] } : r)) };
    expect(workerCardModel(own, roleById(own, "docs")!).chain[0]).toEqual({ engine: "opencode", model: "big-pickle", first: true });
  });

  test("the Required lock is the path's rule: on the path it says so, off it says why it cannot", () => {
    const required = { ...f, roster: f.roster.map((r) => (r.id === "builder" ? { ...r, required: true } : r)) };
    const on = workerCardModel(required, roleById(required, "builder")!);
    expect(on.required).toBe(true);
    expect(on.requiredWord).toBe("Required");
    expect(on.requiredTip).toContain("cannot be skipped");
    const off = { ...required, roster: required.roster.map((r) => (r.id === "docs" ? { ...r, required: true } : r)) };
    const docs = workerCardModel(off, roleById(off, "docs")!);
    expect(docs.required).toBe(false);
    expect(docs.requiredTip).toBe("Only a step on the path can be required.");
  });

  test("no counts means no live reading and no invented numbers", () => {
    const m = card("builder");
    expect(m.tone).toBeNull();
    expect(m.liveWord).toBeNull();
    expect(m.cost).toBe("—");
    expect(card("builder", { builder: { run: 0, wait: 0, cost: 0 } })).toMatchObject({ tone: "idle", liveWord: "Idle", cost: "$0.00" });
  });

  test("the counts say running, waiting on you, and what it has cost", () => {
    expect(card("builder", { builder: { run: 2, wait: 0, cost: 0.42 } })).toMatchObject({ tone: "run", liveWord: "Running ×2", cost: "$0.42" });
    expect(card("builder", { builder: { run: 0, wait: 1, cost: 1.5 } })).toMatchObject({ tone: "wait", liveWord: "Waiting on you", cost: "$1.50" });
  });

  test("a step off the path has no number of its own, and the copy says so", () => {
    const m = card("docs");
    expect(m.step).toBeNull();
    expect(m.stepWord).toBe("in the team");
    expect(workerCardText(f, roleById(f, "docs")!)).toContain("in the team");
  });

  test("the menu keeps the seven actions, and each row that is off says why", () => {
    const rows = workerCardMenu(f, roleById(f, "builder")!);
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.act)).toContain("general");
    expect(rows.find((r) => r.act === "general")).toMatchObject({ enabled: false });
    expect(rows.find((r) => r.act === "general")!.why).toContain("one project");
    expect(rows.find((r) => r.act === "remove")!.enabled).toBe(true);
    const last = { ...f, path: ["builder"] };
    expect(workerCardMenu(last, roleById(last, "builder")!).find((r) => r.act === "remove")).toMatchObject({ enabled: false, why: "The last step cannot be removed." });
  });
});

describe("a rule about source: the card cannot print the review cap", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const read = (p: string) => readFileSync(join(SRC, p), "utf8");
  test("the card and its model import no review setting", () => {
    expect(read("lib/workerCardView.ts")).not.toContain("reviewSettings");
    expect(read("components/orchestration/flow/WorkerCard.tsx")).not.toContain("reviewSettings");
  });
  test("the card paints the model's tries and cost, and never its own copy of them", () => {
    const cardSrc = read("components/orchestration/flow/WorkerCard.tsx");
    expect(cardSrc).toContain("m.attempts.word");
    expect(cardSrc).toContain("m.attempts.of");
    expect(cardSrc).toContain("m.cost");
    expect(cardSrc).toContain("workerCardModel");
  });
});

describe("the flow the rail and the panel are handed", () => {
  const policy = (rules: PolicyRule[] = []): Policy => ({
    ...composePolicy(defaultStored(), {
      orchestrator: { engine: "claude", model: "sonnet" },
      workers: { scout: { engine: "opencode", model: "glm-4.6" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
    }),
    rules,
  });
  /** What a save returns: validateFlow's flow, which carries no `resolvedChain`. */
  const saved = (): Flow => {
    const v = validateFlow(f);
    if (!v.ok) throw new Error(v.error);
    return v.value;
  };
  const thin: PolicyRule = {
    id: "thin-week", name: "Thin week", enabled: true,
    when: [{ kind: "always" }],
    workers: { builder: [{ engine: "opencode", model: "big-pickle" }] },
  };

  test("a flow a save rebuilt gets its built-in chains back from the policy", () => {
    expect(roleById(saved(), "planner")!.resolvedChain).toBeUndefined();
    const shown = flowOnScreen(saved(), policy(), () => false);
    expect(roleById(shown, "planner")!.resolvedChain).toEqual([{ engine: "opencode", model: "glm-4.6" }]);
    expect(workerCardModel(shown, roleById(shown, "planner")!).chainWord).toContain("glm-4.6");
  });

  test("a rule in force is the chain the panel prints, and a role of its own keeps its own", () => {
    const shown = flowOnScreen(saved(), policy([thin]), (id) => id === "thin-week");
    expect(roleById(shown, "builder")!.resolvedChain).toEqual([{ engine: "opencode", model: "big-pickle" }]);
    expect(workerCardModel(shown, roleById(shown, "builder")!).chainWord).toContain("big-pickle");
    expect(roleById(shown, "qa-only")!.resolvedChain).toBeUndefined();
  });

  test("the rail, the panel and the editor are fed that flow, not the saved one", () => {
    const editor = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "flow", "FlowEditor.tsx"), "utf8");
    expect(editor).toContain("flowOnScreen(flow, aroundData.policy, holds)");
    expect(editor).toContain("<WorkerPanel flow={drawn}");
    expect(editor).toContain("<WorkerEditor flow={shownFlow}");
  });
});
