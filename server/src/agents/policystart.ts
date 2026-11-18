/*
 * Starting a worker through the policy, and giving a finished one its next
 * instruction. The glue between the pure decision (workerstart.ts), the
 * engines' argv (headless.ts) and the window (agentops.ts).
 *
 * Engaged when a policy is stored, a caller names `--engine`, `--model` or
 * `--allow`, or it names a role of the flow with `--flow-role` (that role's
 * chain IS the decision). Otherwise `start --role` is exactly what it was
 * before this file existed: a worker in the role's TUI under the role's lock.
 *
 * A worker started here is stopped, not steered: its engine runs one turn and
 * exits. What a stop by hand kills is the window; a command the engine's tool
 * started in a session of its own can outlive it (measured: Claude's and
 * OpenCode's Bash tool). Only the turn limit walks the tree (ceilings.ts).
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { recordWorkerBranch } from "../ownBranchCommit.ts";
import { ensureCheckoutDeps, nodeModulesGap, withDepsLine } from "../checkoutDeps.ts";
import { readStoredPolicy } from "../config.ts";
import { workerMcpModes, workerPermissionMode, workerGitInternals, workerUnwalledEngines, workerClosedCommands, workerLegacyOpened, workerOpenDoors, workerProjectSkills, workerUnixSockets, plannerMayWrite, workerNoClaude } from "../preflightStore.ts";
import { chosenMcpServers } from "../workerMcp.ts";
import { git, projectRootOf } from "../git.ts";
import { readPolicy } from "../orchestration.ts";
import { autoContinueOn, nextPathRole, readFlow, unknownFlowRoleError } from "../flow.ts";
import { chainOf, roleById } from "../../../shared/flow.ts";
import { recordAction } from "../db.ts";
import { ruleStates } from "../orchpolicy.ts";
import { probeEngines } from "../agentprobe.ts";
import { primeOpencodeModels, qualifyOpencode } from "../enginemodels.ts";
import { browserAskContextFor, flowRoleFor, flowRoleInForce, lockForFlowRole, noBaseNoteFor, roleIsPersonStep, roleLockFor, rolePromptFor, savedStepOwningBuiltIn, unknownRoleError, withFirstCommand, withNoBaseNote, withPlanNote, withResultContract, withRolePrompt, withSubagentsNote } from "../rolePrompt.ts";
import { DEFAULTS_CHANGED, narrowEnvelope, withBrowserCliNote } from "./envelope.ts";
import { addNeed, openNeeds } from "../seatneed.ts";
import { addReport } from "../seatreport.ts";
import { wakeForReport } from "../seatwake.ts";
import { hermesResumeRefusal } from "../hermes.ts";
import { agentProvider, workerModelFor } from "../../../shared/agentKinds.ts";
import { workerRole, type RoleId, type WorkerRole } from "../../../shared/workerRoles.ts";
import { chainFor, clampEnvelope, clampedFields, envelopeWithin, resolve, type Envelope, type Policy, type RuleFacts } from "../../../shared/orchestration.ts";
import type { EngineReadiness } from "../../../shared/types.ts";
import * as AgentOps from "../agentops.ts";
import { mintBrowserCredential, withBrowserLine } from "../browseraccess.ts";
import { revokeWorkerToken, revokeWorkerTokens, revokeWorkerTokensExcept } from "../auth.ts";
import { forgetWorkerPages } from "../browserdrive.ts";
import { GH_LIMIT, dropGh, grantGh } from "./ghcred.ts";
import { answerOf, headlessRefusal, headlessTurn, prepareRun, reportOf, runFiles, turnResult, wrapped, wrappedTui } from "./headless.ts";
import { guardTurn, stopServe, type Serve } from "./opencodeserve.ts";
import { endWindowScopes, noteRunScope, runOutOfMemory } from "../scopes.ts";
import { firstTurnFailure, type FirstTurnFailure } from "./failures.ts";
import { arm } from "./ceilings.ts";
import { keepTuiFrom, transcriptSize, tuiFromOf } from "./tuiturn.ts";
import { toldRoots, watchChair } from "./noplan.ts";
import { pushNoPlanCleared, pushNoPlanLeft } from "../alerts.ts";
import { oldFloorNote } from "./hooks.ts";
import { neverBash } from "../agentRulesStore.ts";
import { nextEngine, planWorker, startedByOf, type StartedBy } from "./workerstart.ts";
import { moveCardOnSessionStart } from "./sessionStartMove.ts";
import type { CardRef } from "../cardbrief.ts";
import { announceWorkerEnd, awaitingAnswer, endedWithoutResult, type EndDeps } from "./workerend.ts";
import { saveScoutPlan } from "./planout.ts";
import { transcriptFor } from "../chatpane.ts";
import { getPlan, recordStep } from "../flightPlanStore.ts";
import { roundsSpentFor, STOP_SENTENCE } from "../flightPlan.ts";

export { reportOf, startedByOf };

/* A run's whole scope goes when the window it belonged to does — a tab stopped,
 * the row reconciled away — and not when a new turn starts under the same name:
 * the next turn re-arms the name, and a dev server the last turn left for the
 * person to look at still belongs to the window. A turn ENDING is not this
 * moment either: the wrapper stops the turn's private server (headless.ts). */
AgentOps.onWindowEnd((name) => endWindowScopes(name));

export interface Answer { status: number; body: Record<string, unknown> }
const refuse = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** The worker-wide extras every headless turn is started with, read per
 *  project (`root`, the seat's `policyRoot`): `workers.projectSkills` and the
 *  servers `workers.mcpServers` has switched on, resolved against what is
 *  really configured, plus `root` itself as `skillsRoot` — where
 *  `projectSkills` is staged from, never the turn's own `cwd` (its worktree,
 *  untrusted for a reviewed checkout). */
const workerExtras = (root?: string | null) => ({
  projectSkills: workerProjectSkills(root), mcpServers: chosenMcpServers(workerMcpModes(root)), skillsRoot: root ?? undefined,
  unixSockets: workerUnixSockets(root), openDoors: workerOpenDoors(root), closedCommands: workerClosedCommands(root), neverCommands: neverBash(root ?? ""), legacyOpenCommands: workerLegacyOpened(root), gitInternals: workerGitInternals(root), unwalledEngines: workerUnwalledEngines(root),
});

