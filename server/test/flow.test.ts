/*
 * THE FLOW AS DATA — the steps a project's orchestrator follows, before any
 * screen draws them.
 *
 * Two halves. The first is in this process: the record, the template, the
 * paragraph the seat is told, and that the policy and the flow cannot overwrite
 * each other. The second boots a server, because the routes are the only way a
 * person reaches this, and who may write them is a promise and not a comment.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { allowed } from "../src/auth.ts";
import { NEVER_LIFTABLE } from "../../shared/workerRoles.ts";
import type { Flow } from "../../shared/flow.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-flow-"));
const restore = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  AGENTGLASS_DOCTRINE: process.env.AGENTGLASS_DOCTRINE,
  AGENTGLASS_DB: process.env.AGENTGLASS_DB,
};
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DOCTRINE = join(dir, "doctrine");
process.env.AGENTGLASS_DB = join(dir, "flow.db");

const { checkDeviation, noteDeviation, readFlow, writeFlow, deleteFlow, undoFlowWrite, renderFlowForOrchestrator, roleLines, ROLE_LINES_MAX, nextPathRole, autoContinueOn } = await import("../src/flow.ts");
const { readStoredFlow } = await import("../src/config.ts");
const { flowWriteAccess, FLOW_PERSON, FLOW_AGENT_EDIT_OFF } = await import("../src/flowaccess.ts");
const { readPolicy, writePolicy } = await import("../src/orchestration.ts");
const { templateFlow } = await import("../../shared/flowTemplates.ts");
const { validateFlow, FLOW_ICONS, FLOW_HUES } = await import("../../shared/flow.ts");
const Seat = await import("../src/seat.ts");
const { putSetting } = await import("../src/preflightStore.ts");

afterAll(() => {
  for (const [k, v] of Object.entries(restore)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The template with QA between the Inspector and the Verifier, as the owner asked for it. */
function withQa(): Flow {
  const f = templateFlow();
  const after = f.path.indexOf("inspector") + 1;
  f.path = [...f.path.slice(0, after), "qa-only", ...f.path.slice(after)];
  f.roster = f.roster.map((r) => (r.id === "qa-only" ? { ...r, required: true } : r));
  f.blocks = f.path.map((id, i) => ({ id, x: i * 240, y: 0 }));
  f.edges = [
    ...f.edges,
    { from: "inspector", to: "qa-only", on: "pass" },
    { from: "qa-only", to: "verifier", on: "pass" },
    { from: "qa-only", to: "builder", on: "fail", maxRounds: 2 },
  ];
  return f;
}

