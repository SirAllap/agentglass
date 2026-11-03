/*
 * The Flight plan, server side: when a Preflight may run (the project's list
 * of reviews, the plan's size, the second looks it has used), the run itself
 * once it may, and the rules that decide whether a coordinator may say Go
 * alone. No function here writes anything remote.
 */
import { namedFiles, runPreflight, type PreflightDeps, type PreflightInput } from "./preflight.ts";
import { linkPreflight, type SeatTask } from "./seatqueue.ts";
import { type LaunchedWhere, type Plan, countAutoRun, findingsAnswered, gateSince, listPlans, markLaunched, failCount, passedRoles, setPreflightRun, versionOf } from "./flightPlanStore.ts";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isLaunchMode, type LaunchMode } from "../../shared/launchModes.ts";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { commandVerdict, isInside, realish } from "./builderGuard.ts";
import { ruleRoot } from "./agentRulesStore.ts";
import { addWorktree } from "./gitwork.ts";
import { git } from "./git.ts";
import { APP, REVIEW_OF, clearRetired, createRun, fail, finish, getRun, getSetting, PREFLIGHT_MODEL_ALIAS, retiredSetting, setState, type Moment, type Run } from "./preflightStore.ts";
import { readFlow } from "./flow.ts";
import { readStoredFlow, workerRoles, writeWorkerRole } from "./config.ts";
import { roleLockFor, rolePromptFor } from "./rolePrompt.ts";
import { toolsDeniedFor } from "./agents/envelope.ts";
import { chainInForce } from "./orchestration.ts";
import { budgetState } from "./flightBudget.ts";
import { builderPick, overrideVerdict, sensitiveHit, sensitivePath, type BuilderModel, type BuilderPick } from "../../shared/builderModel.ts";
import { preflightTargetFromChain, type PreflightTarget } from "../../shared/preflightEngine.ts";
import type { BuilderState, Pilot, StopReason } from "../../shared/types.ts";

/** Tests swap the runner's deps; a booted test server reads AGENTGLASS_PREFLIGHT_BIN, honoured only under NODE_ENV=test. */
let depsOverride: PreflightDeps | null = null;
export function __setPreflightDeps(d: PreflightDeps | null) { depsOverride = d; }
const deps = (): PreflightDeps => depsOverride ?? (process.env.NODE_ENV === "test" && process.env.AGENTGLASS_PREFLIGHT_BIN ? { bin: [process.execPath, process.env.AGENTGLASS_PREFLIGHT_BIN], env: Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith("STUB_") && v !== undefined) as [string, string][]) } : {});

/** Told when a run ends, however it ended: the server wires it to the coordinator's wake and the view's refresh. */
let ended: ((run: Run) => void) | null = null;
export const onRunDone = (f: ((run: Run) => void) | null) => { ended = f; };

/** Runs a run now and records how it ended. Resolves when it has; callers that must not wait do not await. */
export async function execute(id: string): Promise<void> {
  const run = getRun(id);
  if (!run || run.state !== "running") return;
  try { finish(id, await runPreflight(run.input, deps())); } catch (e) { fail(id, (e as Error).message, (e as { costUsd?: number }).costUsd); }
  const done = getRun(id);
  if (done) try { ended?.(done); } catch { /* a wake that fails must not fail the review */ }
}

export interface RequestIn {
  root: string; moment: Moment; by: string; taskId?: string | null; capUsd?: number;
  files?: string[]; ranges?: Record<string, [number, number][]>; leftOut?: { path: string; reason: string }[]; mockups?: string[]; pr?: { number: number; root: string }; extraText?: { name: string; body: string }[];
}
export type Requested = { ok: true; run: Run; done: Promise<void> } | { ok: false; error: string };

export function request(r: RequestIn): Requested {
  if (!projectOn(r.root)) return { ok: false, error: `Flight plan is off in ${r.root}.` };
  // A Preflight runs the moment it is asked for: the list of reviews decides whether it is asked at all, and a press on Run is always asked.
  const review = REVIEW_OF[r.moment];
  if (review && !(getSetting(r.root, "flightPlan.preflight.reviews") as string[]).includes(review)) return { ok: false, error: `Preflight does not review ${r.moment} in ${r.root}.` };
  const target = preflightTargetFor(r.root);
  const input: PreflightInput = {
    files: r.files ?? [], ...(r.ranges ? { ranges: r.ranges } : {}), ...(r.leftOut?.length ? { leftOut: r.leftOut } : {}), mockups: r.mockups ?? [], root: r.root, ...(r.pr ? { pr: r.pr } : {}), ...(r.extraText ? { extraText: r.extraText } : {}),
    engine: target.engine, model: target.model, budgetUsd: r.capUsd ?? Number(getSetting(r.root, "flightPlan.preflight.costCapUsd")),
  };
  const run = createRun({ root: r.root, moment: r.moment, state: "running", by: r.by, input, taskId: r.taskId });
  return { ok: true, run, done: execute(run.id) };
}

