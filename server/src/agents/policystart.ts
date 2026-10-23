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
 * exits. What a stop by hand kills is the window; a command the engine's tool
 * started in a session of its own can outlive it (measured: Claude's and
 * OpenCode's Bash tool). Only the turn limit walks the tree (ceilings.ts).
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { readStoredPolicy } from "../config.ts";
import { projectRootOf } from "../git.ts";
import { readPolicy } from "../orchestration.ts";
import { recordAction } from "../db.ts";
import { ruleStates } from "../orchpolicy.ts";
import { probeEngines } from "../agentprobe.ts";
import { addNeed } from "../seatneed.ts";
import { addReport } from "../seatreport.ts";
import { wakeForReport } from "../seatwake.ts";
import { hermesResumeRefusal } from "../hermes.ts";
import { agentProvider, workerModelFor } from "../../../shared/agentKinds.ts";
import { workerRole, type RoleId } from "../../../shared/workerRoles.ts";
import { chainFor, envelopeWithin, resolve, type RuleFacts } from "../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../shared/types.ts";
import * as AgentOps from "../agentops.ts";
import { headlessRefusal, headlessTurn, prepareRun, runFiles, turnResult, wrapped } from "./headless.ts";
import { firstTurnFailure, type FirstTurnFailure } from "./failures.ts";
import { arm } from "./ceilings.ts";
import { toldRoots, watchChair } from "./noplan.ts";
import { pushNoPlanCleared, pushNoPlanLeft } from "../alerts.ts";
import { nextEngine, planWorker, type StartedBy } from "./workerstart.ts";

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
    owner: { seatRoot: p.seatRoot, model: plan.choice.model, startedBy: { ...plan.startedBy, turnMinutes: view.policy.limits.turnMinutes }, resumeId: turn.sessionId ?? null },
  });
  if (!r.ok) {
    if (r.error === "exists") return { status: 409, body: { ok: false, error: "an agent by that name is still running", result: { agent: r.agent } } };
    if (r.error === "lock-loosened") return refuse(`this directory's OpenCode config loosens the worker's lock, so it was not started: ${r.detail}`);
    return refuse(`the worker could not start: ${r.error}`);
  }
  armWorker(r.agent, view.policy.limits.turnMinutes);
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
    owner: { seatRoot: a.seatRoot ?? null, model: by.model, startedBy: nextTurn(by, view.policy.limits.turnMinutes), resumeId: resume },
  });
  if (!r.ok) return refuse(`the next turn could not start: ${r.error}`);
  armWorker(AgentOps.agentNamed(a.name) ?? a, view.policy.limits.turnMinutes);
  return { status: 200, body: { ok: true, result: { name: a.name, outcome: "sent", resumed: resume, ...(turn.partly ? { partly: turn.partly } : {}) } } };
}

// ── the ceiling and the end of a turn ────────────────────────────────────

const LOST = "ceiling lost: restarted";

/** The stamp of a worker's next turn: one further on, under the limit in
 *  force now, and with a ceiling of its own again. A row from before turns
 *  were counted has been resumed at least once by the time it gets here. */
function nextTurn(by: StartedBy, turnMinutes: number): StartedBy {
  const { ceilingLost: _, ...rest } = by;
  return { ...rest, turn: (by.turn ?? 1) + 1, turnMinutes, because: by.because.filter((l) => !l.startsWith(LOST)) };
}

/** Arm the turn limit and the watch on the turn's end, for a turn just opened. */
function armWorker(a: AgentOps.NamedAgent, turnMinutes: number): void {
  arm(a, {
    deadline: a.startedAt + turnMinutes * 60_000, limitMinutes: turnMinutes, files: runFiles(a.name),
    ended: (name) => endedTurn(name),
  });
}

/**
 * Boot. The timers died with the old process and are NOT put back: the pane
 * and window ids on a row are only good for the tmux that handed them out, and
 * after a machine or tmux restart the same numbers belong to restored tabs. So
 * nothing here stops anything.
 *
 *   - A turn that ended while the server was away is settled, quietly. It is
 *     old news: moving it to another engine now would start a task that may be
 *     days old, and the seat reads the row when it next looks.
 *   - A turn still going is marked "ceiling lost: restarted" on its row. Its
 *     end is still watched (a file under its name, no id involved) so a failure
 *     reaches the seat; its minutes are not counted any more, and it does not
 *     move to another engine.
 */