describe("the flow a project has when it saved none", () => {
  test("the shipped template passes the validator", () => {
    expect(validateFlow(templateFlow()).ok).toBe(true);
  });

  test("is the template, and it is data rather than a picture", () => {
    const v = readFlow(join(dir, "proj-template"));
    expect(v.scope).toBe("template");
    expect(v.flow.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
    expect(v.flow.roster.map((r) => r.id)).toContain("qa-only");
    expect(v.flow.roster.every((r) => r.required === false)).toBe(true);
  });

  /* The mockup is the contract for the shape: every stage word, role name and
     prompt the editor draws comes from here, and a screen may not need a field
     that this data does not carry. */
  test("carries every stage, role and prompt the approved mockup draws", () => {
    const f = templateFlow();
    expect(f.stages.map((s) => s.label)).toEqual(["Shaping", "In development", "In code review", "QA", "Verifier", "Ready to land"]);
    expect(f.roster.map((r) => r.name)).toEqual([
      "Planner", "Builder", "Inspector", "Verifier", "Landing",
      "QA-only", "Continuous development", "DevOps · server", "Security",
      "Frontend", "Backend · Node", "CI", "Deployment", "Docs", "General",
    ]);
    for (const r of f.roster) {
      expect(r.does.length).toBeGreaterThan(10);
      expect(r.prompt.length).toBeGreaterThan(40);
      expect(f.stages.some((s) => s.id === r.stage)).toBe(true);
      expect(FLOW_ICONS).toContain(r.ico as (typeof FLOW_ICONS)[number]);
      expect(FLOW_HUES).toContain(r.hue as (typeof FLOW_HUES)[number]);
    }
    /* The QA column the editor's board draws: QA-only sits in it, not in the
       Verifier's, so the board and the roster agree on the stage's name. */
    expect(f.roster.find((r) => r.id === "qa-only")!.stage).toBe("qa");
    const landing = f.roster.find((r) => r.id === "landing")!;
    expect(landing.actor).toBe("person");
    expect(landing.chain).toEqual([]);
    expect(landing.hue).toBe("warning");
    expect(f.roster.find((r) => r.id === "qa-only")!.chain.length).toBeGreaterThan(0);
    expect(f.edges.find((e) => e.from === "verifier" && e.on === "fail")!.maxRounds).toBe(2);
  });

  test("gives every built-in role its chain from the policy, read and never saved", () => {
    const root = join(dir, "proj-chains");
    const v = readFlow(root);
    const planner = v.flow.roster.find((r) => r.id === "planner")!;
    expect(planner.policyRole).toBe("scout");
    expect(planner.chain).toEqual([]);
    expect(planner.resolvedChain!.length).toBeGreaterThan(0);
    // A role a person's team owns keeps its own chain, resolved as itself.
    const qa = v.flow.roster.find((r) => r.id === "qa-only")!;
    expect(qa.resolvedChain).toEqual(qa.chain);
  });

  test("a save that carries the resolved chains back does not store them", () => {
    const root = join(dir, "proj-no-resolved");
    const v = readFlow(root);
    expect(writeFlow(root, v.flow).ok).toBe(true);
    const stored = readStoredFlow(root)!;
    for (const r of stored.roster) expect(r.resolvedChain).toBeUndefined();
    expect(stored.roster.find((r) => r.id === "planner")!.chain).toEqual([]);
  });
});

describe("the round cap is the setting, not the arrow", () => {
  const cap = (v: ReturnType<typeof readFlow>, from: string) => v.flow.edges.find((e) => e.on === "fail" && e.from === from)!.maxRounds;

  test("the reviewer's fail arrow reads the setting, the other arrows keep their own", () => {
    const root = join(dir, "proj-rounds-read");
    putSetting(root, "orchestration.review.rounds", 5);
    const v = readFlow(root);
    expect(cap(v, "inspector")).toBe(5);
    expect(cap(v, "verifier")).toBe(2);
  });

  test("a write that edits that arrow is ignored, and the setting moves it instead", () => {
    const root = join(dir, "proj-rounds-write");
    putSetting(root, "orchestration.review.rounds", 4);
    const flow = readFlow(root).flow;
    flow.edges = flow.edges.map((e) => (e.on === "fail" && e.from === "inspector" ? { ...e, maxRounds: 9 } : e));
    expect(writeFlow(root, flow).ok).toBe(true);
    const stored = readStoredFlow(root)!;
    expect(stored.edges.find((e) => e.on === "fail" && e.from === "inspector")!.maxRounds).not.toBe(9);
    expect(cap(readFlow(root), "inspector")).toBe(4);
    putSetting(root, "orchestration.review.rounds", 2);
    expect(cap(readFlow(root), "inspector")).toBe(2);
  });

  test("a write that edits another fail arrow is kept", () => {
    const root = join(dir, "proj-rounds-other");
    const flow = readFlow(root).flow;
    flow.edges = flow.edges.map((e) => (e.on === "fail" && e.from === "verifier" ? { ...e, maxRounds: 7 } : e));
    expect(writeFlow(root, flow).ok).toBe(true);
    expect(cap(readFlow(root), "verifier")).toBe(7);
  });

  test("the orchestrator is told the one number", () => {
    const root = join(dir, "proj-rounds-brief");
    putSetting(root, "orchestration.review.rounds", 6);
    expect(renderFlowForOrchestrator(readFlow(root).flow)).toContain("up to 6 times");
  });
});

describe("a step a person adds", () => {
  test("QA between the Inspector and the Verifier survives a write and a read", () => {
    const root = join(dir, "proj-orbit");
    const r = writeFlow(root, withQa());
    expect(r.ok).toBe(true);
    const v = readFlow(root);
    expect(v.scope).toBe("project");
    expect(v.flow.path).toEqual(["planner", "builder", "inspector", "qa-only", "verifier", "landing"]);
    expect(v.flow.roster.find((x) => x.id === "qa-only")!.required).toBe(true);
    expect(v.flow.edges.find((e) => e.from === "qa-only" && e.on === "fail")!.maxRounds).toBe(2);
  });

  test("and a second project keeps the template while the first keeps its own", () => {
    const mine = join(dir, "proj-orbit");
    const other = join(dir, "proj-acme");
    expect(writeFlow(mine, withQa()).ok).toBe(true);
    expect(readFlow(mine).flow.path).toContain("qa-only");
    expect(readFlow(other).scope).toBe("template");
    expect(readFlow(other).flow.path).not.toContain("qa-only");
  });

  test("removing the saved flow falls back to the template", () => {
    const root = join(dir, "proj-reset");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(readFlow(root).scope).toBe("project");
    const r = deleteFlow(root);
    expect(r.ok).toBe(true);
    expect(r.ok && r.view.scope).toBe("template");
    expect(readFlow(root).flow.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
  });
});

describe("one step back", () => {
  test("a write keeps the flow before it, and the person's undo puts it back", () => {
    const root = join(dir, "proj-undo");
    expect(writeFlow(root, withQa(), "the chair of orbit").ok).toBe(true);
    expect(readFlow(root).undo?.who).toBe("the chair of orbit");
    const r = undoFlowWrite(root);
    expect(r.ok).toBe(true);
    expect(r.ok && r.who).toBe("the chair of orbit");
    expect(readFlow(root).scope).toBe("template");
    expect(readFlow(root).undo).toBeNull();
  });

  test("a person's write after an agent's replaces the step, so undo undoes the person's", () => {
    const root = join(dir, "proj-undo-replace");
    expect(writeFlow(root, withQa(), "the chair of orbit").ok).toBe(true);
    const second = withQa();
    second.roster = second.roster.map((r) => (r.id === "qa-only" ? { ...r, name: "QA again" } : r));
    expect(writeFlow(root, second, "the person").ok).toBe(true);
    expect(readFlow(root).undo?.who).toBe("the person");
    const r = undoFlowWrite(root);
    expect(r.ok).toBe(true);
    expect(readFlow(root).flow.roster.find((x) => x.id === "qa-only")!.name).toBe("QA-only");
  });

  test("a write that changes nothing keeps the step, so the edit before it stays undoable", () => {
    const root = join(dir, "proj-undo-noop");
    expect(writeFlow(root, withQa(), "the person").ok).toBe(true);
    const wanted = withQa();
    wanted.roster = wanted.roster.map((r) => (r.id === "qa-only" ? { ...r, name: "QA again" } : r));
    expect(writeFlow(root, wanted, "the chair of orbit").ok).toBe(true);
    // The seat writes the same value again, as the CLI does when it reads and saves back.
    expect(writeFlow(root, wanted, "the chair of orbit").ok).toBe(true);
    expect(readFlow(root).undo?.who).toBe("the chair of orbit");
    const r = undoFlowWrite(root);
    expect(r.ok).toBe(true);
    expect(readFlow(root).flow.roster.find((x) => x.id === "qa-only")!.name).toBe("QA-only");
  });

  test("deleting a saved flow keeps it, and undo restores it", () => {
    const root = join(dir, "proj-undo-delete");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(deleteFlow(root, "the chair of orbit").ok).toBe(true);
    expect(readFlow(root).scope).toBe("template");
    const r = undoFlowWrite(root);
    expect(r.ok).toBe(true);
    expect(readFlow(root).scope).toBe("project");
    expect(readFlow(root).flow.path).toContain("qa-only");
  });

  test("a second undo answers nothing to undo", () => {
    const root = join(dir, "proj-undo-once");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(undoFlowWrite(root).ok).toBe(true);
    const again = undoFlowWrite(root);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error).toBe("nothing to undo");
  });
});

describe("who may write the flow", () => {
  const on = () => true;
  const off = () => false;
  const seat = { person: false, seatRoot: "/orbit", root: "/orbit", agentEdit: on, controlLevel: 2 as const, readonly: false };

  test("the person's own window writes it, as before", () => {
    expect(flowWriteAccess({ ...seat, person: true, root: "/orbit" }).ok).toBe(true);
  });

  test("the seat of this project writes when flow.agentEdit is on", () => {
    const r = flowWriteAccess(seat);
    expect(r.ok).toBe(true);
    expect(r.root).toBe("/orbit");
  });

  test("the seat of this project, with the setting off, hears which switch", () => {
    const r = flowWriteAccess({ ...seat, agentEdit: off });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe(FLOW_AGENT_EDIT_OFF);
  });

  test("an agent that is not a seat, or another project's seat, hears the person's sentence and not the switch", () => {
    const notASeat = flowWriteAccess({ ...seat, seatRoot: undefined });
    expect(!notASeat.ok && notASeat.error).toBe(FLOW_PERSON);
    const other = flowWriteAccess({ ...seat, seatRoot: "/acme" });
    expect(!other.ok && other.error).toBe(FLOW_PERSON);
    expect(!other.ok && other.error).not.toContain("flow.agentEdit");
  });

  test("a seat in a worktree of its project writes the project's own record", () => {
    const r = flowWriteAccess({ ...seat, root: "/orbit/.worktrees/task-1" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.root).toBe("/orbit");
  });

  test("the control level is 2 only: 1 looks, 3 stages, readonly is refused", () => {
    const held = flowWriteAccess({ ...seat, controlLevel: 1 });
    expect(held.ok).toBe(false);
    expect(!held.ok && held.error).toContain("allows up to level 1");
    expect(flowWriteAccess({ ...seat, controlLevel: 2 }).ok).toBe(true);
    const staged = flowWriteAccess({ ...seat, controlLevel: 3 });
    expect(staged.ok).toBe(false);
    expect(!staged.ok && staged.error).toContain("level 3 only stages");
    expect(flowWriteAccess({ ...seat, controlLevel: 2, readonly: true }).ok).toBe(false);
  });
});

describe("what a flow refuses, in sentences", () => {
  const errorOf = (f: unknown): string => {
    const v = validateFlow(f);
    return v.ok ? "" : v.error;
  };

  test("the Gate is last or the flow is refused", () => {
    const f = templateFlow();
    expect(errorOf(f)).toBe("");
    const mid = { ...f, path: ["planner", "landing", "builder", "inspector", "verifier"] };
    expect(errorOf(mid)).toContain("has to be the last step");
  });

  test("an old flow with the Gate mid-path still loads, and only a move that does not worsen it saves", () => {
    const { writeStoredFlow } = require("../src/config.ts");
    const root = join(dir, "proj-old-gate");
    const old = { ...templateFlow(), path: ["planner", "landing", "builder", "inspector", "verifier"] };
    expect(writeStoredFlow(root, old).ok).toBe(true);
    expect(readStoredFlow(root)?.path).toEqual(old.path);
    expect(readFlow(root).flow.path).toEqual(old.path);
    // Further from the end: refused. The same place: allowed. The Gate at the end: allowed.
    expect(writeFlow(root, { ...old, path: ["landing", "planner", "builder", "inspector", "verifier"] }).ok).toBe(false);
    expect(writeFlow(root, { ...old, path: ["planner", "landing", "inspector", "builder", "verifier"] }).ok).toBe(true);
    expect(writeFlow(root, { ...old, path: ["planner", "builder", "inspector", "verifier", "landing"] }).ok).toBe(true);
    expect(readStoredFlow(root)?.path.at(-1)).toBe("landing");
    // A fresh flow still cannot put the Gate mid-path.
    expect(writeFlow(join(dir, "proj-new-gate"), old).ok).toBe(false);
  });

  test("a failing arrow needs a target and a round cap", () => {
    const noCap = withQa();
    noCap.edges = noCap.edges.map((e) => (e.from === "qa-only" && e.on === "fail" ? { from: e.from, to: e.to, on: e.on } : e));
    expect(errorOf(noCap)).toContain("maxRounds");

    const noTarget = withQa();
    noTarget.edges = [...noTarget.edges, { from: "qa-only", on: "fail", maxRounds: 2 } as never];
    expect(errorOf(noTarget)).toMatch(/flow\.edges\[\d+\]\.to: is missing/);

    const offPath = withQa();
    offPath.edges = [...offPath.edges, { from: "qa-only", to: "docs", on: "fail", maxRounds: 2 }];
    expect(errorOf(offPath)).toContain("not on the suggested path");
  });

  test("a passing arrow carries no round cap", () => {
    const f = withQa();
    f.edges = [...f.edges, { from: "planner", to: "builder", on: "pass", maxRounds: 2 } as never];
    expect(errorOf(f)).toContain("belongs to a failing arrow");
  });

  test("two roles cannot share an id", () => {
    const f = withQa();
    f.roster = [...f.roster, { ...f.roster.find((r) => r.id === "qa-only")!, name: "QA again" }];
    expect(errorOf(f)).toContain("already another role");
  });

  test("a block's icon and colour come from the drawn set", () => {
    const icon = withQa();
    icon.roster = icon.roster.map((r) => (r.id === "qa-only" ? { ...r, ico: "bogus" } : r));
    expect(errorOf(icon)).toContain(".ico: is not one of the icons");

    const hue = withQa();
    hue.roster = hue.roster.map((r) => (r.id === "qa-only" ? { ...r, hue: "pink" } : r));
    expect(errorOf(hue)).toContain(".hue: is not one of the colour tokens");
  });

  test("a role needs its one line, and a second role cannot go without it", () => {
    const f = withQa();
    const { does: _drop, ...without } = f.roster.find((r) => r.id === "docs")!;
    f.roster = f.roster.map((r) => (r.id === "docs" ? (without as typeof r) : r));
    expect(errorOf(f)).toContain("flow.roster[13].does");
  });

  test("a step nobody runs cannot be required", () => {
    const f = withQa();
    f.path = f.path.filter((id) => id !== "qa-only");
    expect(errorOf(f)).toContain("cannot be required");
  });

  test("a built-in role does not carry a chain of its own", () => {
    const f = withQa();
    f.roster = f.roster.map((r) => (r.id === "planner" ? { ...r, chain: [{ engine: "claude", model: "haiku" }] } : r));
    expect(errorOf(f)).toContain("policy's");
  });

  test("a person's step keeps no chain and no built-in beside it, and may be reads-only", () => {
    const reads = withQa();
    reads.roster = reads.roster.map((r) => (r.id === "landing" ? { ...r, readsOnly: true } : r));
    const v = validateFlow(reads);
    expect(v.ok).toBe(true);
    const landing = v.ok && v.value.roster.find((r) => r.id === "landing")!;
    expect(landing && [landing.actor, landing.readsOnly, landing.chain]).toEqual(["person", true, []]);

    const chained = withQa();
    chained.roster = chained.roster.map((r) => (r.id === "landing" ? { ...r, chain: [{ engine: "claude", model: "haiku" }] } : r));
    expect(errorOf(chained)).toContain("a person answers this step");

    const both = withQa();
    both.roster = both.roster.map((r) => (r.id === "landing" ? { ...r, policyRole: "verifier" as const } : r));
    expect(errorOf(both)).toContain("and policyRole cannot both be set");
  });

  test("no sentence says true or false", () => {
    const f = withQa();
    const messages = [
      errorOf({ ...f, version: 2 }),
      errorOf({ ...f, roster: f.roster.map((r) => (r.id === "qa-only" ? { ...r, readsOnly: "yes" } : r)) }),
      errorOf({ ...f, roster: f.roster.map((r) => (r.id === "qa-only" ? { ...r, required: 1 } : r)) }),
      errorOf({ ...f, edges: [{ from: "planner", to: "builder", on: true }] }),
      errorOf({ ...f, path: [] }),
    ];
    for (const m of messages) {
      expect(m.length).toBeGreaterThan(0);
      expect(m).not.toMatch(/\btrue\b|\bfalse\b/i);
    }
  });

  test("a role may be granted a command the floor refuses, and never one it keeps for a person", () => {
    const granted = withQa();
    granted.roster = granted.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["docker", "make deploy"] } : r));
    const v = validateFlow(granted);
    expect(v.ok).toBe(true);
    expect(v.ok && v.value.roster.find((r) => r.id === "qa-only")!.allow).toEqual(["docker", "make deploy"]);

    for (const never of NEVER_LIFTABLE) {
      const f = withQa();
      f.roster = f.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: [never] } : r));
      expect(errorOf(f)).toContain(`"${never}" is never granted to a worker`);
    }
    // The seat can push and use gh, so a role may name them; sudo is the floor.
    const seats = withQa();
    seats.roster = seats.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["git push", "gh", "rm"] } : r));
    expect(validateFlow(seats).ok).toBe(true);
    const sudo = withQa();
    sudo.roster = sudo.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["sudo -u x"] } : r));
    expect(errorOf(sudo)).toContain('"sudo" is never granted to a worker');

    const shaped = withQa();
    shaped.roster = shaped.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["$(whoami)"] } : r));
    expect(errorOf(shaped)).toContain("is not a command prefix");

    const twice = withQa();
    twice.roster = twice.roster.map((r) => (r.id === "qa-only" ? { ...r, allow: ["docker", "docker"] } : r));
    expect(errorOf(twice)).toContain("repeats a command the role already has");
  });

  test("a role id keeps its kind, so QA cannot become a reviewer under the same name", () => {
    const root = join(dir, "proj-kind");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const next = readStoredFlow(root)!;
    next.roster = next.roster.map((r) => (r.id === "qa-only" ? { ...r, policyRole: "reviewer" as const, chain: [] } : r));
    const r = writeFlow(root, next);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("keeps its kind");
    expect(readFlow(root).flow.roster.find((x) => x.id === "qa-only")!.policyRole).toBeUndefined();
  });
});