export function go(id: string): { ok: true; run: Run; done: Promise<void> } | { ok: false; error: string; status: number } {
  if (!getRun(id)) return { ok: false, error: "no such run", status: 404 };
  if (!setState(id, "awaiting-go", "running")) return { ok: false, error: "that run is not waiting for Go", status: 409 };
  return { ok: true, run: getRun(id)!, done: execute(id) };
}
export function noGo(id: string): { ok: true; run: Run } | { ok: false; error: string; status: number } {
  if (!getRun(id)) return { ok: false, error: "no such run", status: 404 };
  if (!setState(id, "awaiting-go", "declined")) return { ok: false, error: "that run is not waiting for Go", status: 409 };
  return { ok: true, run: getRun(id)! };
}

/**
 * After a task is finished: a Preflight over what the agent said it did, when
 * the project's reviews include taskDone and the flight plan the task came from
 * is L (a task with no plan, S or M, is small enough not to be worth one). The
 * task keeps the link; the caller does not wait for the review. finishTask
 * itself stays pure.
 */
export function afterTaskDone(t: SeatTask, by: string): Promise<void> {
  if (!listPlans({ root: t.root }).some((p) => p.taskId === t.id && p.size === "L")) return Promise.resolve();
  const body = `# ${t.title}\n\n## Detail\n${t.detail || "(none)"}\n\n## Proof\n${t.proof || "(none)"}\n\n## Outcome\n${t.outcome || "(none)"}\n`;
  const r = request({ root: t.root, moment: "task-done", by, taskId: t.id, extraText: [{ name: "TASK.md", body }] });
  if (!r.ok) return Promise.resolve();
  linkPreflight(t.id, r.run.id);
  return r.done;
}

const brief = (p: Plan) => `# ${p.title}\n\n## Request\n${p.request}\n\n## Flight plan\n${p.planMd}\n`;

/** A Preflight over the plan and its mockups, at the before-launch moment: the project's list of reviews decides whether it runs. An S plan never gets one. */
export function preflightPlan(p: Plan, by: string, capUsd?: number): Requested {
  if (p.size === "S") return { ok: false, error: "an S plan gets no Preflight: a change that small is sent straight to a builder" };
  // A second press while a review runs or waits for Go is the same review: a double click must not spend twice.
  const openRun = p.preflightRunId ? getRun(p.preflightRunId) : null;
  if (openRun && (openRun.state === "running" || openRun.state === "awaiting-go")) return { ok: true, run: openRun, done: Promise.resolve() };
  const body = brief(p), named = namedFiles(body, p.root);
  const r = request({ root: p.root, moment: "before-launch", by, taskId: p.taskId, capUsd, files: named.files, ranges: named.ranges, leftOut: named.leftOut, extraText: [{ name: "PLAN.md", body }], mockups: p.mockups.map((m) => m.path) });
  if (r.ok) setPreflightRun(p.id, r.run.id);
  return r;
}

/** The first review, plus `secondLooks` after a fix: each edit re-reviewed without a limit never converges. Co-pilot and Manual; Autopilot is held by money, see seatMayPreflight. */
export const autoRunsMax = (): number => 1 + Number(getSetting(APP, "flightPlan.preflight.secondLooks"));

/**
 * The most Preflights one plan gets while its coordinator flies it in Autopilot.
 * There the money decides (each run's cost cap, and the day's and the week's
 * budget), not the second looks; but a budget set high must not let an agent
 * that keeps editing and re-reviewing one plan loop on it for a whole day.
 */
export const AUTOPILOT_PREFLIGHTS_MAX = 8;

/** Autopilot, not held, and the budget not reached: the coordinator is held by money, not by the second looks. A reached budget is Co-pilot until it resets. */
const flownOnMoney = (root: string, now = Date.now(), fresh = false): boolean =>
  pilotOf(root) === "autopilot" && !isHeld(root) && !budgetState(now, undefined, fresh).reached;

/**
 * Why the project's coordinator may not start another Preflight on this plan
 * alone, or null. Only the seat gets the Autopilot allowance: any other agent
 * keeps the second looks. The person's press is never counted.
 */