/** Whether this start goes through the policy: a policy is stored for the
 *  project (or globally), or the caller used one of the new flags. */
export function policyEngaged(root: string | null, b: Record<string, unknown>): boolean {
  if (b.engine !== undefined || b.model !== undefined || b.allow !== undefined) return true;
  /* A flow role's chain IS the decision, so a start that names one always goes
     through the policy: that is what makes a custom role startable without a
     stored policy. */
  if (b.flowRole !== undefined) return true;
  if (b.role === undefined) return false;
  return !!((root && readStoredPolicy(root)) || readStoredPolicy());
}

/**
 * The role a worker runs as: the built-in one, or for an id of the flow in
 * force that is not built-in, a synthetic one. Null when neither.
 *
 * A flow role never runs wider than the built-in role its `policyRole` names
 * (builder when it names none), so a role mapped to a read-only one is
 * read-only whatever its own flag says; its `allow` is only what the project's
 * ceiling lifts, and rides on the role because it is the shell the engine is
 * given, not a narrowing of the envelope. Its `id` is the flow's id as a plain
 * string; the type says RoleId because the built-ins are what most code here
 * handles.
 */
export function roleFor(root: string, id: unknown): WorkerRole | null {
  const built = workerRole(id);
  if (built) {
    // Settings ▸ Orchestration ▸ `workers.plannerWrite`: a project may let the
    // built-in scout write its own worktree and `.agx-tmp`, the one loosening
    // of its floor this role ever gets. Off (the default) is scout's own
    // `readOnly: true`, as it always ran.
    const base = built.id === "scout" && plannerMayWrite(root) ? { ...built, readOnly: false } : built;
    const lock = roleLockFor(root, id);
    if (!lock) return base;
    // A saved step that took this id keeps its own walls: a `readsOnly` floor
    // on the built-in's id is the role's, not only the envelope's, so the
    // sandbox and the allow list see it too.
    return {
      ...base,
      readOnly: base.readOnly || lock.readsOnly,
      ...(lock.allow.length ? { allow: lock.allow } : {}),
      ...(lock.mayStartSubagents ? { mayStartSubagents: true } : {}),
    };
  }
  const f = flowRoleInForce(root, id);
  if (!f) return null;
  const lock = lockForFlowRole(root, f);
  return {
    id: f.id as RoleId, title: f.name, what: f.does, readOnly: lock.readsOnly, allow: lock.allow,
    ...(lock.mayStartSubagents ? { mayStartSubagents: true } : {}),
    ...(f.policyRole ? { base: f.policyRole } : {}),
    default: { provider: "", model: "" },
  };
}

/** A saved step that took a built-in role's id as its own: it keeps its own
 *  chain (and the rest of its walls), whatever flag named it. Shared by
 *  `startNow` and `planRoleSwitch` so a live `prompt --flow-role` switch into
 *  a built-in id picks the same chain a fresh `start --flow-role` would. */
function builtInOverride(root: string, id: unknown) {
  const ownStep = savedStepOwningBuiltIn(root, id);
  return ownStep ? { ...ownStep, chain: chainOf(ownStep) } : undefined;
}

const factsNow = (): RuleFacts => {
  const on = new Set(ruleStates().filter((s) => s.active).map((s) => s.ruleId));
  return { on: (id) => on.has(id) };
};

/** The engine a project's builder starts on right now (the first step of its chain), or null for an empty
 *  chain. Flight plan's Launch asks before it cuts a tree: a Claude chain opens a tab, another one starts a worker.
 *  With "No Claude in workers" on it is never Claude (and never null, which Launch reads as Claude): the chain's
 *  first other engine, else OpenCode, so the launch goes through the policy path that swaps or refuses. */
export function builderEngineFor(root: string): string | null {
  const chain = chainFor(readPolicy(root).policy, factsNow(), "builder");
  if (workerNoClaude(root)) return chain.find((c) => c.engine !== "claude")?.engine ?? "opencode";
  return chain[0]?.engine ?? null;
}

/** Who a start with no named worker stands for: the builder, on the first engine of its chain, under the project's default envelope narrowed by the builder's lock. "Check a command" asks canRun as this. */
export function defaultWorkerWho(root: string, engine: string | null = builderEngineFor(root)): { envelope: Envelope; role: string; engine: string | undefined } {
  return { envelope: narrowEnvelope(readPolicy(root).policy.workerDefault, roleLockFor(root, "builder")), role: "builder", engine: engine ?? undefined };
}

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

/** `startAgent` for a turn that may carry a private OpenCode server: the lock was checked there, and
 *  the server goes with the start if the start does not happen. */
async function startGuarded(a: Parameters<typeof AgentOps.startAgent>[0], serve: Serve | null): ReturnType<typeof AgentOps.startAgent> {
  let started = false;
  try {
    const r = await AgentOps.startAgent(serve ? { ...a, lockVerified: true } : a);
    started = r.ok || r.error === "died"; // a worker that died at launch ran its wrapper, which stops the server too
    return r;
  } finally {
    if (!started) stopServe(serve);
  }
}