describe("the policy and the flow are two records", () => {
  test("a policy write leaves the flow intact", () => {
    const root = join(dir, "proj-both");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const p = readPolicy(root).policy;
    const w = writePolicy(root, { ...p, rules: [{ id: "r1", name: "Rule r1", enabled: true, when: [{ kind: "always" }], workers: { builder: p.base.workers.builder.value } }] });
    expect(w.ok).toBe(true);
    expect(readFlow(root).flow.path).toContain("qa-only");
  });

  test("a flow write leaves the policy intact, and an old record with no flow reads the template", () => {
    const root = join(dir, "proj-old");
    const p = readPolicy(root).policy;
    expect(writePolicy(root, { ...p, rules: [{ id: "keep-me", name: "Keep me", enabled: true, when: [{ kind: "always" }], workers: { builder: p.base.workers.builder.value } }] }).ok).toBe(true);
    expect(readFlow(root).scope).toBe("template");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    expect(readPolicy(root).policy.rules.map((r) => r.id)).toEqual(["keep-me"]);
  });
});

describe("the next role on the path, for auto-continue", () => {
  test("the role after a known one, in template order", () => {
    const f = templateFlow();
    expect(nextPathRole(f, "planner")).toBe("builder");
    expect(nextPathRole(f, "inspector")).toBe("verifier");
  });

  test("null at the end of the path", () => {
    expect(nextPathRole(templateFlow(), "landing")).toBe(null);
  });

  test("null for a role not on the path", () => {
    expect(nextPathRole(templateFlow(), "no-such-role")).toBe(null);
  });

  test("auto-continue is off until the setting turns it on", () => {
    const root = join(dir, "proj-auto-continue");
    expect(autoContinueOn(root)).toBe(false);
    putSetting(root, "flow.autoContinue", true);
    expect(autoContinueOn(root)).toBe(true);
  });
});