export function seatMayPreflight(p: Plan, seat: boolean, now = Date.now()): string | null {
  // Never from the cache: a Preflight spends, so it reads the books as they are now.
  if (seat && flownOnMoney(p.root, now, true)) return p.reviewRounds >= AUTOPILOT_PREFLIGHTS_MAX ? `This plan has had ${AUTOPILOT_PREFLIGHTS_MAX} Preflights in Autopilot, the most one plan gets: another is the person's call` : null;
  return p.reviewRounds >= autoRunsMax() ? "The second looks are used: another Preflight on this plan is the person's call" : null;
}

/** A blocker nobody has answered yet in the plan's last finished Preflight. */
const openBlocker = (p: Plan): boolean => {
  const run = p.preflightRunId ? getRun(p.preflightRunId) : null;
  return run?.state === "done" && (run.certificate?.findings ?? []).some((f) => f.severity === "blocker" && f.action === null);
};

/**
 * A plan just got new text: the project's list of reviews, the sizes Preflight
 * looks at, the second looks it has used, the ceiling per plan and the budget
 * decide. Server side, so it does not depend on the view being open. A plan at
 * Go goes back to ready when its text changes, so it is reviewed again too.
 */
export function afterPlanText(p: Plan, by: string): Requested | null {
  if (!p.planMd.trim() || p.size === "S") return null;
  if (p.size === "M" && getSetting(APP, "flightPlan.preflight.sizes") === "L") return null;
  const open = p.preflightRunId ? getRun(p.preflightRunId)?.state : undefined;
  if (open === "running" || open === "awaiting-go") return null;
  if (p.autoRuns >= autoRunsMax() || p.reviewRounds >= AUTOPILOT_PREFLIGHTS_MAX) return null;
  // A run on its own spends like a press: none once the day's or the week's budget is reached. Read fresh, as a press does.
  if (budgetState(Date.now(), undefined, true).reached) return null;
  const r = preflightPlan(p, by);
  if (r.ok) countAutoRun(p.id);
  return r;
}

/**
 * Launch a plan that said Go. The ticket is minted first: if minting throws, the
 * plan is still at Go and can be launched again; marked launched first, it would
 * be history with no worker. Null when another press got there first.
 */
export function launchPlan(p: Plan, mint: () => string, where: LaunchedWhere = {}): string | null {
  const ticket = mint();
  return markLaunched(p.id, where) ? ticket : null;
}

/**
 * The worktree a launched builder works in: `<repo>-fp-<slug>` beside the repo, on
 * `flight-plan/<slug>`, cut from the project's main branch. A name already taken
 * (a path or a branch) gets `-2`, `-3`... so a second plan with the same title
 * never lands in the first one's tree. Synchronous after `base` is known, so the
 * caller can check the plan is still at Go and cut the tree in the same tick.
 * An error here means no launch: the builder never falls back to the shared checkout.
 */
/**
 * The ref builders are cut from and landing is judged against. `defaultBranch`
 * prefers `origin/<b>`, but a project whose merges stay local runs far ahead of
 * it: a tree cut from the remote starts months behind and a branch merged into
 * the local branch never looks landed. When the local branch contains the
 * remote one, use the local one. A diverged or missing local branch keeps the
 * remote ref (shortcut: no attempt to pick between diverged branches).
 */
export function localBase(root: string, base: string): string {
  if (!base.startsWith("origin/")) return base;
  const local = base.slice("origin/".length);
  const has = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`]).code === 0;
  return has && git(root, ["merge-base", "--is-ancestor", base, `refs/heads/${local}`]).code === 0 ? local : base;
}

export function cutBuilderWorktree(root: string, title: string, base: string | null): { ok: true; path: string; branch: string } | { ok: false; error: string } {
  if (!base) return { ok: false, error: "no main branch found in that project, so there is nothing to cut a worktree from" };
  const slug = title.toLowerCase().replace(/[`'"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "plan";
  const name = basename(root).replace(/\.git$/, "");
  for (let n = 1; n <= 20; n++) {
    const s = n === 1 ? slug : `${slug}-${n}`;
    const path = join(dirname(root), `${name}-fp-${s}`);
    const branch = `flight-plan/${s}`;
    if (existsSync(path) || git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0) continue;
    const r = addWorktree(root, path, branch, true, base);
    return r.ok ? { ok: true, path, branch } : { ok: false, error: `could not create the builder's worktree: ${r.error ?? "git refused"}` };
  }
  return { ok: false, error: "twenty worktrees for this plan title already exist: remove some" };
}

