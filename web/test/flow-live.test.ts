/*
 * The numbers a Flow card prints about "now", one per role, read off the
 * board's rows. No renderer: this is why the module is pure.
 *
 * Each case is paired with the row it could be confused with, because a card
 * that says the wrong thing about now is the end of somebody trusting it:
 *
 *   waiting on you  vs  a turn that ended     (both are `needsYou`)
 *   a second run    vs  a renamed session     (`wasCalled`)
 *   a worker        vs  the project's seat    (`role: "orchestrator"`)
 *   counted nowhere vs  a role removed from the roster   (not a throw)
 *   its own builder  vs  another project's builder      (`project`/`worktree`)
 *   run             vs  a row that is both    (stopped outranks running)
 */
import { expect, test } from "bun:test";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { inFlight, lastDecision, liveByRole, roleOf, type LiveRow } from "../src/lib/flowLive.ts";

const flow = templateFlow();
const now = 1_800_000_000_000;
const min = 60_000;
/** The project the flow is for; every row below belongs to it unless it says otherwise. */
const PROJECT = "/work/acme";
const row = (name: string, over: Partial<LiveRow> = {}): LiveRow => ({ name, state: "idle", project: PROJECT, ...over });
const worker = (name: string, role: string, over: Partial<LiveRow> = {}) => row(name, { worker: { role }, ...over });
const stopped = (kind: "permission" | "input" | "gate") =>
  ({ kind, why: kind === "gate" ? "waiting at the gate: Bash — git push" : "waiting for your next prompt", since: now - min });

test("an empty board is zeros for every role of the flow, never a missing key", () => {
  const counts = liveByRole([], flow, PROJECT);
  expect(Object.keys(counts).sort()).toEqual(flow.roster.map((r) => r.id).sort());
  for (const r of flow.roster) expect(counts[r.id]).toEqual({ run: 0, wait: 0, cost: 0 });
});

test("one working and one waiting row of the same role are two numbers", () => {
  const counts = liveByRole([
    worker("builder", "builder", { state: "working" }),
    worker("builder-2", "builder", { state: "waiting", needsYou: stopped("permission") }),
  ], flow, PROJECT);
  expect(counts.builder).toEqual({ run: 1, wait: 1, cost: 0 });
});

test("a row stopped on a person is a wait, not a run, whatever else it says", () => {
  const counts = liveByRole([worker("builder", "builder", { state: "working", needsYou: stopped("gate") })], flow, PROJECT);
  expect(counts.builder).toEqual({ run: 0, wait: 1, cost: 0 });
});

test("cost sums the rows of one role and leaves the other roles' money out", () => {
  const counts = liveByRole([
    worker("builder", "builder", { facts: { cost: 0.5 } }),
    worker("builder-2", "builder", { facts: { cost: 0.25 } }),
    worker("planner", "scout", { facts: { cost: 9 } }),
  ], flow, PROJECT);
  expect(counts.builder!.cost).toBeCloseTo(0.75);
  expect(counts.planner!.cost).toBe(9);
  expect(counts.inspector!.cost).toBe(0);
});

test("a renamed session is counted once, not once per name it ever had", () => {
  const counts = liveByRole([
    worker("builder-2", "builder", { state: "working", wasCalled: ["builder"], facts: { cost: 1 } }),
    worker("builder", "builder", { state: "working", facts: { cost: 1 } }),
  ], flow, PROJECT);
  expect(counts.builder).toEqual({ run: 1, wait: 0, cost: 1 });
});

test("the app's own readers are never a worker", () => {
  const counts = liveByRole([
    row("orbit seat", { role: "orchestrator", state: "working", facts: { cost: 4 } }),
    row("lantern", { role: "lantern", state: "working", facts: { cost: 4 } }),
  ], flow, PROJECT);
  expect(Object.values(counts).every((c) => c.run === 0 && c.cost === 0)).toBe(true);
  expect(roleOf(row("orbit seat", { role: "orchestrator", worker: { role: "builder" } }))).toBeNull();
});