describe("the paragraph the orchestrator is told", () => {
  test("names the path, the team and the step that cannot be skipped", () => {
    const text = renderFlowForOrchestrator(withQa());
    expect(text).toContain("Planner → Builder → Inspector → QA-only → Verifier → Landing");
    expect(text).toContain("The team:");
    expect(text).toContain("QA-only cannot be skipped");
    expect(text).toContain("The orchestrator follows this flow; agentglass does not force it step by step.");
    expect(text).not.toMatch(/\btrue\b|\bfalse\b/i);
  });

  test("a roster line shows reads only and tools when set, neither when not", () => {
    const f = templateFlow();
    f.roster = f.roster.map((r) => (r.id === "inspector" ? { ...r, readsOnly: true, tools: ["read", "grep"] } : { ...r, readsOnly: false, tools: [] }));
    const text = renderFlowForOrchestrator(f);
    const line = (n: string) => text.split("\n").find((l) => l.startsWith(`${n}: `))!;
    expect(line("Inspector")).toContain("; reads only; tools: read, grep");
    expect(line("Builder")).not.toMatch(/reads only|tools:/);
    expect(text).toContain("A worker you start with --role gets that role's prompt automatically.");
  });

  test("the role lines hold the cap on a 12-role flow: tools go first, then does, names stay", () => {
    const f = templateFlow();
    const base = f.roster[0]!;
    f.roster = Array.from({ length: 12 }, (_, i) => ({ ...base, id: `r${i}`, name: `Role-${i}`, does: "d".repeat(90), readsOnly: true, tools: ["read", "run", "write", "commit", "notes"] }));
    const lines = roleLines(f.roster);
    expect(lines.length).toBeLessThanOrEqual(ROLE_LINES_MAX);
    for (let i = 0; i < 12; i++) expect(lines).toContain(`Role-${i}`);
    expect(lines).not.toContain("tools:");
    expect(lines).toContain("A worker you start with --role");
  });

  test("says so plainly when nothing is required", () => {
    expect(renderFlowForOrchestrator(templateFlow())).toContain("No step is required");
  });

  test("the real seat brief carries it, and the step a person added is in the brief", async () => {
    const root = join(dir, "proj-brief");
    expect(writeFlow(root, withQa()).ok).toBe(true);
    const { prompt } = await Seat.seatPrompt(root, "speak", 4);
    expect(prompt).toContain("The orchestrator follows this flow; agentglass does not force it step by step.");
    expect(prompt).toContain("Planner → Builder → Inspector → QA-only → Verifier → Landing");
    expect(prompt).toContain("QA-only cannot be skipped");
  });
});