/** What the author agent is told: our own words, short. It saves the plan through the door, so the plan stays a draft until it has. */
export function authorPrompt(p: Plan, guide: string): string {
  return [
    `You are the author of flight plan ${p.id} in ${p.root}. Nothing is built from this request yet: you write the plan, a reader with no context reviews it, and the person says Go.`,
    `Request:\n${p.request}`,
    "Write the flight plan in Markdown: what will be built and why, the steps, how each part is checked in the real running app, what it removes or replaces, and what you decided where the request was silent. Read the code before you claim anything about it.",
    p.visual ? `This request is visual: also make a mockup (a .png, .jpg, .webp or .html file under the project's folder) showing every state the plan needs, including empty, loading, error and long text.${guide ? ` Follow the house mockup style guide at ${guide}.` : ""}` : "",
    `Save the plan with: agentglass-ui flight-plan plan set ${p.id} --file <your plan.md> --as flight-plan-author`,
    p.visual ? `Attach the mockup with: agentglass-ui flight-plan plan mockup ${p.id} <path>... --as flight-plan-author (the whole list each time)` : "",
    "Then stop. Do not start building: Launch is the person's.",
  ].filter(Boolean).join("\n\n");
}

/**
 * The Builder role's prompt from the project's saved flow, or the shipped one
 * when that flow has no Builder prompt. A project with no saved flow gets "":
 * its launches stay as they were until somebody opens the flow editor.
 */
export const builderRolePrompt = (root: string): string => rolePromptFor(root, "builder");

/** The brief a launched worker starts with: the plan the person said Go to, and the mockups beside it. */
export function launchPrompt(p: Plan, coordinator: string | null = null): string {
  const progress = `As you work, keep the Flight plan view current: \`agentglass-ui flight-plan plan report ${p.id} "<one line: done or next>" --step <n> --of <m>\` after each step.`;
  const role = builderRolePrompt(p.root);
  return `${role ? `${role}\n\n` : ""}${brief(p)}${p.mockups.length ? `\n## Mockups\n${p.mockups.map((m) => `- ${m.path} (${m.kind})`).join("\n")}\nBuild what the mockup shows.\n` : ""}\nThis flight plan was reviewed and given Go. Build it as written; where it is silent, decide and say what you decided.\n\n${progress}\n\n${reportingBlock(coordinator)}`;
}

/** The builder's tab name on the strip: short, from the plan's branch (`flight-plan/<slug>`). */
export const builderWindowName = (branch: string): string => `fp-${branch.replace(/^flight-plan\//, "")}`.slice(0, 24).replace(/-+$/, "");

/** The last block of a builder's brief: who it answers to, and what it never does alone. */
export function reportingBlock(coordinator: string | null): string {
  const limits = "Local commits only, in your own worktree; you never push, open a pull request, merge, tag, release, change agentglass settings or rules, or touch another repository without that order. File edits outside your worktree are refused and a shell command out of it is not checked, so keep to it. The launch refuses the tools for most of these, so an attempt is denied, not asked: to bring the project's main branch into yours, rebase onto it (`git merge` is denied).";
  return coordinator
    ? `You report to ${coordinator} via SendMessage, in 3 lines at most, when you finish or get blocked. ${limits.replace("that order", `${coordinator}'s order`)}`
    : `This project has no coordinator: report to the person. When you finish or get blocked, run \`agentglass-agent need "<3 lines: what is done or what blocks you>"\` so it shows as needs-you. ${limits.replace("that order", "the person's order")}`;
}

/**
 * What a launched builder is denied, whatever the mode and the person's own
 * list say. Passed as `--disallowedTools`, which the harness enforces, and not
 * as a rule the agent-rules check holds: that check fails open when the server
 * is slow (the worktree guard below does ride that check, and says so). Leaving
 * its own worktree is not a tool rule and is not here: file writes are held by
 * worktreeVerdict, a shell command by the brief only.
 * `git merge` is denied whole, because a rule cannot tell main into the branch
 * from the branch into main: a builder rebases instead.
 * GitHub's branch protection stays the last barrier for anything remote.
 */
export const BUILDER_DENY: readonly string[] = [
  "Bash(git push:*)", "Bash(gh pr:*)", "Bash(gh release:*)", "Bash(git merge:*)", "Bash(git tag:*)",
  "Bash(agentglass-ui settings set:*)", "Bash(agentglass-ui rules set:*)",
];