test("a role the flow no longer has is counted nowhere and does not throw", () => {
  const counts = liveByRole([worker("ghost", "removed-role", { state: "working", facts: { cost: 2 } })], flow, PROJECT);
  expect(Object.values(counts).every((c) => c.run === 0 && c.cost === 0)).toBe(true);
});

test("a flow counts its own project's workers, and another project's builder is not its builder", () => {
  const orbit = "/work/orbit";
  const rows = [
    worker("builder", "builder", { state: "working", facts: { cost: 2 } }),
    worker("orbit-builder", "builder", { project: orbit, state: "working", facts: { cost: 5 } }),
    worker("orbit-planner", "scout", { project: orbit, state: "waiting", needsYou: stopped("input") }),
    // Rolled up by its checkout, the way the server answers a row without a project.
    worker("orbit-inspector", "reviewer", { project: undefined, worktree: orbit, state: "working" }),
    worker("orbit-writer", "builder", { project: orbit, state: "idle", doing: "the orbit route", saidAt: now }),
  ];
  const acme = liveByRole(rows, flow, PROJECT);
  expect(acme.builder).toEqual({ run: 1, wait: 0, cost: 2 });
  expect(acme.planner).toEqual({ run: 0, wait: 0, cost: 0 });
  expect(acme.inspector).toEqual({ run: 0, wait: 0, cost: 0 });
  // The hero's last decision is this project's too, never the busier neighbour's.
  expect(lastDecision(rows, flow, PROJECT)).toBeNull();

  const theirs = liveByRole(rows, flow, orbit);
  expect(theirs.builder).toEqual({ run: 1, wait: 0, cost: 5 });
  expect(theirs.planner).toEqual({ run: 0, wait: 1, cost: 0 });
  expect(theirs.inspector).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(lastDecision(rows, flow, orbit)).toEqual({ role: "builder", line: "the orbit route", at: now });
});

test("a row with no checkout on the board is nobody's worker, not every project's", () => {
  const counts = liveByRole([worker("builder", "builder", { project: undefined, state: "working" })], flow, PROJECT);
  expect(counts.builder).toEqual({ run: 0, wait: 0, cost: 0 });
});

test("a rename in another project does not fold this project's worker away", () => {
  const orbit = "/work/orbit";
  const rows = [
    worker("builder", "builder", { state: "working", facts: { cost: 2 } }),
    // Orbit's row once answered to "builder": the fold is per project, so it
    // cannot take acme's row of that name with it.
    worker("orbit-builder", "builder", { project: orbit, state: "working", facts: { cost: 5 }, wasCalled: ["builder"] }),
  ];
  expect(liveByRole(rows, flow, PROJECT).builder).toEqual({ run: 1, wait: 0, cost: 2 });
  expect(liveByRole(rows, flow, orbit).builder).toEqual({ run: 1, wait: 0, cost: 5 });
});

test("a worker started with --flow-role counts on that role's block, not on the policy role it maps to", () => {
  /* The Flow a project whose path uses its own roles has: `builder-orbit` is
     the builder step, `planner-orbit` the scout one. Each id is its own block. */
  const orbit = {
    ...flow,
    roster: [
      ...flow.roster,
      { ...flow.roster[1]!, id: "builder-orbit", name: "Builder orbit" },
      { ...flow.roster[0]!, id: "planner-orbit", name: "Planner orbit" },
    ],
  };
  const counts = liveByRole([
    worker("orbit-builder", "builder-orbit", { state: "working" }),
    // The other field the server answers on, once the stamp is all a row has.
    row("orbit-planner", { state: "working", startedBy: { role: "planner-orbit" } }),
    worker("acme-builder", "builder", { state: "working" }),
  ], orbit, PROJECT);
  expect(counts["builder-orbit"]).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(counts["planner-orbit"]).toEqual({ run: 1, wait: 0, cost: 0 });
  // The built-in block still counts only its own worker.
  expect(counts.builder).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(counts.planner).toEqual({ run: 0, wait: 0, cost: 0 });
  expect(inFlight(counts, { maxWorkers: 6 })).toEqual({ n: 3, of: 6 });
});

