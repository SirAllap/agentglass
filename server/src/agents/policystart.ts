/*
 * Starting a worker through the policy, and giving a finished one its next
 * instruction. The glue between the pure decision (workerstart.ts), the
 * engines' argv (headless.ts) and the window (agentops.ts).
 *
 * Engaged only when a policy is stored or a caller names `--engine`,
 * `--model` or `--allow`. With neither, `start --role` is exactly what it was
 * before this file existed: a worker in the role's TUI under the role's lock.
 *
 * A worker started here is stopped, not steered: its engine runs one turn and
 * exits. What a stop kills is the window; a command the engine's tool started
 * in a session of its own can outlive it (measured: Claude's and OpenCode's
 * Bash tool), and this does not walk the tree.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { readStoredPolicy } from "../config.ts";
import { projectRootOf } from "../git.ts";
import { readPolicy } from "../orchestration.ts";
import { ruleStates } from "../orchpolicy.ts";
import { probeEngines } from "../agentprobe.ts";
import { addNeed } from "../seatneed.ts";
import { hermesResumeRefusal } from "../hermes.ts";
import { workerRole } from "../../../shared/workerRoles.ts";
import { envelopeWithin, type RuleFacts } from "../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../shared/types.ts";
import * as AgentOps from "../agentops.ts";
import { headlessTurn, prepareRun, runFiles, turnResult, wrapped } from "./headless.ts";
import { planWorker, type StartedBy } from "./workerstart.ts";

export interface Answer { status: number; body: Record<string, unknown> }
const refuse = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** Whether this start goes through the policy: a policy is stored for the
 *  project (or globally), or the caller used one of the new flags. */
export function policyEngaged(root: string | null, b: Record<string, unknown>): boolean {
  if (b.engine !== undefined || b.model !== undefined || b.allow !== undefined) return true;
  if (b.role === undefined) return false;
  return !!((root && readStoredPolicy(root)) || readStoredPolicy());
}

const factsNow = (): RuleFacts => {
  const on = new Set(ruleStates().filter((s) => s.active).map((s) => s.ruleId));
  return { on: (id) => on.has(id) };
};

export const startedByOf = (a: AgentOps.NamedAgent): StartedBy | null => {
  const s = a.startedBy as Partial<StartedBy> | undefined;
  return s?.headless === true ? (s as StartedBy) : null;
};

/** The directory a seat's worker may run in, links followed: inside the
 *  project's own tree, or one of its worktrees. Null anywhere else. What comes
 *  back is what the window is opened in, so a link swapped after the check
 *  points at nothing the worker gets. */
export function seatMayUse(root: string, dir: string): string | null {
  try {
    const r = realpathSync(root), d = realpathSync(dir);
    return d === r || d.startsWith(r + "/") || projectRootOf(d) === r ? d : null;
  } catch { return null; }
}

/* One turn at a time per seat, start or resume, so two requests that arrive
   together cannot both pass the worker count and open one worker over the
   limit; and one at a time per name under that, so a start and a prompt on the
   same name (from a seat and from the person, whose keys differ) cannot both
   clear its run folder. In memory: a restart drops the queue, and the count is
   read off the engine anyway. */
const turns = new Map<string, Promise<unknown>>();
async function exclusive<T>(key: string, f: () => Promise<T>): Promise<T> {
  const mine = (turns.get(key) ?? Promise.resolve()).then(f);
  const tail = mine.then(() => {}, () => {});
  turns.set(key, tail);
  try { return await mine; } finally { if (turns.get(key) === tail) turns.delete(key); }
}
const inTurn = <T>(seatRoot: string | null | undefined, name: string, f: () => Promise<T>): Promise<T> =>
  exclusive(seatRoot ?? "", () => exclusive(`name:${name}`, f));

/** The policy's own start: decide, compile, open one headless turn. */
export function startThroughPolicy(p: Parameters<typeof startNow>[0]): Promise<Answer> {
  return inTurn(p.seatRoot, p.name, () => startNow(p));
}