async function startNow(p: {
  root: string; /** Whose policy: the seat's project, or the one the directory belongs to. */ policyRoot: string;
  name: string; cwd: string;
  /** The person's words, or a thunk for a brief that costs something to build (a card read): asked only after the refusals this turn makes first. */
  prompt: string | (() => Promise<string>); body: Record<string, unknown>;
  /** From the credential, never from the body. */
  seatRoot: string | null; probe?: () => Promise<EngineReadiness[]>;
  /** `{card}` in a role's `firstCommand`: the card key this start resolved, or
   *  the plain `--prompt` text when it named none. */
  cardOrPrompt?: string;
  /** The card this start resolved, by tracker: the Session start move step
   *  reads it to know whether there is a Jira card to move. Null for a plain
   *  `--prompt` start, or one whose card did not resolve. */
  cardRef?: CardRef | null;
  /** Filled by the `prompt` thunk when the card could not be read: the start answer repeats it, so the caller is told as well as the worker. */
  cardOutcome?: { unread?: string };
}): Promise<Answer> {
  const b = p.body;
  const flowAsked = b.flowRole;
  if (flowAsked !== undefined && typeof flowAsked !== "string") return refuse("flowRole: a role id from the flow");
  if (flowAsked !== undefined && b.role !== undefined) return refuse("a start names one role: --role, or --flow-role <id from the flow>, not both");
  if (b.role === undefined && flowAsked === undefined) return refuse("engine, model and allow go with a role: add --role scout, builder, reviewer, verifier or --flow-role <id from the flow>");
  if (typeof b.kind === "string") return refuse("a start through the policy takes --engine from the role's chain, not a kind");
  if (typeof b.remoteControl === "string") return refuse("a worker runs one turn and is read afterwards, so it has no remote-control session");
  if (b.yolo === true) return refuse("a worker runs under its envelope, and skipping permissions is never combined with one");
  if (Array.isArray(b.args) && b.args.length) return refuse("args cannot ride along with a start through the policy: what a worker may do is its envelope, decided by the policy");

  /* The flow in force is where a `--flow-role` id is resolved: the project's
     saved flow, else the template. */
  const fromFlow = typeof flowAsked === "string" ? roleById(readFlow(p.policyRoot).flow, flowAsked) : undefined;
  if (typeof flowAsked === "string" && !fromFlow) return refuse(unknownFlowRoleError(p.policyRoot, flowAsked));
  const roleId: unknown = fromFlow?.id ?? b.role;

  /* A custom role is a flow role that is not one of the four built-in ids.
     `--role` still names only a role the SAVED flow made, as it always did;
     `--flow-role` names one of the flow in force, template included. */
  const custom = workerRole(roleId) ? null
    : typeof flowAsked === "string" ? flowRoleInForce(p.policyRoot, roleId)
    : flowRoleFor(p.policyRoot, roleId);
  /* A saved step that took a built-in id as its own keeps its own walls and
     chain, whatever flag named it (`builtInOverride`, shared with a role
     switch so `prompt --flow-role` picks the same chain this start would). */
  const flowRole = builtInOverride(p.policyRoot, roleId) ?? custom;
  if (!workerRole(roleId) && !flowRole) return refuse(unknownRoleError(p.policyRoot));
  /* A step a person answers runs nothing, whichever flag named it and whatever
     its id, before an engine is probed. */
  if (roleIsPersonStep(p.policyRoot, roleId)) return refuse(`"${roleId}" is a person's step in the flow: nothing runs there, so no worker starts in it`);

  const view = readPolicy(p.policyRoot);
  const readiness = await (p.probe ?? (async () => (await probeEngines()).engines))();
  /* OpenCode's canonical model is `provider/model`; a stored chain may hold the
     bare name. `planWorker` qualifies from the installed engine's own list,
     which is read here once because the planner is sync. */
  await primeOpencodeModels();
  const planned = planWorker(
    { role: roleId, engine: b.engine, model: b.model, allow: b.allow },
    { policy: view.policy, scope: view.scope, noClaude: workerNoClaude(p.policyRoot) }, factsNow(), readiness,
    p.seatRoot ? await AgentOps.liveOwnedBy(p.seatRoot) : null,
    flowRole ? { role: roleFor(p.policyRoot, roleId)!, chain: flowRole.chain, policyRole: flowRole.policyRole } : undefined,
  );
  if (!planned.ok) {
    const plan = planned;
    // The chain ran out: the person has to hear it, and the seat is how.
    if (plan.need && p.seatRoot) addNeed({ root: p.seatRoot, text: plan.error, recommend: "Settings ▸ Orchestration: add an engine to the chain, or sign one in." });
    return refuse(plan.error);
  }
  /* The flow's lock narrows the envelope ONCE, here: the stamp (so resume and
     engine switch keep it even if the flow is edited later) and the response
     both carry the narrowed one. */
  const envelope = narrowEnvelope(planned.envelope, roleLockFor(p.policyRoot, planned.role.id));
  /* Only a plan of this project counts: an id that is not one is dropped, not an error. */
  const forPlan = typeof b.plan === "string" && getPlan(b.plan)?.root === p.policyRoot ? b.plan : undefined;
  /* The loop is the plan's: once a step has failed the most times its fail edge
     allows, another round of it is the person's call. The person's own start is not held. */
  if (forPlan && p.seatRoot && roundsSpentFor(getPlan(forPlan)!, planned.role.id)) {
    const name = planned.role.title;
    const text = `Flight plan ${forPlan}: ${name} failed the most times the flow allows, so another round is a person's call. Raise the rounds in Flow, or land the work by hand.`;
    if (!openNeeds(p.seatRoot).some((n) => n.text === text)) addNeed({ root: p.seatRoot, text, recommend: "Raise the rounds in Flow, or land the work by hand." });
    return refuse(`Rounds used: ${STOP_SENTENCE["rounds-used"]} Another round of ${name} is the person's.`, 409);
  }
  /* The tip is read now, at the start, never at the end. A failed read leaves it out and never stops the start. */
  let branchTip: string | undefined;
  if (forPlan) {
    try {
      const fp = getPlan(forPlan);
      const br = fp?.launched?.branch;
      const t = br ? git(p.policyRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${br}`]) : null;
      if (t && t.code === 0 && t.stdout.trim()) branchTip = t.stdout.trim();
    } catch { /* left out */ }
  }
  const stamp0 = { ...planned.startedBy, envelope, ...(forPlan ? { planId: forPlan } : {}), ...(branchTip ? { branchTip } : {}) };
  const plan = { ...planned, envelope, startedBy: stamp0 };
  const bin = readiness.find((e) => e.id === plan.choice.engine)?.path;
  if (!bin) return refuse(`${plan.choice.engine} is not installed here`);

  /* The name is asked before the brief: a start turned away because a worker of
     that name is still running, or because the name is another seat's, does not
     pay for a tracker read. */
  const had = AgentOps.agentNamed(p.name);
  if (had && had.endedAt === null && await AgentOps.paneAlive(had.paneId)) {
    return { status: 409, body: { ok: false, error: "an agent by that name is still running", result: { agent: had } } };
  }
  // Asked again here, in the name's turn: another seat may have taken the name
  // since the route looked.
  if (had?.seatRoot && p.seatRoot && had.seatRoot !== p.seatRoot) {
    return refuse(`${p.name} belongs to the seat of ${basename(had.seatRoot)}, not to yours (${basename(p.seatRoot)}). Ask that seat, or the person.`, 403);
  }

  /* Asked here, after the refusals this turn makes first (a yolo start, args,
     a kind, a flow role, a person's step, rounds used, a name it cannot take):
     a brief that costs a tracker read (a card) is not paid for by a start that
     is turned away. The turn's own refusals come after it, because the turn is
     built from the brief. */
  const asked = typeof p.prompt === "function" ? await p.prompt() : p.prompt;

  /* A worktree cut minutes ago has no node_modules, and its tsc failure is the
     environment. Said in the answer and as the first line the worker reads. */
  await ensureCheckoutDeps(p.cwd);
  await recordWorkerBranch(p.name, p.cwd);
  const deps = nodeModulesGap(p.cwd);
  const prompt = withNoBaseNote(withBrowserCliNote(withFirstCommand(withDepsLine(withSubagentsNote(withPlanNote(withResultContract(withBrowserLine(withRolePrompt(asked, rolePromptFor(p.policyRoot, plan.role.id)), plan.choice.engine, plan.role.id, browserAskContextFor(p.policyRoot, plan.role.id)), p.policyRoot, plan.role.id), p.policyRoot, plan.role.id, plan.envelope), p.policyRoot, plan.role.id), deps), p.policyRoot, plan.role.id, plan.choice.engine, p.cardOrPrompt ?? asked), plan.choice.engine, plan.role, plan.envelope), p.policyRoot, plan.role.id);
  const turn = headlessTurn({
    engine: plan.choice.engine, bin, model: plan.choice.model, role: plan.role, envelope: plan.envelope,
    limits: view.policy.limits, prompt, cwd: p.cwd, runDir: runFiles(p.name).dir, permissionMode: workerPermissionMode(p.policyRoot), ...workerExtras(p.policyRoot),
  });
  if (!turn.ok) return refuse(turn.error);
  const ghGiven = await grantGh(turn.env, plan.envelope);
  const stamped = withSandboxNote(stamp0, turn);
  /* Minted BEFORE the private serve starts, because on OpenCode 2.x the shell
     tool runs in that serve's process tree and its environment is frozen when
     it starts (`opencodeserve.ts`). Minting into the client's copy afterwards
     left the process that runs the worker's shell without a token, so every
     browser call was a 401. Every refusal below revokes it. */
  /* `replace: false`, and a refusal takes back only THIS token: a start that
     loses its name (`exists`, a retry of a name that is running) must not cut
     the credential the running worker holds. */
  const minted = mintBrowserCredential(turn.env, p.name, plan.choice.engine, plan.role.id, { ttlMs: turn.tui ? undefined : view.policy.limits.turnMinutes * 60_000, ctx: browserAskContextFor(p.policyRoot, plan.role.id), root: p.policyRoot, replace: false });
  const takeBack = () => { dropGh(turn.env); if (minted) revokeWorkerToken(minted); };
  const g = await guardTurn(plan.choice.engine, bin, p.cwd, turn, p.name);
  if (!g.ok) { takeBack(); return refuse(g.error); }
  const files = prepareRun(p.name, prompt, turn.stdin);
  const tuiFrom = tuiStartOf(p.cwd, turn.tui ? turn.sessionId : undefined);
  const r = await startGuarded({
    root: p.root, name: p.name, cwd: p.cwd, kind: plan.choice.engine,
    exactArgv: turn.tui ? wrappedTui(files, g.turn.argv) : wrapped(files, g.turn.argv, plan.choice.engine),
    env: g.turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: p.seatRoot, model: plan.choice.model, startedBy: asTui({ ...stamped, turnMinutes: view.policy.limits.turnMinutes }, turn), resumeId: turn.sessionId ?? null, role: plan.role.id },
    card: p.cardRef?.id,
  }, g.serve);
  if (!r.ok) {
    takeBack();
    if (r.error === "exists") return { status: 409, body: { ok: false, error: "an agent by that name is still running", result: { agent: r.agent } } };
    if (r.error === "lock-loosened") return refuse(`this directory's OpenCode config loosens the worker's lock, so it was not started: ${r.detail}`);
    if (r.error === "prompt-too-long") return refuse("the brief was too long for tmux to carry, even after the big part of it was moved to a file");
    return refuse(`the worker could not start: ${r.error}`);
  }
  /* The start won its name: whatever else was under it is stale. */
  if (minted) revokeWorkerTokensExcept(p.name, minted);
  noteRunScope(p.name, g.serve?.unit ?? null);
  armWorker(r.agent, view.policy.limits.turnMinutes, turn, tuiFrom);
  // The flow's Session start step: fire-and-forget, so a Jira problem never
  // holds up or fails a start that has already been answered.
  void moveCardOnSessionStart(p.policyRoot, p.name, p.cardRef).catch(() => {});
  return {
    status: 200,
    body: {
      ok: true,
      result: {
        agent: r.agent, state: "starting", ready: false,
        engine: plan.choice.engine, model: plan.choice.model, because: plan.startedBy.because, envelope: plan.envelope,
        ...(deps ? { environment: deps.line } : {}),
        ...(p.cardOutcome?.unread ? { cardUnread: p.cardOutcome.unread } : {}),
        ...(turn.partly ? { partly: turn.partly } : {}),
        ...(ghGiven ? { github: GH_LIMIT } : {}),
        defaults: DEFAULTS_CHANGED,
        ...(oldFloorNote(plan.choice.engine) ? { oldFloor: oldFloorNote(plan.choice.engine) } : {}),
        ...(plan.choice.engine !== "claude" ? { askNote: "`ask` rules cannot be enforced on this engine; only `never` rules are in its lock." } : {}),
        ...(noBaseNoteFor(p.policyRoot, plan.role.id) ? { noBase: noBaseNoteFor(p.policyRoot, plan.role.id) } : {}),
      },
    },
  };
}

/** A row as a card reads it: the turn's outcome, whether this worker owes a
 *  result it did not leave, and whether its result asks the orchestrator a
 *  question (which is a turn that can be answered, not a dead one). */
export type Settled = AgentOps.NamedAgent & { resultMissing?: boolean; awaitingAnswer?: boolean };

/** Collect a finished turn's outcome into the row. Lazy: asked when somebody
 *  looks, never on a timer. */
export function settled<T extends AgentOps.NamedAgent>(a: T): Settled {
  let row: AgentOps.NamedAgent = a;
  if (startedByOf(a) && a.exitCode === undefined) {
    const s = AgentOps.settleTurn(a, turnResult(runFiles(a.name), a.kind));
    if (s.exitCode !== undefined) row = { ...a, exitCode: s.exitCode, exitLine: s.exitLine };
  }
  const done = endedWithoutResult(row) ? { ...row, resultMissing: true } : row;
  return awaitingAnswer(row) ? { ...done, awaitingAnswer: true } : done;
}

/** What a role switch stamps: the new role's own engine, model and envelope,
 *  narrowed by ITS lock — never the role being left. Pulled out of
 *  `resumeTurn` so that turn stays what `flow-role-lock.test.ts` pins it as:
 *  no envelope narrowed twice over, resuming never re-locks. */
export function planRoleSwitch(
  root: string, id: string, view: { policy: Policy; scope: "project" | "global" }, engines: readonly EngineReadiness[],
): { ok: true; role: WorkerRole; engine: string; model: string; envelope: Envelope; startedByPatch: Partial<StartedBy> } | { ok: false; error: string } {
  const role = roleFor(root, id);
  if (!role) return { ok: false, error: unknownRoleError(root) };
  const fromFlow = builtInOverride(root, id) ?? (!workerRole(id) ? flowRoleInForce(root, id) : undefined);
  const planned = planWorker(
    { role: id },
    { ...view, noClaude: workerNoClaude(root) }, factsNow(), engines, null,
    fromFlow ? { role, chain: fromFlow.chain, policyRole: fromFlow.policyRole } : undefined,
  );
  if (!planned.ok) return { ok: false, error: planned.error };
  const envelope = narrowEnvelope(planned.envelope, roleLockFor(root, role.id));
  return {
    ok: true, role, engine: planned.choice.engine, model: planned.choice.model, envelope,
    startedByPatch: {
      role: role.id, engine: planned.choice.engine, model: planned.choice.model, envelope,
      rule: planned.startedBy.rule, ruleId: planned.startedBy.ruleId, because: planned.startedBy.because, position: planned.startedBy.position,
    },
  };
}

/** `prompt` on a headless worker: its next turn, resumed, on the engine and
 *  envelope it was stamped with, whatever the rules say now. With `flowRole`,
 *  the next turn switches into that role of the flow instead: its own prompt,
 *  chain and envelope, never a union with the role it is leaving. */
export function promptHeadless(a: AgentOps.NamedAgent, text: string, flowRole?: string): Promise<Answer> {
  return inTurn(a.seatRoot, a.name, () => resumeTurn(a, text, flowRole));
}

async function resumeTurn(asked: AgentOps.NamedAgent, text: string, flowRole?: string): Promise<Answer> {
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
  const flowRoot = a.seatRoot ?? projectRootOf(cwd) ?? cwd;
  /* The row is re-read and so is the flow: a step the person has since made
     their own runs nothing, and a finished turn is not a way back into it. */
  if (roleIsPersonStep(flowRoot, by.role)) {
    return refuse(`"${by.role}" is a person's step in the flow now: nothing runs there, so ${a.name} was not resumed.`);
  }
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
  const view = readPolicy(flowRoot);
  const engines = (await probeEngines()).engines;
  await primeOpencodeModels();

  /* A role switch: the id must be one the flow in force actually has (built-in
     ids included — `roleFor` resolves those too), and never a step the person
     now answers themselves. Its chain picks the engine and model, exactly as a
     fresh `--flow-role` start would, and its envelope is narrowed from the
     policy's own default by that role's lock — never the role it is leaving. */
  let engine = by.engine, model = by.model, envelope = by.envelope;
  let startedByPatch: Partial<StartedBy> = {};
  if (flowRole !== undefined) {
    if (roleIsPersonStep(flowRoot, flowRole)) {
      return refuse(`"${flowRole}" is a person's step in the flow: nothing runs there, so ${a.name} was not switched into it`);
    }
    const switched = planRoleSwitch(flowRoot, flowRole, { policy: view.policy, scope: view.scope }, engines);
    if (!switched.ok) return refuse(switched.error);
    ({ engine, model, envelope } = switched);
    startedByPatch = { ...switched.startedByPatch, from: by.engine !== engine ? by.engine : undefined };
  }
  /* A plain resume keeps the stamped engine, so a worker started on Claude
     before "No Claude in workers" went on would run its next turn on Claude
     anyway. A role switch is already planned with noClaude above. */
  if (flowRole === undefined && engine === "claude" && workerNoClaude(flowRoot)) {
    return refuse(`${a.name} runs on Claude, and "No Claude in workers" is on for this project, so it was not resumed. Turn it off in Settings ▸ Advanced ▸ Worker sandbox, or start a new worker.`);
  }
  const role = roleFor(flowRoot, startedByPatch.role ?? by.role);
  if (!role) return refuse(`role "${by.role}" is no longer in the flow`);
  // A row stamped before the fix may hold the bare name.
  if (engine === "opencode") model = qualifyOpencode(model);
  const bin = engines.find((e) => e.id === engine)?.path;
  if (!bin) return refuse(`${engine} is not installed here any more, so ${a.name} cannot be resumed`);
  // The engine stays the one it was stamped with, or the one the new role's
  // chain chose; what it may do does not outlive the person narrowing the
  // ceiling since. A ceiling that no longer allows the stored envelope in
  // full does not drop the turn: it is cut to the one envelope within both
  // the stored envelope and the ceiling, and the answer says which parts
  // were cut, so the worker resumes instead of needing a fresh start for a
  // change in the ceiling it had nothing to do with.
  let clamped: string[] = [];
  if (!envelopeWithin(envelope, view.policy.ceiling)) {
    const narrowed = clampEnvelope(envelope, view.policy.ceiling);
    clamped = clampedFields(envelope, narrowed);
    envelope = narrowed;
    startedByPatch = { ...startedByPatch, envelope };
  }
  // A resumed turn is a running worker like a started one, and counts the
  // same. This row is not counted: its own turn has ended (checked above), so
  // it is not one of the workers the limit is about.
  const live = a.seatRoot ? await AgentOps.liveOwnedBy(a.seatRoot) : 0;
  if (live >= view.policy.limits.maxWorkers) {
    return refuse(`${live} workers are already running for this seat and the limit is ${view.policy.limits.maxWorkers}. Stop one or wait for one to finish.`);
  }
  await ensureCheckoutDeps(cwd);
  const gap = nodeModulesGap(cwd);
  /* A plain resume never repeats the role's prompt (the role has not changed,
     so there is nothing new to say); a role switch opens with it, exactly as a
     fresh start under that role would. */
  const withRole = flowRole !== undefined ? withRolePrompt(text, rolePromptFor(flowRoot, role.id)) : text;
  const said0 = withBrowserCliNote(withDepsLine(withSubagentsNote(withPlanNote(withResultContract(withBrowserLine(withRole, engine, role.id, browserAskContextFor(flowRoot, role.id)), flowRoot, role.id), flowRoot, role.id, envelope), flowRoot, role.id), gap), engine, role, envelope);
  const said = flowRole !== undefined ? withNoBaseNote(said0, flowRoot, role.id) : said0;
  const turn = headlessTurn({ engine, bin, model, role, envelope, limits: view.policy.limits, prompt: said, resume, cwd, runDir: runFiles(a.name).dir, permissionMode: workerPermissionMode(flowRoot), ...workerExtras(flowRoot) });
  if (!turn.ok) return refuse(turn.error);
  await grantGh(turn.env, envelope);
  // The finished turn's tab is still open under this name; it goes before the
  // next opens, and before the next credential is minted (stopAgent revokes
  // every token for this name, including one minted ahead of it). The window is
  // not over: the scope of the finished run stays, and with it what it left
  // running for the person.
  const home = await AgentOps.sessionOfWindow(a.windowId);
  if (await AgentOps.keptTabOf(a)) await AgentOps.stopAgent(a, Date.now(), true, { endsWindow: false });
  // Before guardTurn: the serve freezes its env, and on 2.x the shell runs in it.
  const minted = mintBrowserCredential(turn.env, a.name, engine, role.id, { ttlMs: turn.tui ? undefined : view.policy.limits.turnMinutes * 60_000, ctx: browserAskContextFor(flowRoot, role.id), root: flowRoot });
  const takeBack = () => { if (minted) revokeWorkerToken(minted); };
  const g = await guardTurn(engine, bin, cwd, turn, a.name);
  if (!g.ok) { takeBack(); return refuse(g.error); }
  const files = prepareRun(a.name, said, turn.stdin);
  const tuiFrom = tuiStartOf(cwd, turn.tui ? resume ?? turn.sessionId : undefined);
  const r = await startGuarded({
    root: a.seatRoot ?? cwd, name: a.name, cwd, kind: engine, session: home,
    exactArgv: turn.tui ? wrappedTui(files, g.turn.argv) : wrapped(files, g.turn.argv, engine),
    env: g.turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: a.seatRoot ?? null, model, startedBy: asTui(withSandboxNote(nextTurn({ ...by, ...startedByPatch }, view.policy.limits.turnMinutes), turn), turn), resumeId: resume, role: role.id },
  }, g.serve);
  if (!r.ok) { takeBack(); return refuse(`the next turn could not start: ${r.error}`); }
  noteRunScope(a.name, g.serve?.unit ?? null);
  armWorker(AgentOps.agentNamed(a.name) ?? a, view.policy.limits.turnMinutes, turn, tuiFrom);
  return { status: 200, body: { ok: true, result: { name: a.name, outcome: "sent", resumed: resume, ...(flowRole !== undefined ? { role: role.id, engine, model } : {}), ...(gap ? { environment: gap.line } : {}), ...(turn.partly ? { partly: turn.partly } : {}), ...(clamped.length ? { clamped, clampedBecause: "this project's ceiling (Settings ▸ Orchestration) no longer allows the envelope this worker started with in full" } : {}) } } };
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

/**
 * The stamp of a turn that is about to open, with the one fact about its form:
 * a TUI turn leaves its answer as plain text in `out` (headless.ts `answerOf`),
 * and a turn that moved engine loses that with the form that had it.
 */
export function asTui(stamp: StartedBy, turn: { tui?: true }): StartedBy {
  const { tui: _, ...rest } = stamp;
  return turn.tui ? { ...rest, tui: true } : rest;
}

/**
 * The stamp of a turn about to open, with the one fact about its shell the
 * person may not be left to infer: a shell Claude Code's sandbox cannot hold is
 * not sandboxed, and the row says so in the same words the start's answer
 * carries (`unsandboxedBecause`). Idempotent, so a resume or an engine switch
 * does not repeat it.
 */
export function withSandboxNote(by: StartedBy, turn: { unsandboxed?: string }): StartedBy {
  if (!turn.unsandboxed || by.unsandboxed) return by;
  return { ...by, unsandboxed: true, because: [...by.because, turn.unsandboxed] };
}

/**
 * Where an interactive turn starts in its transcript, read BEFORE its CLI is
 * started. Read after the start returned, as it was, the size already held a
 * CLI that answers fast: the turn's own end marker was behind the watch's
 * starting point and the worker read "still on its turn" until its ceiling.
 * Measured with the worker harness's stub CLI, which writes its whole turn the
 * moment it starts: the kept start equalled the full transcript (654 of 654
 * bytes) on every failing run of flow-role-switch.test.ts, 0 on the passing
 * one. `undefined` (no session, or not an interactive turn) leaves the watch
 * to measure at arming, as before.
 */
function tuiStartOf(cwd: string, session: string | undefined): number | undefined {
  return session ? transcriptSize(transcriptFor(cwd, session)) : undefined;
}

/** Arm the turn limit and the watch on the turn's end, for a turn just opened.
 *  An interactive turn also gets its transcript watched, which is what writes
 *  the status the folder watch waits for (`agents/tuiturn.ts`). */
function armWorker(a: AgentOps.NamedAgent, turnMinutes: number, turn?: { tui?: true; sessionId?: string }, from?: number): void {
  const session = AgentOps.resumeIdOf(a.name) ?? turn?.sessionId ?? "";
  const files = runFiles(a.name);
  if (turn?.tui && session && from !== undefined) keepTuiFrom(files, from);
  arm(a, {
    deadline: a.startedAt + turnMinutes * 60_000, limitMinutes: turnMinutes, files,
    ...(turn?.tui && session ? { tui: { transcript: transcriptFor(a.cwd, session), from } } : {}),
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
    /* Its end is still the CLI's own marker: a Claude turn is a TUI, and a
       transcript written while this server was down still ends it, because the
       watch reads from where the turn began (kept in its run folder), not from
       the file's size now. */
    const session = AgentOps.resumeIdOf(a.name);
    arm(a, {
      deadline: null, limitMinutes: by.turnMinutes ?? 0, files, ended: (name) => endedTurn(name),
      ...(a.kind === "claude" && session ? { tui: { transcript: transcriptFor(a.cwd, session), from: tuiFromOf(files) ?? undefined } } : {}),
    });
    lost.push(a.name);
  }
  return { lost, settled: quiet };
}

/** What an ending reads besides the seat's send: the engine probe is asked for
 *  a failed turn, and a suite answers it rather than reading this machine. */
export interface EndedDeps extends EndDeps {
  probe?: () => Promise<EngineReadiness[]>;
  /** The resume a role-hop takes, injected so a suite can watch it without a
   *  real engine. Defaults to `promptHeadless`. */
  continueFlow?: (a: AgentOps.NamedAgent, text: string, flowRole: string) => Promise<Answer>;
}

/**
 * A worker's turn settled by itself (the timeout is ceilings.ts's own).
 *
 * Exported so the watcher's own tests can drive it with a fake send; the
 * watcher passes the name alone.
 */
export async function endedTurn(name: string, deps: EndedDeps = {}): Promise<void> {
  /* The row is read first: a watcher or deadline pass for the PREVIOUS turn
     arrives under the same name while the next one is live, and revoking by
     name would kill the credential the resume path just minted. A live row
     means this pass is about a turn that is not this one. */
  const a = AgentOps.agentNamed(name);
  if (a && a.exitCode === undefined) return;
  /* A turn that has ended must not leave its browser credential live, whether
     or not a row still names it; its page ids go with it, so the next turn
     under the same name starts with none. */
  const by = a && startedByOf(a);
  /* An interactive turn ends with its CLI still running in the kept tab, and
     the person may type the next turn there: that process holds the credential
     in an environment fixed at exec, so revoking it here left the worker's own
     tab refused ("unauthorized") on every browser call after the first turn.
     A live tab keeps its credential until the tab is stopped (`stopAgent`) or
     the next `prompt` replaces it. CEILING: the credential is as wide as it
     always was; only its life changes, to the tab's. */
  const tabLives = !!a && by?.tui === true && await AgentOps.paneAlive(a.paneId);
  if (!tabLives) revokeWorkerTokens(name);
  forgetWorkerPages(name);
  if (!a || !by) return;
  if (a.exitCode !== 0) {
    /* Asked before the seat's turn is taken and told after it is given back:
       checking the engines can take seconds a command, and every other start and
       prompt of this seat would wait behind it. */
    const ready = await (deps.probe ?? (async () => (await probeEngines()).engines))();
    const tell = await inTurn(a.seatRoot, name, () => failedTurn(a, by, ready));
    if (tell) await wakeForReport(tell, name);
  }
  recordStepEnd(name, by);
  /* A scout cannot save its plan, so the app saves the turn's message for it:
     the file in its checkout, and a report the seat's inbox holds. */
  saveScoutPlan(a);
  /* A first turn that failed and moved to the next engine is not an ending: the
     row was stamped again for the same worker, with no status, so nothing is
     said about it here. */
  const announced = await announceWorkerEnd(name, deps);
  // Chained off the same claim as the seat's notice, so a settling that races
  // the watcher (both reach here for the same ending) starts the next role once.
  if (announced) await chainToNextFlowRole(a, by, deps.continueFlow ?? promptHeadless).catch(() => {});
}

/**
 * Auto-continue (setting `flow.autoContinue`, off by default): a worker that
 * ended cleanly, with no trailing question, starts the next role on the
 * flow's path — same tab name, same worktree — through the resume path a
 * person's own `prompt --flow-role` takes (`promptHeadless`). A trailing
 * question is a blocker for the orchestrator, not a handoff, so it stops the
 * chain instead. The path is a flat order, not a graph, so there is no cycle
 * to cap.
 */
async function chainToNextFlowRole(
  a: AgentOps.NamedAgent, by: StartedBy, resume: (a: AgentOps.NamedAgent, text: string, flowRole: string) => Promise<Answer>,
): Promise<void> {
  if (a.exitCode !== 0 || !a.seatRoot) return;
  if (!autoContinueOn(a.seatRoot)) return;
  if (awaitingAnswer(a)) return;
  const next = nextPathRole(readFlow(a.seatRoot).flow, by.role);
  if (!next) return;
  const prev = roleFor(a.seatRoot, by.role)?.title ?? by.role;
  const nextRole = roleFor(a.seatRoot, next)?.title ?? next;
  await resume(a, `${prev} ended its turn. Continue this card as ${nextRole}.`, next);
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
  /* The kernel's answer beats the engine's: a turn whose scope was OOM killed
     reports that, not the `exit 1: … ECONNRESET` its socket left behind. */
  const oom = runOutOfMemory(a.name);
  let stopped = oom
    ? `out of memory (worker ceiling ${oom})`
    : `${engineTitle(by.engine)} exited with ${a.exitCode}${a.exitLine ? `: ${a.exitLine}` : ""}`;

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
  const cwd = a.seatRoot ? seatMayUse(a.seatRoot, a.cwd) : a.cwd;
  if (!prompt || !cwd) return `there was nothing to hand to another engine`;
  const flowRoot = a.seatRoot ?? projectRootOf(cwd) ?? cwd;
  /* The flow may have made this step the person's while the worker was
     running: nothing runs there, so the failed turn is reported, not moved. */
  if (roleIsPersonStep(flowRoot, by.role)) return `"${by.role}" is a person's step in the flow now, so the turn was not moved to another engine`;
  const role = roleFor(flowRoot, by.role);
  if (!role) return `role "${by.role}" is no longer in the flow`;
  if (!envelopeWithin(by.envelope, view.policy.ceiling)) return "the envelope it started with is beyond this project's ceiling now";
  const facts = factsNow();
  const pathOf = (engine: string) => { const r = ready.find((e) => e.id === engine); return r?.path && r.roles.worker.ok ? r.path : null; };
  /* A custom role has no slot of its own: it runs its own chain as the flow has
     it now. A role with a `policyRole` keeps that slot, whose "ask" still holds.
     A saved step that took a built-in id as its own runs its own chain too. */
  const own = savedStepOwningBuiltIn(flowRoot, by.role);
  const custom = own ? { ...own, chain: chainOf(own) } : workerRole(by.role) ? null : flowRoleInForce(flowRoot, by.role);
  const slots = resolve(view.policy, facts, ready).workers;
  const slot = custom ? (custom.policyRole ? slots[custom.policyRole] : null) : slots[role.id];
  await primeOpencodeModels();
  const next = nextEngine({
    chain: custom ? custom.chain : chainFor(view.policy, facts, role.id), by, ask: !!slot && slot.ok && slot.ask,
    usable: (c) => !!pathOf(c.engine) && !headlessRefusal(c.engine) && !(c.engine === "claude" && workerNoClaude(flowRoot)),
  });
  if (!next.ok) return next.why;
  const bin = pathOf(next.choice.engine)!;
  const model = workerModelFor(next.choice.engine, next.choice.model);
  const brief = withBrowserCliNote(withPlanNote(withResultContract(withBrowserLine(prompt, next.choice.engine, role.id, browserAskContextFor(flowRoot, role.id)), flowRoot, role.id), flowRoot, role.id, by.envelope), next.choice.engine, role, by.envelope);
  const turn = headlessTurn({ engine: next.choice.engine, bin, model, role, envelope: by.envelope, limits: view.policy.limits, prompt: brief, cwd, runDir: runFiles(a.name).dir, permissionMode: workerPermissionMode(flowRoot), ...workerExtras(flowRoot) });
  if (!turn.ok) return turn.error;
  await grantGh(turn.env, by.envelope);
  // The failed turn's tab is still open under this name; it goes before the next
  // opens. The window it meant is not over, so its scope is not stopped.
  const home = await AgentOps.sessionOfWindow(a.windowId);
  if (await AgentOps.keptTabOf(a)) await AgentOps.stopAgent(a, Date.now(), true, { endsWindow: false });
  const stamp: StartedBy = {
    ...by, engine: next.choice.engine, model, position: next.position,
    retries: (by.retries ?? 0) + 1, from: by.engine, turnMinutes: view.policy.limits.turnMinutes,
    because: [...by.because, `${engineTitle(by.engine)} ${WHY[why]}, so the next engine in the chain took over`],
  };
  const minted = mintBrowserCredential(turn.env, a.name, next.choice.engine, role.id, { ttlMs: turn.tui ? undefined : view.policy.limits.turnMinutes * 60_000, ctx: browserAskContextFor(flowRoot, role.id), root: flowRoot });
  const takeBack = () => { if (minted) revokeWorkerToken(minted); };
  const g = await guardTurn(next.choice.engine, bin, cwd, turn, a.name);
  if (!g.ok) { takeBack(); return g.error; }
  const files = prepareRun(a.name, brief, turn.stdin);
  const tuiFrom = tuiStartOf(cwd, turn.tui ? turn.sessionId : undefined);
  const r = await startGuarded({
    root: a.seatRoot ?? cwd, name: a.name, cwd, kind: next.choice.engine, session: home,
    exactArgv: turn.tui ? wrappedTui(files, g.turn.argv) : wrapped(files, g.turn.argv, next.choice.engine),
    env: g.turn.env, keep: true, lockedRole: true, yoloAllowed: false,
    owner: { seatRoot: a.seatRoot ?? null, model, startedBy: asTui(withSandboxNote(stamp, turn), turn), resumeId: turn.sessionId ?? null, role: role.id },
  }, g.serve);
  /* An engine that fails at launch is `died` here: its row is written and
     ended all the same, and its wrapper has left the status, so it is armed
     like any other and its own failure is read by the same path (a second
     failure, which is a need). */
  const started = r.ok ? r.agent : r.error === "died" ? AgentOps.agentNamed(a.name) : null;
  if (!started) { takeBack(); return `the next engine could not start: ${r.ok ? "no row" : r.error}`; }
  noteRunScope(a.name, g.serve?.unit ?? null);
  recordAction({
    actor: "policy", action: "worker/switch", target: a.name, ok: true,
    detail: `${a.name}: ${by.engine} to ${next.choice.engine} (${next.choice.model || "default model"}): ${engineTitle(by.engine)} ${WHY[why]} on its first turn`.slice(0, 300),
  });
  armWorker(started, stamp.turnMinutes!, turn, tuiFrom);
  return true;
}

/**
 * A worker started with `--plan` ended its turn: record whether it passed, for
 * the gate at Integrate. Pass = the turn ended with status 0 and, for a
 * reviewer (the built-in reviewer or a flow role whose policyRole is reviewer),
 * its final report has no line starting `BLOCKER`; an unreadable report is not a
 * pass. Never throws: a worker's end must not break on a book-keeping failure.
 */
export function recordStepEnd(name: string, by: StartedBy): void {
  if (!by.planId) return;
  try {
    const a = AgentOps.agentNamed(name);
    if (!a || a.exitCode === undefined) return; // moved to the next engine: not an ending
    let pass = a.exitCode === 0;
    const root = a.seatRoot ?? "";
    if (pass && (by.role === "reviewer" || flowRoleInForce(root, by.role)?.policyRole === "reviewer")) {
      const report = answerOf(by.tui, readText(runFiles(name).out));
      pass = report !== null && !report.split("\n").some((l) => l.trimStart().startsWith("BLOCKER"));
    }
    const head = git(a.cwd, ["rev-parse", "HEAD"]);
    recordStep(by.planId, by.role, pass ? "pass" : "fail", head.code === 0 ? head.stdout.trim() : null, by.branchTip ?? null, name);
  } catch (e) {
    if (!warnedStep) { warnedStep = true; console.warn(`flight plan step not recorded: ${(e as Error).message}`); }
  }
}
let warnedStep = false;