test("a built-in flow role answers to the policy role it runs as", () => {
  const counts = liveByRole([worker("planner", "scout", { state: "working" }), worker("inspector", "reviewer", { state: "working" })], flow, PROJECT);
  expect(counts.planner!.run).toBe(1);
  expect(counts.inspector!.run).toBe(1);
});

test("a project's own builder step owns a builder-stamped worker, ahead of the built-in the path does not use", () => {
  /* The canvas draws the path, and this project's builder step is its own
     `builder-orbit`; the shipped `builder` is still in the team, off the path.
     A start for that step can carry the policy role instead of the id — a
     flight plan's Launch asks for `builder`, a seat's `--role builder` — and a
     count that lands on the built-in block is a count nobody can see: the
     block on the path reads Idle while the hero says one is in flight. */
  const orbit = {
    ...flow,
    roster: [...flow.roster, { ...flow.roster[1]!, id: "builder-orbit", name: "Builder orbit" }],
    path: flow.path.map((id) => (id === "builder" ? "builder-orbit" : id)),
    blocks: flow.blocks.map((b) => (b.id === "builder" ? { ...b, id: "builder-orbit" } : b)),
  };
  const counts = liveByRole([worker("builder-orbit", "builder", { state: "working" })], orbit, PROJECT);
  expect(counts["builder-orbit"]).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(counts.builder).toEqual({ run: 0, wait: 0, cost: 0 });
  expect(inFlight(counts, { maxWorkers: 3 })).toEqual({ n: 1, of: 3 });
});

test("a custom flow-role worker in a worktree outside the project folder counts on its block", () => {
  /* A worker runs where its worktree was cut: an OpenCode worktree lives under
     the app's own data directory, not under the project. The server rolls the
     checkout up to the project it belongs to, and that is what this reads, so
     the block counts it and the hero's one number includes it. */
  const orbit = {
    ...flow,
    roster: [...flow.roster, { ...flow.roster[1]!, id: "builder-orbit", name: "Builder orbit" }],
    path: [...flow.path, "builder-orbit"],
    blocks: [...flow.blocks, { id: "builder-orbit", x: 0, y: 240 }],
  };
  const elsewhere = "/home/somebody/.local/share/opencode/worktree/desk/orbit";
  const counts = liveByRole([
    worker("orbit-builder", "builder-orbit", { state: "working", worktree: elsewhere, project: PROJECT }),
  ], orbit, PROJECT);
  expect(counts["builder-orbit"]).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(inFlight(counts, { maxWorkers: 3 })).toEqual({ n: 1, of: 3 });
});

test("a row the board drew without its role counts nowhere, whatever its checkout says", () => {
  /* What a row drawn from a pane sighting looks like when the registry's role
     is not carried onto it: it is this project's worker, in this project's
     worktree, and still nothing the block can count. */
  const counts = liveByRole([
    row("orbit-builder", { state: "working", worktree: "/work/acme/.worktrees/orbit" }),
  ], flow, PROJECT);
  expect(Object.values(counts).every((c) => c.run === 0)).toBe(true);
});

test("two roles on one policy role go to the first in the roster, and only one of them", () => {
  const twin = { ...flow, roster: [...flow.roster, { ...flow.roster[1]!, id: "builder-two", name: "Builder two" }] };
  const counts = liveByRole([worker("builder", "builder", { state: "working", facts: { cost: 2 } })], twin, PROJECT);
  expect(counts.builder).toEqual({ run: 1, wait: 0, cost: 2 });
  expect(counts["builder-two"]).toEqual({ run: 0, wait: 0, cost: 0 });
});