export async function workersAfterRestart(): Promise<{ lost: string[]; settled: string[] }> {
  const lost: string[] = [], quiet: string[] = [];
  for (const a of AgentOps.everyAgent()) {
    const by = startedByOf(a);
    if (!by || a.exitCode !== undefined) continue;
    const files = runFiles(a.name);
    const r = turnResult(files, a.kind);
    if (r) { AgentOps.settleTurn(a, r); quiet.push(a.name); continue; }
    // A window that closed without ever writing its status was stopped by hand,
    // and one that is not there has no turn to watch. Asked, never written:
    // boot is no moment to close rows over a tmux that is still coming up.
    if (a.endedAt !== null || !(await AgentOps.paneAlive(a.paneId))) continue;
    if (!by.ceilingLost) {
      const limit = by.turnMinutes ? `${by.turnMinutes}-minute limit` : "turn limit";
      AgentOps.restamp(a.name, { ...by, ceilingLost: true, because: [...by.because, `${LOST}: the server restarted during this turn, so its ${limit} is no longer enforced`] });
    }
    arm(a, { deadline: null, limitMinutes: by.turnMinutes ?? 0, files, ended: (name) => endedTurn(name) });
    lost.push(a.name);
  }
  return { lost, settled: quiet };
}

/** A worker's turn settled by itself (the timeout is ceilings.ts's own). */
async function endedTurn(name: string): Promise<void> {
  const a = AgentOps.agentNamed(name);
  const by = a && startedByOf(a);
  if (!a || !by || !a.exitCode) return;
  /* Asked before the seat's turn is taken and told after it is given back:
     checking the engines can take seconds a command, and every other start and
     prompt of this seat would wait behind it. */
  const ready = (await probeEngines()).engines;
  const tell = await inTurn(a.seatRoot, name, () => failedTurn(a, by, ready));
  if (tell) await wakeForReport(tell, name);
}

/** A plan can only come back by the person's hand: the policy saved, or an
 *  engine signed in and checked. Asked again then, for the projects whose card
 *  is up, and for nobody when none is. */
export async function chairsAgain(): Promise<void> {
  const roots = toldRoots();
  if (!roots.length) return;
  const ready = (await probeEngines()).engines;
  for (const root of roots) await askChair(root, ready);
}

async function askChair(root: string, readiness: readonly EngineReadiness[]): Promise<void> {
  watchChair({
    root, policy: readPolicy(root).policy, facts: factsNow(), readiness, running: await AgentOps.liveOwnedBy(root),
    notify: {
      out: (project, running) => { recordAction({ actor: "policy", action: "chair/no-plan", target: project, ok: false, detail: `${running} workers still running` }); pushNoPlanLeft(project, running); },
      back: (project) => { recordAction({ actor: "policy", action: "chair/plan-back", target: project, ok: true }); pushNoPlanCleared(project); },
    },
  });
}

const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const engineTitle = (e: string): string => agentProvider(e)?.title ?? e;
const WHY: Record<FirstTurnFailure, string> = { "rate-limit": "hit its rate limit", "signed-out": "was signed out" };

/**
 * A turn ended with a non-zero status.
 *
 * Moved to the next engine in the chain ONLY when it is the worker's FIRST
 * turn, that turn never got past the handshake, and its words are a rate limit
 * or a sign-in problem (failures.ts). A turn after the first starts with empty
 * output files and can fail just as early, on top of everything the turns
 * before it wrote, so the turn is counted on the stamp and the files alone
 * never decide. A failure after work began is reported and left: a second
 * engine would edit on top of a half-done first, and what to do with that is
 * the seat's call.
 *
 * Once, by default: `maxRetries` is 1. A policy may raise it, and each move is
 * still a first turn that did nothing, on an engine not tried before, so the
 * chain's length bounds it. The move is logged and is not news; a second
 * failure, or a chain with nothing left, is a need for the person, and every
 * failure that is not a move is one report to the seat. The root to wake comes
 * back, so the wake happens outside the seat's turn.
 */