/** BUILDER_DENY plus the saved flow's lock for the builder role: the write tools when it reads only, every tool its list leaves out. Appended only; no saved flow = BUILDER_DENY as it was. */
export function builderDenyFor(root: string): readonly string[] {
  const lock = roleLockFor(root, "builder");
  if (!lock) return BUILDER_DENY;
  return [...new Set([...BUILDER_DENY, ...(lock.readsOnly ? ["Edit", "Write", "NotebookEdit", "MultiEdit"] : []), ...toolsDeniedFor(lock.tools)])];
}

/** What the launched builder starts with: the person's chosen permission mode (Auto unless set), and the model the plan's size and what it touches pick. */
export function builderLaunch(plan: { size: "S" | "M" | "L" | null; planMd: string }, role: { provider: string; model: string }, permissions: string, strong: string): { mode: LaunchMode; model: BuilderModel; why: string } {
  const pick = builderPick(plan, role, strong);
  return { mode: isLaunchMode(permissions) ? permissions : "auto", model: pick.model, why: pick.why };
}
/** A model asked for at Go, or why it cannot be used: a stronger one than the plan's pick is the person's. */
export function builderOverride(pick: BuilderPick, wanted: string, person: boolean): { ok: true; model: BuilderModel } | { ok: false; error: string } {
  const why = overrideVerdict(pick, wanted, person);
  return why ? { ok: false, error: why } : { ok: true, model: wanted as BuilderModel };
}

/**
 * The engine and model a Preflight reviews with: the first engine of the
 * project's Reviewer chain, so a project rule that moves the Reviewer moves the
 * Preflight too. Claude and OpenCode are the two CLIs a review runs on; any
 * other engine leaves Claude Sonnet to read it, and the card says so rather
 * than the run going quiet about it.
 */
export function preflightTargetFor(root: string): PreflightTarget {
  adoptPreflightModel(root);
  return preflightTargetFromChain(chainInForce(root, "reviewer"), workerRoles().reviewer);
}

/** The model a Preflight reviews with, which is the target's. */
export function preflightModel(root: string): string {
  return preflightTargetFor(root).model;
}

/**
 * Once: a model stored at the old per-project key becomes the Reviewer role's
 * model, and the key goes, so one choice is left. A Reviewer role on another CLI
 * keeps its engine; the old key goes without being adopted, because a Claude
 * model name is not one that engine takes.
 *
 * The role is written before the key is cleared, and the key stays when that
 * write failed (a config.json that does not parse, a config directory that
 * cannot be written): clearing first loses the person's model for good.
 * Unlike the LEGACY_MOMENT rows, this one is deleted rather than kept, because
 * it is an alias and not a record: a row left behind is re-adopted on the next
 * read and beats a model chosen in Orchestration afterwards.
 */
function adoptPreflightModel(root: string): void {
  for (const at of root === APP ? [APP] : [root, APP]) {
    const old = retiredSetting(at, PREFLIGHT_MODEL_ALIAS);
    if (!old) continue;
    const role = workerRoles().reviewer;
    if (role.provider === "claude" && old !== role.model && !writeWorkerRole("reviewer", { provider: "claude", model: old }).ok) continue;
    clearRetired(at, PREFLIGHT_MODEL_ALIAS);
  }
}

/* ── Pilot: when a coordinator may say Go alone ── */

export const pilotOf = (root: string): Pilot => {
  const v = getSetting(root, "flightPlan.pilot");
  return v === "manual" || v === "autopilot" ? v : "copilot";
};
/** A hold is kept under the project's root however the plan or the caller spelled the path (a worktree, a trailing slash): the one key every reader and writer uses. */
export const heldKey = (root: string): string => ruleRoot(root);
/** False for a project the person left out of Flight plan: no plan is written, no Preflight runs there. */
export const projectOn = (root: string): boolean => getSetting(root, "flightPlan.project.enabled") !== false;
export const isHeld = (root: string): boolean => getSetting(heldKey(root), "flightPlan.held") === true;

/** Paths whose change the person looks at first. The list lives with the model pick, which reads the same plan text. */

/**
 * Why this plan needs the person before it flies, or null when nothing does.
 * One rule at a time, in the order a person would read them: a question that
 * is already open, a finding nobody could decide, a blocker that survived the
 * second looks, then the size, what it touches and the money. Computed, not
 * stored, so a toggle turned off or a cap raised takes effect on the next look.
 */