test("workers in flight is the flow's own count against the project's ceiling", () => {
  const counts = liveByRole([
    worker("builder", "builder", { state: "working" }),
    worker("planner", "scout", { state: "working" }),
    worker("inspector", "reviewer", { state: "waiting", needsYou: stopped("input") }),
  ], flow, PROJECT);
  expect(inFlight(counts, { maxWorkers: 6 })).toEqual({ n: 2, of: 6 });
  expect(inFlight(counts, { maxWorkers: 3 })).toEqual({ n: 2, of: 3 });
  expect(inFlight(liveByRole([], flow, PROJECT), { maxWorkers: 3 })).toEqual({ n: 0, of: 3 });
});

test("the last decision is the newest line a settled worker left, and null before one", () => {
  expect(lastDecision([], flow, PROJECT)).toBeNull();
  expect(lastDecision([worker("builder", "builder", { state: "working", doing: "writing the route" })], flow, PROJECT)).toBeNull();
  expect(lastDecision([worker("builder", "builder", { state: "idle", doing: "   " })], flow, PROJECT)).toBeNull();

  const earlier = worker("builder", "builder", { state: "idle", doing: "the route and its test", saidAt: now - 12 * min });
  const newer = worker("planner", "scout", { state: "working", doing: "cutting the ask into steps", saidAt: now - min });
  expect(lastDecision([earlier, newer], flow, PROJECT)).toEqual({ role: "builder", line: "the route and its test", at: now - 12 * min });

  const later = worker("inspector", "reviewer", { state: "idle", doing: "skipped QA only: docs-only change", saidAt: now - 2 * min });
  expect(lastDecision([earlier, newer, later], flow, PROJECT)).toEqual({ role: "inspector", line: "skipped QA only: docs-only change", at: now - 2 * min });
});

test("a worker stopped on a person has not settled on a decision yet", () => {
  const waiting = worker("builder", "builder", { state: "idle", needsYou: stopped("permission"), doing: "editing src/app.ts", saidAt: now });
  expect(lastDecision([waiting], flow, PROJECT)).toBeNull();
});

test("a worker's role is the registry's answer, and never its name", () => {
  expect(roleOf(worker("builder", "builder", { startedBy: { role: "scout" } }))).toBe("builder");
  expect(roleOf(row("claimed", { startedBy: { role: "verifier" } }))).toBe("verifier");
  expect(roleOf(row("builder notes"))).toBeNull();
  expect(roleOf(row("builder", { worker: { role: "  " } }))).toBeNull();
});

test("a worker started as the shipped team role counts on the path step that does the same job", () => {
  /* The path's review step is this project's own `inspector-orbit` (a
     reviewer); the shipped `inspector` (also a reviewer) is still in the team,
     off the path. Workers started as `inspector` counted on the team role: the
     path block read Idle while "Workers in flight" counted them. */
  const shipped = flow.roster.find((r) => r.id === "inspector")!;
  const orbit = {
    ...flow,
    roster: [...flow.roster, { ...shipped, id: "inspector-orbit", name: "Inspector orbit" }],
    path: flow.path.map((id) => (id === "inspector" ? "inspector-orbit" : id)),
    blocks: flow.blocks.map((b) => (b.id === "inspector" ? { ...b, id: "inspector-orbit" } : b)),
  };
  const counts = liveByRole([worker("orbit-inspect", "inspector", { state: "working" })], orbit, PROJECT);
  expect(counts["inspector-orbit"]).toEqual({ run: 1, wait: 0, cost: 0 });
  expect(counts.inspector).toEqual({ run: 0, wait: 0, cost: 0 });
  // A path step with no job of its own is not guessed at: the worker stays on the role it named.
  const bare = { ...orbit, roster: orbit.roster.map((r) => (r.id === "inspector-orbit" ? { ...r, policyRole: undefined } : r)) };
  const still = liveByRole([worker("orbit-inspect", "inspector", { state: "working" })], bare, PROJECT);
  expect(still.inspector!.run).toBe(1);
  expect(still["inspector-orbit"]!.run).toBe(0);
});