async function failedTurn(a: AgentOps.NamedAgent, by: StartedBy, ready: readonly EngineReadiness[]): Promise<string | null> {
  const files = runFiles(a.name);
  const why = firstTurnFailure(readText(files.out), readText(files.err));
  const view = readPolicy(a.seatRoot ?? undefined);
  const retries = by.retries ?? 0;
  // A row with no count is from before turns were counted: it may have been resumed, so it stays.
  const first = by.turn === 1 && !by.ceilingLost;
  let stopped = `${engineTitle(by.engine)} exited with ${a.exitCode}${a.exitLine ? `: ${a.exitLine}` : ""}`;

  if (why && first && retries < view.policy.limits.maxRetries) {
    const moved = await switchEngine(a, by, why, view, ready);
    if (moved === true) return null;
    stopped = moved;
  }
  const root = a.seatRoot;
  if (!root) return null;
  // An engine is out: is the chair's own plan still there?
  if (why) await askChair(root, ready);
  if ((why && first) || retries > 0) {
    addNeed({
      root, text: `${a.name} stopped: ${why ? `${engineTitle(by.engine)} ${WHY[why]}` : stopped}${retries > 0 ? `, after moving off ${engineTitle(by.from ?? "the first engine")}` : ""}. No engine is left to try for it.`,
      recommend: "Settings ▸ Orchestration: add an engine to the chain, or sign one in; then start the worker again.",
    });
  }
  const blocked = !why ? "the turn failed"
    : first ? `the engine ${WHY[why]} before it did anything`
    : `the engine ${WHY[why]} on a later turn, so it was not moved to another engine on top of what the turns before it did`;
  addReport({
    root, agent: a.name,
    text: [
      `STATE: stopped: ${stopped}`,
      `BLOCKED: ${blocked}${retries > 0 ? ", and the next engine failed as well" : ""}; its files are in ${a.cwd}`,
      "NEED: decide whether to start it again, hand it to another engine, or drop it",
      "COST: one decision",
    ].join("\n"),
  });
  return root;
}

/** Start the next ready entry of the role's chain with the same prompt, in the
 *  same directory and envelope. True when it started; otherwise why not. */
async function switchEngine(a: AgentOps.NamedAgent, by: StartedBy, why: FirstTurnFailure, view: ReturnType<typeof readPolicy>, ready: readonly EngineReadiness[]): Promise<true | string> {
  const prompt = readText(runFiles(a.name).prompt);
  const role = workerRole(by.role);
  const cwd = a.seatRoot ? seatMayUse(a.seatRoot, a.cwd) : a.cwd;
  if (!role || !prompt || !cwd) return `there was nothing to hand to another engine`;
  if (!envelopeWithin(by.envelope, view.policy.ceiling)) return "the envelope it started with is beyond this project's ceiling now";
  const facts = factsNow();
  const pathOf = (engine: string) => { const r = ready.find((e) => e.id === engine); return r?.path && r.roles.worker.ok ? r.path : null; };
  const resolved = resolve(view.policy, facts, ready).workers[role.id];
  const next = nextEngine({
    chain: chainFor(view.policy, facts, role.id), by, ask: resolved.ok && resolved.ask,
    usable: (c) => !!pathOf(c.engine) && !headlessRefusal(c.engine),
  });
  if (!next.ok) return next.why;
  const bin = pathOf(next.choice.engine)!;
  const model = workerModelFor(next.choice.engine, next.choice.model);
  const turn = headlessTurn({ engine: next.choice.engine, bin, model, role, envelope: by.envelope, limits: view.policy.limits, prompt });
  if (!turn.ok) return turn.error;
  // The failed turn's tab is still open under this name; it goes before the next opens.
  if (await AgentOps.keptTabOf(a)) await AgentOps.stopAgent(a, Date.now(), true);
  const stamp: StartedBy = {
    ...by, engine: next.choice.engine, model, position: next.position,
    retries: (by.retries ?? 0) + 1, from: by.engine, turnMinutes: view.policy.limits.turnMinutes,
    because: [...by.because, `${engineTitle(by.engine)} ${WHY[why]}, so the next engine in the chain took over`],
  };
  const files = prepareRun(a.name, prompt, turn.stdin);
  const r = await AgentOps.startAgent({
    root: a.seatRoot ?? cwd, name: a.name, cwd, kind: next.choice.engine, exactArgv: wrapped(files, turn.argv),
    env: turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: a.seatRoot ?? null, model, startedBy: stamp, resumeId: turn.sessionId ?? null },
  });
  /* An engine that fails at launch is `died` here: its row is written and
     ended all the same, and its wrapper has left the status, so it is armed
     like any other and its own failure is read by the same path (a second
     failure, which is a need). */
  const started = r.ok ? r.agent : r.error === "died" ? AgentOps.agentNamed(a.name) : null;
  if (!started) return `the next engine could not start: ${r.ok ? "no row" : r.error}`;
  recordAction({
    actor: "policy", action: "worker/switch", target: a.name, ok: true,
    detail: `${a.name}: ${by.engine} to ${next.choice.engine} (${next.choice.model || "default model"}): ${engineTitle(by.engine)} ${WHY[why]} on its first turn`.slice(0, 300),
  });
  armWorker(started, stamp.turnMinutes!);
  return true;
}