/* ── the routes, on a server of their own ───────────────────────────────── */

const TOKEN = "tok-flow-example";
let base = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = (b: string) => ({ ...auth, Origin: b, "Content-Type": "application/json" });
const fromAgent = { ...auth, "Content-Type": "application/json" };

const getFlow = async (path: string) => (await fetch(base + path, { headers: auth })).json() as Promise<{ ok: boolean; error?: string; scope?: string; flow?: Flow }>;
const putFlow = (root: string | undefined, body: unknown, headers: Record<string, string>) =>
  fetch(`${base}/flow${root ? `?root=${encodeURIComponent(root)}` : ""}`, { method: "PUT", headers, body: JSON.stringify(body) });
const removeFlow = (root: string, headers: Record<string, string>) =>
  fetch(`${base}/flow?root=${encodeURIComponent(root)}`, { method: "DELETE", headers });

describe("/flow on a server", () => {
  test("boots", async () => {
    mkdirSync(join(dir, "home"), { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "home", "config"), XDG_DATA_HOME: join(dir, "home", "data"),
        XDG_CACHE_HOME: join(dir, "home", "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "home", "state"),
        AGENTGLASS_ROOT: join(dir, "home"),
        AGENTGLASS_DB: join(dir, "server.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_TOKEN: TOKEN,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
      await Bun.sleep(100);
    }
    throw new Error("server did not start");
  }, SERVER_BOOT_MS);

  afterAll(() => {
    proc?.kill();
    /* And the in-process record, written into a home of its own above. */
  });

  test("with nothing saved it answers the template", async () => {
    const root = join(dir, "route-plain");
    const v = await getFlow(`/flow?root=${encodeURIComponent(root)}`);
    expect(v.ok).toBe(true);
    expect(v.scope).toBe("template");
    expect(v.flow!.path).toEqual(["planner", "builder", "inspector", "verifier", "landing"]);
  });

  test("a root is required, and a relative one is refused with the policy's sentence", async () => {
    const none = (await fetch(`${base}/flow`, { headers: auth })).json() as Promise<{ error: string }>;
    expect((await none).error).toContain("root:");
    const rel = (await fetch(`${base}/flow?root=orbit`, { headers: auth })).json() as Promise<{ error: string }>;
    expect((await rel).error).toContain("has to be an absolute path");
  });

  test("the person's window stores one and reads it back", async () => {
    const root = join(dir, "route-orbit");
    const res = await putFlow(root, withQa(), fromApp(base));
    expect(res.status).toBe(200);
    const v = await getFlow(`/flow?root=${encodeURIComponent(root)}`);
    expect(v.scope).toBe("project");
    expect(v.flow!.path).toContain("qa-only");

    const gone = await removeFlow(root, fromApp(base));
    expect(gone.status).toBe(200);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("an agent is refused on both verbs, and nothing is written", async () => {
    const root = join(dir, "route-agent");
    const put = await putFlow(root, withQa(), fromAgent);
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: string }).error).toContain("the flow is the person's");
    const del = await removeFlow(root, fromAgent);
    expect(del.status).toBe(403);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a caller that names itself an agent is refused even from the app's origin", async () => {
    const root = join(dir, "route-named");
    const res = await putFlow(root, withQa(), { ...fromApp(base), "x-agentglass-agent": "acme/orbit" });
    expect(res.status).toBe(403);
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a refused body names the field and changes nothing", async () => {
    const root = join(dir, "route-bad");
    const bad = withQa();
    bad.edges = bad.edges.map((e) => (e.from === "qa-only" && e.on === "fail" ? { from: e.from, to: e.to, on: e.on } : e));
    const res = await putFlow(root, bad, fromApp(base));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("flow.edges");
    expect((await getFlow(`/flow?root=${encodeURIComponent(root)}`)).scope).toBe("template");
  });

  test("a seat reaches the flow at no power, and the route decides whether it may write", () => {
    const seat = { kind: "machine", scope: "full", principal: "seat", seat: { root: "/orbit", powers: "assign" } } as const;
    expect(allowed(seat, "GET", "/flow")).toBe(true);
    expect(allowed(seat, "PUT", "/flow")).toBe(true);
    expect(allowed(seat, "DELETE", "/flow")).toBe(true);
    // The undo is the person's: the wall does not let a seat near it.
    expect(allowed(seat, "POST", "/flow/undo")).toBe(false);
  });
});

/* ── the seat, its setting, and the CLI, on a server that minted its token ── */

const SEAT_ROOT = join(dir, "seat-project");
const SEAT_SERVER_TOKEN = "tok-flow-seat-server";
let seatBase = "";
let seatToken = "";
let seatProc: ReturnType<typeof Bun.spawn> | null = null;

const seatApp = (b: string) => ({ Authorization: `Bearer ${SEAT_SERVER_TOKEN}`, Origin: b, "Content-Type": "application/json" });

const seatHeaders = () => ({ Authorization: `Bearer ${seatToken}`, "Content-Type": "application/json" });
const seatPut = (root: string, body: unknown) =>
  fetch(`${seatBase}/flow?root=${encodeURIComponent(root)}`, { method: "PUT", headers: seatHeaders(), body: JSON.stringify(body) });
const seatGet = async (root: string) => (await fetch(`${seatBase}/flow?root=${encodeURIComponent(root)}`, { headers: seatHeaders() })).json() as Promise<{ ok: boolean; scope?: string; flow?: Flow; undo?: { who: string } | null; error?: string }>;
const seatUndo = () => fetch(`${seatBase}/flow/undo?root=${encodeURIComponent(SEAT_ROOT)}`, { method: "POST", headers: seatHeaders(), body: "{}" });
const personSet = (id: string, value: unknown, root?: string) =>
  fetch(`${seatBase}/settings/door`, { method: "POST", headers: seatApp(seatBase), body: JSON.stringify({ id, value, ...(root ? { root } : {}) }) });

/** Run the agent's own CLI against the seat server, as the seat. */
async function cli(args: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  const p = Bun.spawn(["python3", new URL("../../bin/agentglass-ui", import.meta.url).pathname, ...args], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"),
      AGENTGLASS_SERVER: seatBase, AGENTGLASS_TOKEN: seatToken, AGENTGLASS_SEAT: "1",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const text = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  await p.exited;
  let out: Record<string, unknown> = {};
  try { out = JSON.parse(text) as Record<string, unknown>; } catch { out = { raw: text }; }
  if (err) out.stderr = err;
  return { code: p.exitCode ?? 1, out };
}

describe("the seat edits its own flow", () => {
  test("boots with a seat token for its project", async () => {
    mkdirSync(SEAT_ROOT, { recursive: true });
    const port = await freePort();
    seatBase = `http://127.0.0.1:${port}`;
    const tokenFile = join(dir, "seat.token");
    seatProc = Bun.spawn(["bun", "run", new URL("./seatBoot.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: join(dir, "seat-home"), XDG_CONFIG_HOME: join(dir, "seat-home", "config"), XDG_DATA_HOME: join(dir, "seat-home", "data"),
        XDG_CACHE_HOME: join(dir, "seat-home", "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "seat-home", "state"),
        AGENTGLASS_ROOT: join(dir, "seat-home"),
        AGENTGLASS_DB: join(dir, "seat.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
        AGENTGLASS_TOKEN: SEAT_SERVER_TOKEN,
        SEAT_BOOT_TOKEN: tokenFile,
        SEAT_BOOT_ROOT: SEAT_ROOT,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(seatBase + "/health")).ok) { seatToken = readFileSync(tokenFile, "utf8").trim(); return; } } catch { /* booting */ }
      await Bun.sleep(100);
    }
    throw new Error("seat server did not start");
  }, SERVER_BOOT_MS);

  afterAll(() => { seatProc?.kill(); });

  test("with the setting off the seat hears which switch, and nothing is written", async () => {
    const res = await seatPut(SEAT_ROOT, withQa());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(FLOW_AGENT_EDIT_OFF);
    expect((await seatGet(SEAT_ROOT)).scope).toBe("template");
  });

  test("another project's seat hears the person's sentence, not the switch's state", async () => {
    const res = await seatPut(join(dir, "seat-other"), withQa());
    expect(res.status).toBe(403);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toBe(FLOW_PERSON);
    expect(error).not.toContain("flow.agentEdit");
  });

  test("the person turns it on in Settings; the seat then writes, and the person undoes", async () => {
    const on = await personSet("flow.agentEdit", true, SEAT_ROOT);
    expect(on.status).toBe(200);
    // Off is the safer direction: an agent's turn-off applies at once. On is the person's alone.
    const off = await cli(["settings", "set", "flow.agentEdit", "false", "--root", SEAT_ROOT]);
    expect(off.code).toBe(0);
    expect(off.out).toMatchObject({ ok: true, applied: true });
    const onAsk = await cli(["settings", "set", "flow.agentEdit", "true", "--root", SEAT_ROOT]);
    expect(onAsk.code).toBe(1);
    expect(String(onAsk.out.error)).toContain("only the person");
    const onAgain = await personSet("flow.agentEdit", true, SEAT_ROOT);
    expect(onAgain.status).toBe(200);
    const written = await seatPut(SEAT_ROOT, withQa());
    expect(written.status).toBe(200);
    const view = await seatGet(SEAT_ROOT);
    expect(view.scope).toBe("project");
    expect(view.flow!.path).toContain("qa-only");
    expect(view.undo?.who).toBe("the chair of seat-project");

    // The undo is the person's own window.
    expect((await seatUndo()).status).toBe(403);
    const undone = await fetch(`${seatBase}/flow/undo?root=${encodeURIComponent(SEAT_ROOT)}`, { method: "POST", headers: seatApp(seatBase), body: "{}" });
    expect(undone.status).toBe(200);
    const answer = (await undone.json()) as { undone?: string; flow?: Flow };
    expect(answer.undone).toBe("the chair of seat-project");
    expect((await seatGet(SEAT_ROOT)).scope).toBe("template");
  });

  test("the CLI creates planner-x with a prompt and puts it on the path; the page shows it; the person undoes it", async () => {
    const add = await cli(["flow", "role", "add", "planner-x",
      "--name", "Planner X", "--does", "Cuts the ask into steps.", "--prompt", "Plan the work and hand it back.",
      "--policy-role", "builder", "--after", "builder", "--root", SEAT_ROOT]);
    expect(add.code).toBe(0);
    expect(add.out.ok).toBe(true);
    const view = await seatGet(SEAT_ROOT);
    const role = view.flow!.roster.find((r) => r.id === "planner-x");
    expect(role?.name).toBe("Planner X");
    expect(role?.prompt).toBe("Plan the work and hand it back.");
    expect(role?.policyRole).toBe("builder");
    expect(role?.tools).toEqual(["read", "run", "write", "commit"]);
    expect(view.flow!.path).toContain("planner-x");
    expect(view.flow!.path.indexOf("planner-x")).toBe(view.flow!.path.indexOf("builder") + 1);

    const undo = await fetch(`${seatBase}/flow/undo?root=${encodeURIComponent(SEAT_ROOT)}`, { method: "POST", headers: seatApp(seatBase), body: "{}" });
    expect(undo.status).toBe(200);
    expect((await seatGet(SEAT_ROOT)).flow!.roster.some((r) => r.id === "planner-x")).toBe(false);
  });

  test("the CLI renames the label, edits the chain and puts a role on the path", async () => {
    const none = await cli(["flow", "role", "add", "nope", "--name", "Nope", "--does", "Nothing yet.",
      "--prompt", "Nothing yet.", "--root", SEAT_ROOT]);
    expect(none.code).toBe(1);
    expect(String(none.out.error)).toContain("--policy-role or --chain");
    const add = await cli(["flow", "role", "add", "qa-x", "--name", "QA X", "--does", "Runs the change; never fixes.",
      "--prompt", "Run the change and report it.", "--chain", "opencode:glm-4.6", "--team-only", "--root", SEAT_ROOT]);
    expect(add.code).toBe(0);
    let view = await seatGet(SEAT_ROOT);
    expect(view.flow!.path).not.toContain("qa-x");

    const renamed = await cli(["flow", "role", "rename", "qa-x", "QA X2", "--root", SEAT_ROOT]);
    expect(renamed.code).toBe(0);
    view = await seatGet(SEAT_ROOT);
    expect(view.flow!.roster.find((r) => r.id === "qa-x")!.name).toBe("QA X2");

    const edited = await cli(["flow", "role", "edit", "qa-x", "--chain", "opencode:deepseek-v4.1-flash", "--root", SEAT_ROOT]);
    expect(edited.code).toBe(0);
    view = await seatGet(SEAT_ROOT);
    const role = view.flow!.roster.find((r) => r.id === "qa-x")!;
    expect(role.policyRole).toBeUndefined();
    expect(role.chain).toEqual([{ engine: "opencode", model: "deepseek-v4.1-flash" }]);

    const placed = await cli(["flow", "path", "add", "qa-x", "--after", "builder", "--root", SEAT_ROOT]);
    expect(placed.code).toBe(0);
    view = await seatGet(SEAT_ROOT);
    expect(view.flow!.path.indexOf("qa-x")).toBe(view.flow!.path.indexOf("builder") + 1);

    // The validator's own icon normaliser: a legacy name is read as the glyph it became.
    const icon = await cli(["flow", "role", "edit", "qa-x", "--ico", "compass", "--root", SEAT_ROOT]);
    expect(icon.code).toBe(0);
    view = await seatGet(SEAT_ROOT);
    expect(view.flow!.roster.find((r) => r.id === "qa-x")!.ico).toBe("chart");

    const required = await cli(["flow", "role", "edit", "qa-x", "--required", "yes", "--root", SEAT_ROOT]);
    expect(required.code).toBe(0);
    // A path that drops the role drops its hard rule too, and says so.
    const set = await cli(["flow", "path", "set", "planner", "builder", "inspector", "verifier", "landing", "--root", SEAT_ROOT]);
    expect(set.code).toBe(0);
    expect((set.out.dropped as { required?: string[] }).required).toContain("qa-x");
    view = await seatGet(SEAT_ROOT);
    expect(view.flow!.path).not.toContain("qa-x");
    expect(view.flow!.roster.find((r) => r.id === "qa-x")!.required).toBe(false);
  });

  test("the CLI makes a reads-only step a person answers, and clears the chain a built-in does not keep", async () => {
    expect((await personSet("flow.agentEdit", true, SEAT_ROOT)).status).toBe(200);
    const you = await cli(["flow", "role", "add", "you", "--name", "You", "--does", "Reads the result and answers.",
      "--prompt", "Read what came back and say whether it is right.", "--actor", "person", "--reads-only", "yes",
      "--team-only", "--root", SEAT_ROOT]);
    expect(you.code).toBe(0);
    let view = await seatGet(SEAT_ROOT);
    const role = view.flow!.roster.find((r) => r.id === "you")!;
    expect([role.actor, role.readsOnly, role.chain]).toEqual(["person", true, []]);

    const mine = await cli(["flow", "role", "add", "mine-x", "--name", "Mine X", "--does", "Runs the change; never fixes.",
      "--prompt", "Run the change and report it.", "--chain", "opencode:glm-4.6", "--team-only", "--root", SEAT_ROOT]);
    expect(mine.code).toBe(0);

    // --policy-role clears the chain first, so the answer is the kind rule and not the chain's.
    const retyped = await cli(["flow", "role", "edit", "mine-x", "--policy-role", "reviewer", "--root", SEAT_ROOT]);
    expect(retyped.code).toBe(1);
    expect(String(retyped.out.error)).toContain("keeps its kind");
    expect(String(retyped.out.error)).not.toContain("chain");

    // --chain "" clears it, and the validator then asks for the chain a custom role needs.
    const cleared = await cli(["flow", "role", "edit", "mine-x", "--chain", "", "--root", SEAT_ROOT]);
    expect(cleared.code).toBe(1);
    expect(String(cleared.out.error)).toContain("needs at least one engine and model");

    const asked = await cli(["flow", "role", "edit", "mine-x", "--actor", "person", "--root", SEAT_ROOT]);
    expect(asked.code).toBe(0);
    view = await seatGet(SEAT_ROOT);
    const qa = view.flow!.roster.find((r) => r.id === "mine-x")!;
    expect([qa.actor, qa.chain, qa.policyRole]).toEqual(["person", [], undefined]);
  });

  test("with the setting off the same CLI call is refused with the sentence", async () => {
    const off = await personSet("flow.agentEdit", false, SEAT_ROOT);
    expect(off.status).toBe(200);
    const add = await cli(["flow", "role", "add", "planner-y",
      "--name", "Planner Y", "--does", "Cuts the ask into steps.", "--prompt", "Plan the work and hand it back.",
      "--policy-role", "builder", "--root", SEAT_ROOT]);
    expect(add.code).toBe(1);
    expect(add.out.error).toBe(FLOW_AGENT_EDIT_OFF);
  });
});

describe("a skipped or reordered step leaves a line with its reason", () => {
  test("the brief tells the orchestrator the path is a guide and how to leave the line", () => {
    const text = renderFlowForOrchestrator(withQa());
    expect(text).toContain("The path is a guide");
    expect(text).toContain("POST /flow/deviation");
  });

  test("a note needs a known step, a kind and a reason", () => {
    const flow = withQa();
    expect(checkDeviation(flow, { kind: "skipped", step: "qa-only", reason: "  docs only,\n no code  " }))
      .toEqual({ ok: true, kind: "skipped", step: "qa-only", reason: "docs only, no code" });
    expect(checkDeviation(flow, { kind: "skipped", step: "qa-only", reason: "" }).ok).toBe(false);
    expect(checkDeviation(flow, { kind: "moved", step: "qa-only", reason: "x" }).ok).toBe(false);
    expect(checkDeviation(flow, { kind: "reordered", step: "nope", reason: "x" }).ok).toBe(false);
  });

  test("the note lands in the Activity log with its reason and never blocks", async () => {
    const { actionLog } = await import("../src/db.ts");
    const d = checkDeviation(withQa(), { kind: "reordered", step: "builder", reason: "plan was one line" });
    if (!d.ok) throw new Error("expected ok");
    noteDeviation("127.0.0.1", "/home/x/orbit", d);
    const row = actionLog(5).find((r) => r.action === "/flow/deviation")!;
    expect([row.target, row.detail, row.ok]).toEqual(["orbit · reordered builder", "plan was one line", 1]);
  });
});