async function startNow(p: {
  root: string; /** Whose policy: the seat's project, or the one the directory belongs to. */ policyRoot: string;
  name: string; cwd: string; prompt: string; body: Record<string, unknown>;
  /** From the credential, never from the body. */
  seatRoot: string | null; probe?: () => Promise<EngineReadiness[]>;
}): Promise<Answer> {
  const b = p.body;
  if (b.role === undefined) return refuse("engine, model and allow go with a role: add --role scout, builder or verifier");
  if (typeof b.kind === "string") return refuse("a start through the policy takes --engine from the role's chain, not a kind");
  if (typeof b.remoteControl === "string") return refuse("a headless worker has no remote-control session: it runs one turn and exits");
  if (b.yolo === true) return refuse("a worker runs under its envelope, and skipping permissions is never combined with one");
  if (Array.isArray(b.args) && b.args.length) return refuse("args cannot ride along with a start through the policy: what a worker may do is its envelope, decided by the policy");

  const view = readPolicy(p.policyRoot);
  const readiness = await (p.probe ?? (async () => (await probeEngines()).engines))();
  const plan = planWorker(
    { role: b.role, engine: b.engine, model: b.model, allow: b.allow },
    { policy: view.policy, scope: view.scope }, factsNow(), readiness,
    p.seatRoot ? await AgentOps.liveOwnedBy(p.seatRoot) : null,
  );
  if (!plan.ok) {
    // The chain ran out: the person has to hear it, and the seat is how.
    if (plan.need && p.seatRoot) addNeed({ root: p.seatRoot, text: plan.error, recommend: "Settings ▸ Orchestration: add an engine to the chain, or sign one in." });
    return refuse(plan.error);
  }
  const bin = readiness.find((e) => e.id === plan.choice.engine)?.path;
  if (!bin) return refuse(`${plan.choice.engine} is not installed here`);

  const turn = headlessTurn({
    engine: plan.choice.engine, bin, model: plan.choice.model, role: plan.role, envelope: plan.envelope,
    limits: view.policy.limits, prompt: p.prompt,
  });
  if (!turn.ok) return refuse(turn.error);
  /* Before the run folder is cleared: a name that is still running keeps its
     result files, and the refusal is the same sentence `startAgent` would give. */
  const had = AgentOps.agentNamed(p.name);
  if (had && had.endedAt === null && await AgentOps.paneAlive(had.paneId)) {
    return { status: 409, body: { ok: false, error: "an agent by that name is still running", result: { agent: had } } };
  }
  // Asked again here, in the name's turn: another seat may have taken the name
  // since the route looked.
  if (had?.seatRoot && p.seatRoot && had.seatRoot !== p.seatRoot) {
    return refuse(`${p.name} belongs to the seat of ${basename(had.seatRoot)}, not to yours (${basename(p.seatRoot)}). Ask that seat, or the person.`, 403);
  }
  const files = prepareRun(p.name, p.prompt, turn.stdin);
  const r = await AgentOps.startAgent({
    root: p.root, name: p.name, cwd: p.cwd, kind: plan.choice.engine, exactArgv: wrapped(files, turn.argv),
    env: turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: p.seatRoot, model: plan.choice.model, startedBy: plan.startedBy, resumeId: turn.sessionId ?? null },
  });
  if (!r.ok) {
    if (r.error === "exists") return { status: 409, body: { ok: false, error: "an agent by that name is still running", result: { agent: r.agent } } };
    if (r.error === "lock-loosened") return refuse(`this directory's OpenCode config loosens the worker's lock, so it was not started: ${r.detail}`);
    return refuse(`the worker could not start: ${r.error}`);
  }
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        agent: r.agent, state: "starting", ready: false,
        engine: plan.choice.engine, model: plan.choice.model, because: plan.startedBy.because, envelope: plan.envelope,
        ...(turn.partly ? { partly: turn.partly } : {}),
      },
    },
  };
}

/** Collect a finished turn's outcome into the row. Lazy: asked when somebody
 *  looks, never on a timer. */
export function settled<T extends AgentOps.NamedAgent>(a: T): T {
  if (!startedByOf(a) || a.exitCode !== undefined) return a;
  const s = AgentOps.settleTurn(a, turnResult(runFiles(a.name), a.kind));
  return s.exitCode === undefined ? a : { ...a, exitCode: s.exitCode, exitLine: s.exitLine };
}

/** `prompt` on a headless worker: its next turn, resumed, on the engine and
 *  envelope it was stamped with, whatever the rules say now. */