export function stopReason(p: Plan, now = Date.now(), fresh = false): StopReason | null {
  if (p.question && !p.question.answer && p.stopReason) return p.stopReason;
  const run = p.preflightRunId ? getRun(p.preflightRunId) : null;
  const findings = run?.state === "done" ? run.certificate?.findings ?? [] : [];
  if (findings.some((f) => f.action === "ask")) return "ask-finding";
  // In Autopilot the coordinator answers a blocker itself (fix, contest, ask) and seatMayFly holds its Go until it has: not the person's stop. Co-pilot keeps the second looks.
  if (!flownOnMoney(p.root, now, fresh) && p.autoRuns >= autoRunsMax() && openBlocker(p)) return "open-blocker";
  if (p.size === "L" && getSetting(p.root, "flightPlan.autopilot.askOnLarge") === true) return "large";
  if (getSetting(p.root, "flightPlan.autopilot.askOnSensitive") === true && sensitiveHit(p.planMd)) return "sensitive";
  if (budgetState(now, undefined, fresh).reached) return "budget";
  if (p.id && roundsUsed(p).length) return "rounds-used";
  return null;
}

/** The refusal, in one sentence, for each reason. */
export const STOP_SENTENCE: Record<StopReason, string> = {
  "ask-finding": "a finding is marked Ask: the person decides it",
  "open-blocker": "the Preflight still has an open blocker after the allowed second looks",
  large: "this is an L plan, and the person asked to be asked before Go on a large plan",
  sensitive: "this plan touches auth, migrations, secrets, payments, CI or a dependency, and the person asked to be asked before Go on those",
  budget: "Flight plan reached its budget for the day or the week: Autopilot is Co-pilot until it resets",
  "builder-blocked": "a builder is blocked: the person decides what happens next",
  "sensitive-diff": "the builder's real diff touches auth, migrations, secrets, payments, CI or a dependency: the person looks before it lands",
  "required-step": "A step the flow marks required has no passing result yet: a person decides.",
  "rounds-used": "A step has failed the most times the flow allows: a person decides.",
};

/**
 * Names of the roles the saved flow marks required, that are on its path, and
 * have no passing result recorded for this plan's current text. Empty for a
 * plan with no saved flow, no required role on the path, or one made before the
 * gate existed. A required id that left the roster is ignored. Computed on
 * every look, so there is no flag to clear.
 */
export function requiredMissing(p: Plan): string[] {
  if (p.createdAt < gateSince()) return [];
  const flow = readStoredFlow(p.root);
  if (!flow) return [];
  const done = passedRoles(p.id);
  return flow.roster.filter((r) => r.required && flow.path.includes(r.id) && !done.has(r.id)).map((r) => r.name);
}

/** A failing arrow whose role has failed this plan as many times as it allows. */
const spentEdge = (p: Plan, e: { on: string; from: string; maxRounds?: number }): boolean =>
  e.on === "fail" && e.maxRounds !== undefined && Number.isInteger(e.maxRounds) && e.maxRounds > 0 && failCount(p.id, e.from) >= e.maxRounds;

/**
 * Names of the roles whose fail edge in the saved flow has been used up: the
 * role failed this plan at least `maxRounds` times. An edge with no positive
 * integer maxRounds is not enforced. Same exemption and same no-flag rule as
 * requiredMissing: counts are read now, so raising maxRounds clears it.
 */
export function roundsUsed(p: Plan): string[] {
  if (p.createdAt < gateSince()) return [];
  if (!readStoredFlow(p.root)) return [];
  const flow = readFlow(p.root).flow, names = new Map(flow.roster.map((r) => [r.id, r.name]));
  return flow.edges.filter((e) => spentEdge(p, e)).map((e) => names.get(e.from) ?? e.from);
}

/**
 * Whether starting `role` for this plan would go round a fail edge that is
 * used up: the role is the failing end of it. A built-in role reaches its
 * roster entry by `policyRole`; a role a person made, by its id.
 */
export function roundsSpentFor(p: Plan, role: unknown): boolean {
  if (typeof role !== "string" || p.createdAt < gateSince()) return false;
  if (!readStoredFlow(p.root)) return false;
  const flow = readFlow(p.root).flow;
  const ids = new Set(flow.roster.filter((r) => r.id === role || r.policyRole === role).map((r) => r.id));
  return flow.edges.some((e) => ids.has(e.from) && spentEdge(p, e));
}

/** Whether the project's coordinator may say Go to this plan on its own: only in Autopilot, not held, with nothing in stopReason. The sentence is the reason when not. */
export function seatMayFly(p: Plan): { ok: true } | { ok: false; error: string } {
  // Never from the cache: a Go spends, so it reads the books as they are now.
  const pilot = pilotOf(p.root);
  if (pilot !== "autopilot") return { ok: false, error: `this project flies in ${pilot === "copilot" ? "Co-pilot" : "Manual"}: Go is the person's` };
  if (isHeld(p.root)) return { ok: false, error: "this project is held: no new Go until the person resumes it" };
  const why = stopReason(p, Date.now(), true);
  if (why) return { ok: false, error: `Go is the person's here: ${STOP_SENTENCE[why]}` };
  // Not a stop for the person: the coordinator answers it first.
  if (openBlocker(p)) return { ok: false, error: "a blocker in the last Preflight has no answer yet: fix it, contest it with the evidence, or ask the person, then Go" };
  return { ok: true };
}

/**
 * Whether a launched builder's work has landed: its branch is gone, or it moved
 * off the commit it was cut from and the project's main branch now holds it. A
 * branch still on its starting commit has landed nothing, though git calls it
 * an ancestor of main.
 */
export function landed(p: Plan, base: string): boolean {
  const l = p.launched;
  if (!l?.branch) return true;
  const tip = git(p.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${l.branch}`]);
  if (tip.code !== 0) return true;
  return tip.stdout.trim() !== l.from && git(p.root, ["merge-base", "--is-ancestor", `refs/heads/${l.branch}`, base]).code === 0;
}
/** The builders of a project still in the air: launched, and not landed. */
export const flying = (root: string, base: string): Plan[] => listPlans({ root, state: "launched" }).filter((p) => !landed(p, base));
/** A builder is at work while its tab has a live pane. A launched plan whose tab is gone is paused: it holds no slot and costs nothing. */
export const builderLive = (panes: readonly { dead?: boolean }[] | null): boolean => !!panes?.some((x) => !x.dead);

/** What a plan's linked worker is doing, from its own row: working, ended, or null when the name has no row here. */
export type WorkerState = "working" | "ended";
export function workerPhase(name: string | null | undefined, rows: readonly { name: string; endedAt: number | null }[]): WorkerState | null {
  if (!name) return null;
  const row = rows.find((r) => r.name === name);
  return row ? (row.endedAt === null ? "working" : "ended") : null;
}

/** The windows of every tmux session as `allWindowTrees` lists them; null when tmux did not answer. */
export type WindowTrees = ReadonlyMap<string, readonly { id: string; panes: readonly { dead?: boolean }[] }[]> | null;
/** What the list says about a launched plan's builder tab. Pure: the caller reads tmux once for all plans. */
export function builderOf(l: { session?: string; window?: string } | null, trees: WindowTrees): BuilderState {
  if (!l?.window) return "none";
  if (!trees) return "unknown";
  /* A window id is unique on the tmux server; a launch that recorded no session is looked for in all of them. */
  const w = (l.session ? trees.get(l.session) ?? [] : [...trees.values()].flat()).find((x) => x.id === l.window);
  return w && builderLive(w.panes) ? "live" : "gone";
}
/**
 * When a builder tab was first seen closed. Written by the first read that sees
 * "gone" with tmux readable, cleared on "live", never touched on "unknown".
 * shortcut: the map lives in memory, so a restart forgets it and the next read
 * stamps the time it noticed; upgrade to a column if "closed at" must survive restarts.
 */
export function noteGone(seen: Map<string, number>, id: string, b: BuilderState, now: number): number | null {
  if (b === "live") seen.delete(id);
  else if (b === "gone" && !seen.has(id)) seen.set(id, now);
  return seen.get(id) ?? null;
}
/**
 * noteGone for one listed plan, forgetting the entry once the plan's flight is over (landed, or no longer launched).
 * A plan absent from a list keeps its entry: a partial read says nothing about it.
 */
export function trackGone(seen: Map<string, number>, p: { id: string; state: string; landedAt: number | null }, b: BuilderState, now: number): number | null {
  if (p.state !== "launched" || p.landedAt) { seen.delete(p.id); return null; }
  return noteGone(seen, p.id, b, now);
}
/**
 * When the plan entered the state the person reads on it. A landed plan: when it landed. Waiting on a person
 * (an open question, a stop rule) since its last update. A parked plan since its tab was seen closed; Building
 * and Quiet since launch; Go since the Go.
 */
export function stateSinceOf(p: { state: string; launched: { at: number } | null; landedAt: number | null; updatedAt: number; decision: { at: number } | null; question: unknown; stopReason: unknown }, goneAt: number | null): number {
  if (p.landedAt) return p.landedAt;
  if (p.question || (p.state === "launched" && p.stopReason)) return p.updatedAt;
  if (goneAt != null) return goneAt;
  if (p.launched) return p.launched.at;
  return p.state === "go" && p.decision ? p.decision.at : p.updatedAt;
}
/** A builder holds one of the flightPlan.maxFlying slots unless its tab is known to be gone. */
export const holdsSlot = (b: BuilderState): boolean => b !== "gone";

/* ── the builder stays in its worktree ── */

/** The env var a builder's tab starts with: the worktree it was cut. The pre-tool hook sends it with every check. */
export const BUILDER_ENV = "AGENTGLASS_BUILDER_WORKTREE";

const FILE_WRITES: Record<string, string> = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
/** The one scratch directory a builder may write besides its worktree: its own, named after the tree, never the shared system temp. */
export const builderTmp = (worktree: string): string => join(tmpdir(), `agx-builder-${basename(worktree)}`);

/**
 * The agent-rules answer for a builder's file write: "never" when the file is
 * outside the worktree the builder was cut (and its own scratch directory).
 * Null for anything else, so the project's own rules decide. It rides the same
 * pre-tool-call check as every rule, so it fails open the same way: a server
 * that does not answer in 2 s lets the call through, and says so on stderr.
 * shortcut: the file tools are checked by path and a shell command by
 * builderGuard.ts reading its command line; a script the builder writes and
 * then runs is not seen. Upgrade by running builders in a sandbox.
 */
export function worktreeVerdict(bound: string, cwd: string, tool: string, input: string, tmp = builderTmp(bound)): { decision: "never"; ruleId: string; reason: string } | null {
  const field = FILE_WRITES[tool];
  if (!field) return null;
  let given: unknown;
  try { given = (JSON.parse(input) as Record<string, unknown>)[field]; } catch { return null; }
  if (typeof given !== "string" || !given) return null;
  const real = realish(isAbsolute(given) ? resolve(given) : resolve(cwd, given));
  if (isInside(real, bound) || isInside(real, tmp)) return null;
  return { decision: "never", ruleId: "flight-plan-worktree", reason: `This builder works in ${bound} and may not ${tool === "NotebookEdit" ? "edit" : "write"} ${real}. If the change belongs outside it, tell your coordinator.` };
}

/** Every pre-tool check a builder's call goes through: its file tools and its shell. */
export function builderVerdict(bound: string, cwd: string, tool: string, input: string, base: string | null): { decision: "never"; ruleId: string; reason: string } | null {
  if (tool !== "Bash") return worktreeVerdict(bound, cwd, tool, input);
  let command = "";
  try { command = String((JSON.parse(input) as { command?: unknown }).command ?? ""); } catch { return null; }
  return commandVerdict(command, { worktree: bound, cwd, tmp: builderTmp(bound), base, home: homedir() });
}

/**
 * Why Go has to wait for a Preflight, or null: when the project's reviews list the
 * plan and the size is one Preflight looks at, Go (anyone's) needs a finished run
 * on the plan as it is now. An S plan skips, as designed. A run that read an
 * earlier text or size does not count, so a coordinator cannot get a clean review
 * and then change the plan. One exception: a text edited only after every finding
 * had its answer, and still answered now, is the answer to them (EditAfterReview);
 * the plan and its Go record say so. The size is never excused.
 */
export function reviewBlock(p: Plan): string | null {
  if (p.size === "S" || !(getSetting(p.root, "flightPlan.preflight.reviews") as string[]).includes("plan")) return null;
  if (p.size === "M" && getSetting(APP, "flightPlan.preflight.sizes") === "L") return null;
  const run = p.preflightRunId ? getRun(p.preflightRunId) : null;
  if (!run) return "this plan has not been reviewed yet: a Preflight has to finish on it before Go";
  if (run.state === "running" || run.state === "awaiting-go") return "the Preflight is still reading this plan: Go when it finishes";
  if (run.state !== "done") return "the last Preflight did not finish: run it again before Go";
  const answered = p.editedAfterReview === "answered" && findingsAnswered(p.preflightRunId);
  if ((p.reviewedVersion !== versionOf(p.id) && !answered) || p.reviewedSize !== p.size) return "the plan changed after its last Preflight: it needs a fresh one before Go";
  return null;
}

/** Paths a builder changed, between the commit it was cut from and its branch now. Empty when git cannot say. */
export function builderDiff(p: Plan): string[] {
  const l = p.launched;
  if (!l?.branch || !l.from) return [];
  const r = git(p.root, ["diff", "--name-only", `${l.from}..refs/heads/${l.branch}`]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
/** The first sensitive path in the builder's real diff, or null: what stops Integrate with `sensitive-diff`. */
export function sensitiveDiff(p: Plan): string | null {
  return builderDiff(p).find(sensitivePath) ?? null;
}