export function promptHeadless(a: AgentOps.NamedAgent, text: string): Promise<Answer> {
  return inTurn(a.seatRoot, a.name, () => resumeTurn(a, text));
}

async function resumeTurn(asked: AgentOps.NamedAgent, text: string): Promise<Answer> {
  // Read again once it is this prompt's turn: the one ahead of it may have
  // started the next turn, and the row the route saw is then out of date.
  const a = AgentOps.agentNamed(asked.name) ?? asked;
  const by = startedByOf(a);
  if (!by) return refuse(`${a.name} is no longer a worker this app started, so there is no turn to continue.`, 409);
  /* The stamp says what the worker may do, not where: the directory is asked
     again on every turn, because a row's directory can change after its start
     and the next turn would then run outside the project under its envelope. */
  const cwd = a.seatRoot ? seatMayUse(a.seatRoot, a.cwd) : a.cwd;
  if (!cwd) return refuse(`${a.name}'s directory is not inside ${basename(a.seatRoot!)}'s own tree or worktrees any more, so it was not resumed. Start a new worker there.`);
  const now = settled(a);
  if (now.exitCode === undefined && !(await AgentOps.paneAlive(a.paneId))) {
    return refuse(`${a.name} was stopped before its turn ended, so there is no finished turn to continue: start a new worker.`, 409);
  }
  if (now.exitCode === undefined) {
    return refuse(`${a.name} is still on its turn. A headless worker takes a new instruction between turns, not during one: wait for it (agentglass-agent wait ${a.name} --until gone) or stop it.`, 409);
  }
  const resume = AgentOps.resumeIdOf(a.name);
  if (!resume) return refuse(`${a.name}'s engine did not say which session to continue, so there is nothing to resume: start a new worker.`);
  if (a.kind === "hermes") {
    const why = hermesResumeRefusal(resume, cwd, "default");
    if (why) return refuse(`${a.name} cannot be resumed: ${why}`);
  }
  const role = workerRole(by.role);
  const bin = (await probeEngines()).engines.find((e) => e.id === by.engine)?.path;
  if (!role || !bin) return refuse(`${by.engine} is not installed here any more, so ${a.name} cannot be resumed`);
  const view = readPolicy(a.seatRoot ?? undefined);
  // The engine stays the one it was stamped with; what it may do does not
  // outlive the person narrowing the ceiling since.
  if (!envelopeWithin(by.envelope, view.policy.ceiling)) {
    return refuse(`${a.name} was started with an envelope this project's ceiling no longer allows (Settings ▸ Orchestration), so it was not resumed. Start a new worker inside the ceiling.`);
  }
  // A resumed turn is a running worker like a started one, and counts the same.
  // Its own finished tab is not one: the row can still read as live for the
  // moment between the engine's exit and the tab settling.
  const mine = a.seatRoot ? await AgentOps.liveOwnedBy(a.seatRoot) : 0;
  const live = mine - (mine && AgentOps.agentNamed(a.name)?.endedAt === null ? 1 : 0);
  if (live >= view.policy.limits.maxWorkers) {
    return refuse(`${live} workers are already running for this seat and the limit is ${view.policy.limits.maxWorkers}. Stop one or wait for one to finish.`);
  }
  const turn = headlessTurn({ engine: by.engine, bin, model: by.model, role, envelope: by.envelope, limits: view.policy.limits, prompt: text, resume });
  if (!turn.ok) return refuse(turn.error);
  // The finished turn's tab is still open under this name; it goes before the next opens.
  if (await AgentOps.keptTabOf(a)) await AgentOps.stopAgent(a, Date.now(), true);
  const files = prepareRun(a.name, text, turn.stdin);
  const r = await AgentOps.startAgent({
    root: a.seatRoot ?? cwd, name: a.name, cwd, kind: by.engine, exactArgv: wrapped(files, turn.argv),
    env: turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: a.seatRoot ?? null, model: by.model, startedBy: by, resumeId: resume },
  });
  if (!r.ok) return refuse(`the next turn could not start: ${r.error}`);
  return { status: 200, body: { ok: true, result: { name: a.name, outcome: "sent", resumed: resume, ...(turn.partly ? { partly: turn.partly } : {}) } } };
}
