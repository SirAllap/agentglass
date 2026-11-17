/*
 * Preflight runs and the Flight plan settings, as stored: the server's own
 * database, never the repository. A run is one request to review something with
 * a reader that has no context (preflight.ts), the moment it was asked at, who
 * asked, where it stands, and the certificate once it is done.
 */
import { randomBytes } from "node:crypto";
import { db, durably } from "./db.ts";
import type { Certificate, FindingAction, PreflightInput } from "./preflight.ts";
import { SWITCHABLE_COMMANDS } from "../../shared/workerRoles.ts";
import { mcpModesOf, type McpMode } from "../../shared/mcpReadonly.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS preflight_run (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  root TEXT NOT NULL,
  moment TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  input TEXT NOT NULL,
  certificate TEXT,
  error TEXT,
  task_id TEXT
);
CREATE INDEX IF NOT EXISTS preflight_run_root ON preflight_run (root, created_at);
CREATE TABLE IF NOT EXISTS flight_plan_setting (
  root TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (root, key)
);
`);
try { db.exec(`ALTER TABLE preflight_run ADD COLUMN spent_usd REAL`); } catch { /* already there */ }
/* The budget sums what every run of the week cost, on each plan list. A run's input and certificate are big
   (the plan text, the findings), and reading a column past them walks their overflow pages: ~45 ms for 300 runs.
   This index holds exactly the values the sum reads, so it never opens the row. New and additive: an older build ignores it. */
db.run(`CREATE INDEX IF NOT EXISTS preflight_run_cost ON preflight_run (created_at, state, spent_usd, json_extract(certificate, '$.costUsd'), json_extract(input, '$.budgetUsd'))`);
/* A run that was executing when the server stopped will never finish; what it spent is unknown, so it is billed at its cap. */
db.run(`UPDATE preflight_run SET state = 'failed', error = 'the server restarted while it ran', spent_usd = json_extract(input, '$.budgetUsd') WHERE state = 'running'`);

export const MOMENTS = ["before-launch", "before-merge", "task-done", "pr", "manual"] as const;
export type Moment = (typeof MOMENTS)[number];
export type RunState = "awaiting-go" | "running" | "done" | "failed" | "declined";
export const ACTIONS: readonly FindingAction[] = ["fix", "contest", "ask", "dismiss"];

export interface Run {
  id: string; createdAt: number; root: string; moment: Moment; state: RunState; requestedBy: string;
  input: PreflightInput; certificate: Certificate | null; error: string | null; taskId: string | null;
}
interface Row { id: string; created_at: number; root: string; moment: string; state: string; requested_by: string; input: string; certificate: string | null; error: string | null; task_id: string | null }

const toRun = (r: Row): Run => ({
  id: r.id, createdAt: r.created_at, root: r.root, moment: r.moment as Moment, state: r.state as RunState, requestedBy: r.requested_by,
  input: JSON.parse(r.input), certificate: r.certificate ? JSON.parse(r.certificate) : null, error: r.error, taskId: r.task_id,
});

export function createRun(p: { root: string; moment: Moment; state: "awaiting-go" | "running"; by: string; input: PreflightInput; taskId?: string | null }): Run {
  const id = `pf_${randomBytes(8).toString("hex")}`;
  db.query(`INSERT INTO preflight_run (id, created_at, root, moment, state, requested_by, input, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, Date.now(), p.root, p.moment, p.state, p.by, JSON.stringify({ ...p.input, id }), p.taskId ?? null);
  return getRun(id)!;
}
/** The findings of a finished run, [] for any other state or none: the plan list's stop reasons read only this, not the run's input (the plan text) it would parse with `getRun`. */
export const doneFindings = (id: string): NonNullable<Run["certificate"]>["findings"] => {
  const r = db.query<{ state: string; f: string | null }, [string]>(`SELECT state, json_extract(certificate, '$.findings') AS f FROM preflight_run WHERE id = ?`).get(id);
  return r?.state === "done" && r.f ? JSON.parse(r.f) : [];
};
export const getRun = (id: string): Run | null => { const r = db.query<Row, [string]>(`SELECT * FROM preflight_run WHERE id = ?`).get(id); return r ? toRun(r) : null; };
export function listRuns(f: { state?: string; root?: string } = {}): Run[] {
  const rows = db.query<Row, [string | null, string | null, string | null, string | null]>(
    `SELECT * FROM preflight_run WHERE (? IS NULL OR state = ?) AND (? IS NULL OR root = ?) ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  ).all(f.state ?? null, f.state ?? null, f.root ?? null, f.root ?? null);
  return rows.map(toRun);
}

/** Moves a run only from `from`; false when it was not in that state. */
export function setState(id: string, from: RunState, to: RunState): boolean {
  return db.query(`UPDATE preflight_run SET state = ? WHERE id = ? AND state = ?`).run(to, id, from).changes > 0;
}
export function finish(id: string, cert: Certificate): void {
  db.query(`UPDATE preflight_run SET state = 'done', certificate = ?, error = NULL WHERE id = ?`).run(JSON.stringify(cert), id);
}
/** `spentUsd`: what the failed run cost, when it is known; the budget counts it. */
export function fail(id: string, error: string, spentUsd?: number): void {
  db.query(`UPDATE preflight_run SET state = 'failed', error = ?, spent_usd = ? WHERE id = ?`).run(String(error).slice(0, 500), Number.isFinite(spentUsd) ? spentUsd! : null, id);
}

export function setFindingAction(runId: string, findingId: string, action: FindingAction | null, note: string | null, by: string, bySeat = false):
{ ok: true; run: Run } | { ok: false; error: string; status: number } {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "no such run", status: 404 };
  const f = run.certificate?.findings.find((x) => x.id === findingId);
  if (!run.certificate || !f) return { ok: false, error: "no such finding in that run", status: 404 };
  if (action !== null && !ACTIONS.includes(action)) return { ok: false, error: "action: fix, contest, ask, dismiss or null", status: 400 };
  // What lifts a stop is the person's. A coordinator answers findings (that is Autopilot), but it cannot take an Ask away or dismiss a blocker.
  if (bySeat && f.action === "ask" && action !== "ask") return { ok: false, error: "an Ask finding is the person's to change: the coordinator raised it, it cannot take it back", status: 403 };
  if (bySeat && action === "dismiss" && f.severity === "blocker") return { ok: false, error: "a coordinator does not dismiss a blocker: fix it, contest it with the evidence, or ask the person", status: 403 };
  const text = String(note ?? "").trim().slice(0, 2000);
  if ((action === "contest" || action === "dismiss") && !text) return { ok: false, error: `${action} needs a note saying why`, status: 400 };
  f.action = action; f.note = text || null;
  if (action) f.by = by; else delete f.by;
  db.query(`UPDATE preflight_run SET certificate = ? WHERE id = ?`).run(JSON.stringify(run.certificate), runId);
  return { ok: true, run: getRun(runId)! };
}

/**
 * Where a task's review stands, from its run. Declined is a review that never happened, so it reads as failed.
 * Advisory: the number of findings still open (blocker or major, unanswered or "ask") is a note beside the
 * status, never a status of its own, and nothing refuses or waits because of it.
 */
export type PreflightStatus = "pending" | "checked" | "failed";
export function flagOf(run: Run): { status: PreflightStatus; openFindings: number } {
  if (run.state === "failed" || run.state === "declined") return { status: "failed", openFindings: 0 };
  if (run.state !== "done" || !run.certificate) return { status: "pending", openFindings: 0 };
  const openFindings = run.certificate.findings.filter((f) => (f.severity === "blocker" || f.severity === "major") && (f.action === null || f.action === "ask")).length;
  return { status: "checked", openFindings };
}

/* ── per-project settings ── */
/** The three things a Preflight can review. `plan` is the plan before Go, `taskDone` a finished task, `pr` a pull request. */
export const REVIEWS = ["plan", "taskDone", "pr"] as const;
export type Review = (typeof REVIEWS)[number];
/** Which Review a run's moment asks for. `manual` is the person pressing Run, and always runs. */
export const REVIEW_OF: Record<string, Review | undefined> = { "before-launch": "plan", "task-done": "taskDone", pr: "pr" };
export const PILOT_VALUES = ["manual", "copilot", "autopilot"] as const;

export const DEFAULTS = {
  /* The first run: whether it is finished, whether a run is open, which tutorial
     cards were read, and the agent a first terminal starts. One value for the
     app (under APP), because they answer before any project is open. */
  "setup.done": false,
  "setup.inProgress": false,
  "setup.tutorial": "",
  "setup.agent": "claude",
  "flightPlan.pilot": "copilot",
  // Per project: a project the person left out of Flight plan. Unset means in.
  "flightPlan.project.enabled": true,
  "flightPlan.preflight.reviews": ["plan"] as string[],
  "flightPlan.preflight.sizes": "ML",
  "flightPlan.preflight.secondLooks": 1,
  "flightPlan.preflight.costCapUsd": 0.5,
  // Bytes a file named with no line goes whole up to; past it, only its head, with a notice naming the cut. 0 = no cap: always whole.
  "flightPlan.preflight.fileCapBytes": 0,
  // Not per project: the master switch, the house mockup guide, the budget are one value for the app, kept under the root "*".
  "flightPlan.enabled": false,
  "flightPlan.mockupGuide": "",
  "flightPlan.budget.dailyUsd": 5,
  "flightPlan.budget.weeklyUsd": 20,
  // A raise the person agreed to from the strip: the cap in force until `until`, then the base cap again. 0/0 is no raise.
  "flightPlan.budget.dailyRaiseUsd": 0,
  "flightPlan.budget.dailyRaiseUntil": 0,
  "flightPlan.budget.weeklyRaiseUsd": 0,
  "flightPlan.budget.weeklyRaiseUntil": 0,
  "flightPlan.maxFlying": 2,
  // Per project, falling back to the app value (then true): one project may stop asking while another keeps asking.
  "flightPlan.autopilot.askOnLarge": true,
  "flightPlan.autopilot.askOnSensitive": true,
  // Per project, never inherited from the app: a hold on one project does not stop another.
  "flightPlan.held": false,
  // The permission mode a launched builder starts in: one value for the app. Auto, because bypass is the person's to turn on.
  "flightPlan.builder.permissions": "auto",
  // The model a sensitive or L plan's builder starts on: one value for the app. Any other plan launches on the builder role's model.
  "flightPlan.builder.strongModel": "opus",
  // Where a builder worktree is cut from: the local trunk (local), or origin/<trunk> (remote). Local, because a project whose merges stay local runs far ahead of its remote.
  "flightPlan.builderBase": "local",
  // Per project: the flow's blocks own their jobs, so the seat may not spawn a Claude subagent for one.
  "flow.delegationGuard": true,
  // Per project: the post-merge cleanup's settings (cleanup.ts CleanupConfig) as JSON text; empty is "nothing configured".
  "cleanup.config": "",
  // Per project: what happens when a pull request ends (off | ask | atMerge | auto), the age in days after which a merged one is cleaned by itself (0 = never), and which kinds of leftover a plan holds.
  "cleanup.mode": "ask",
  "cleanup.autoCleanDays": 0,
  // Per project: the orphan sweep (dockerorphans.ts) removes what it lists by itself; off, and turning it on waits for the person.
  "cleanup.orphanAutoRemove": false,
  "cleanup.include": ["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch"] as string[],
  // Per project: folders that hold a card's evidence folder (`<root>/ORBIT-1042-...`); empty finds nothing.
  "cleanup.evidenceRoots": [] as string[],
  // Per project: patterns (`~/code/orbit-pol-master-{number}*`) for a card's leftovers that do not start with its id; empty finds nothing.
  "cleanup.otherFolders": [] as string[],
  // Per project: a merge's cleanup plan also moves the card to a status of the
  // project's own choosing (through the same move door session start uses).
  // Off, and the status is unset, until the person picks one.
  "cleanup.moveCard": false,
  "cleanup.moveCardStatus": "",
  // Per project, never inherited from the app (agentTrust.ts): a project with no row of its own is off.
  "agents.changeWithoutAsking": false,
  // Per project: the project's seat may edit its own flow and roster. Off unless the person turns it on here.
  "flow.agentEdit": false,
  // Per project: the flow's Session start step moves the card to a status of
  // the project's own choosing (through the move door), so it does not sit in
  // Backlog while its worker runs. Off, and the status is unset, until the
  // person picks one.
  "flow.sessionStart.move": false,
  "flow.sessionStart.moveStatus": "",
  // Per project: a worker's end, with no trailing question, starts the next
  // role on the flow's path in the same tab. Off until the person turns it on.
  "flow.autoContinue": false,
  // Per project: a flow step is refused until the one before it has reported done. Off; the person is never held.
  "flow.enforce": false,
  // Per project: a bot review change on an open pull request is told to the
  // seat. GitHub's own bot test is the default rule; this list only adds
  // logins GitHub does not mark as a bot. Off, and the list is empty.
  "flow.notifyPrReviews": false,
  "flow.notifyPrReviews.bots": "",
  // Per project: a saved Jira filter, claimed card by card, a scout started
  // for each — off, and no filter is picked, until the person sets one.
  "flow.nextCard.enabled": false,
  "flow.nextCard.filterId": "",
  "flow.nextCard.cap": 2,
  // Per project: who reads code and runs tests (never | second | is), the Builder-to-Reviewer round cap, and a second
  // reviewer as JSON (`{"engine":"...","model":"..."}`) or empty for off. The defaults are how the app already worked.
  "orchestration.review.who": "second",
  "orchestration.review.rounds": 3,
  "orchestration.review.second": "",
  // Per project: the person's own presets, as JSON text: a list of `.agxpreset` files (shared/preset.ts). Empty is none.
  "orchestration.presets": "",
  // One value for the app: the permission mode a worker role's own turn starts in
  // (dontAsk or bypassPermissions — never a mode that can ask, since nobody sits
  // at that pane). Empty means "not set": workerPermissionMode() below then
  // follows flightPlan.builder.permissions instead of a bare default.
  "agents.permissionMode": "",
  // Per project: the Claude Code config directory (account) its agents start with. Empty is the CLI's own default. See claudeAccount.ts.
  "workers.claudeConfigDir": "",
  // Per project: which Unix sockets a worker's sandbox may reach (off | all). Off is what the sandbox always did.
  "workers.unixSockets": "off",
  // Per project: whether a worker's shell may run one of this app's own doors, which the lock denies it by default.
  // Per project: whether a sandboxed worker may write the git paths that run code on the next git command (hooks, config, modules).
  "workers.gitInternals": false,
  "workers.appDoors.agentglass-agent": false,
  "workers.appDoors.agentglass-ui": false,
  "workers.appDoors.agentglass-cockpit-mcp": false,
  "workers.commands.ssh": true,
  "workers.commands.scp": true,
  "workers.commands.rm": true,
  "workers.commands.kill": true,
  "workers.commands.pkill": true,
  "workers.commands.killall": true,
  "workers.commands.killall5": true,
  "workers.commands.xkill": true,
  "workers.commands.git-push": true,
  "workers.commands.gh": true,
  "workers.commands.curl": true,
  "workers.commands.wget": true,
  "workers.commands.aws": true,
  "workers.commands.docker": true,
  "workers.commands.git-rebase": true,
  "workers.commands.git-stash": true,
  "workers.commands.git-tag": true,
  "workers.commands.git-remote": true,
  // One value for the app: whether a worker role's turn loads the checkout's
  // own `.claude/skills` (and, with them, its hooks, MCP servers and
  // `permissions.allow` — one CLI switch for all of it). On by default:
  // project skills are text from the project's own tree.
  "workers.projectSkills": true,
  // One value for the app: which of the person's configured MCP servers
  // (`~/.claude.json`) a worker turn is given, and whether each one is
  // read-only or may write. Empty is none — an escalation the person
  // switches on per server, not an all-on default.
  "workers.mcpServers": {} as Record<string, "readOnly" | "all">,
  // Per project: the built-in scout may write its own worktree and
  // `.agx-tmp` instead of only answering in its last message. Off by
  // default, as a scout always ran.
  "workers.plannerWrite": false,
  // Per project: no worker of any role runs on Claude. A role whose engine is
  // Claude starts on the project's other engine instead, or is refused when
  // none is ready. Off by default.
  "workers.noClaude": false,
  "workers.unwalledEngines": false,
} as const;
export type SettingKey = keyof typeof DEFAULTS;

/**
 * The mode a worker role's headless turn starts in: the person's own choice
 * here, else bypass when they already turned that on for Flight plan's
 * builder (the same population: a worker nobody sits in front of), else
 * `dontAsk`, the mode that has always shipped.
 */
export function workerPermissionMode(root?: string | null): "dontAsk" | "bypassPermissions" {
  // Per project, like the page that shows it: a project's own value, else the app-wide one (PER_PROJECT).
  const own = getSetting(root || APP, "agents.permissionMode");
  if (own === "dontAsk" || own === "bypassPermissions") return own;
  return getSetting(APP, "flightPlan.builder.permissions") === "bypassPermissions" ? "bypassPermissions" : "dontAsk";
}
/** The app doors (`WORKER_DENIED`, the browser aside) this project has opened to its workers' shells; none by default. */
export const APP_DOORS = ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"] as const;
export function workerOpenDoors(root?: string | null): string[] {
  return APP_DOORS.filter((d) => getSetting(root || APP, `workers.appDoors.${d}` as SettingKey) === true);
}

/** The switchable commands this project stored as open on purpose: an engine that keeps the old floor opens only these. */
export function workerLegacyOpened(root?: string | null): string[] {
  const at = root || APP;
  return SWITCHABLE_COMMANDS.filter((c) => { const k = `workers.commands.${c.replace(/ /g, "-")}` as SettingKey; return hasSetting(at, k) && getSetting(at, k) === true; });
}
/**
 * The switchable commands (`SWITCHABLE_COMMANDS`) this project has closed to every worker's shell, by name; none
 * by default, because a worker does what its seat does. Closing one adds its prefix to the lock's deny list.
 */
export function workerClosedCommands(root?: string | null): string[] {
  return SWITCHABLE_COMMANDS.filter((c) => getSetting(root || APP, `workers.commands.${c.replace(/ /g, "-")}` as SettingKey) === false);
}

/** Whether this project lets a worker's shell write the git paths that run code (hooks, config, modules); off by default. */
export function workerGitInternals(root?: string | null): boolean {
  return getSetting(root || APP, "workers.gitInternals") === true;
}

/** Whether an engine with no read wall (Hermes) may run as a worker; off by default. */
export function workerUnwalledEngines(root?: string | null): boolean {
  return getSetting(root || APP, "workers.unwalledEngines") === true;
}

/** Which Unix sockets a worker's shell may reach: none (the default) or any. There is no middle: see `socketKeys`. */
export type UnixSockets = "off" | "all";
export const UNIX_SOCKETS: readonly UnixSockets[] = ["off", "all"];
export function workerUnixSockets(root?: string | null): UnixSockets {
  const v = getSetting(root || APP, "workers.unixSockets");
  return (UNIX_SOCKETS as readonly unknown[]).includes(v) ? (v as UnixSockets) : "off";
}

/** Whether no worker may run on Claude in this project (`workers.noClaude`, PER_PROJECT). */
export function workerNoClaude(root?: string | null): boolean {
  return getSetting(root || APP, "workers.noClaude") === true;
}

/** Whether a worker role's turn loads the checkout's own `.claude/skills` (`workers.projectSkills`), per project (PER_PROJECT). */
export function workerProjectSkills(root?: string | null): boolean {
  return getSetting(root || APP, "workers.projectSkills") !== false;
}

/** The modes `workers.mcpServers` has switched on for this project
 *  (PER_PROJECT), by server name, for the caller to resolve against what is
 *  really configured (`workerMcp.ts` `chosenMcpServers`). Reads an
 *  old-shaped stored value (a plain list, from before per-server modes) the
 *  same way `mcpModesOf` does: each named server at "all", exactly what that
 *  project already had. */
export function workerMcpModes(root?: string | null): Record<string, McpMode> {
  return mcpModesOf(getSetting(root || APP, "workers.mcpServers"));
}

/** `AGENTGLASS_PLANNER_WRITE`, when it holds "0" or "1": the variable and the
 *  value the row is locked to, for the page to say so (same shape as
 *  `scopes.ts` `memoryMaxEnv`). */
export function plannerWriteEnv(env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | null {
  const v = env.AGENTGLASS_PLANNER_WRITE;
  return v === "0" || v === "1" ? { name: "AGENTGLASS_PLANNER_WRITE", value: v } : null;
}

/** Whether this project's built-in scout may write its own worktree and
 *  `.agx-tmp` (`workers.plannerWrite`, PER_PROJECT); off by default, same as
 *  a scout always ran. The environment variable, when set to "0" or "1",
 *  wins over every project's stored value and locks the row. */
export function plannerMayWrite(root?: string | null): boolean {
  const e = plannerWriteEnv();
  if (e) return e.value === "1";
  return getSetting(root || APP, "workers.plannerWrite") === true;
}
type Value = string | number | boolean | string[] | Record<string, string>;
const rootKey = (root: string) => root.replace(/\/+$/, "") || "/";

export const APP = "*";
const rowAt = (root: string, key: string) =>
  db.query<{ value: string }, [string, string]>(`SELECT value FROM flight_plan_setting WHERE root = ? AND key = ?`).get(rootKey(root), key);
/** Every distinct non-empty string any project (or the app) stored at this key. */
export function storedValues(key: SettingKey): string[] {
  const out = new Set<string>();
  for (const r of db.query<{ value: string }, [string]>(`SELECT value FROM flight_plan_setting WHERE key = ?`).all(key)) {
    try { const v = JSON.parse(r.value); if (typeof v === "string" && v) out.add(v); } catch { /* skip a bad row */ }
  }
  return [...out];
}
/** Set once for the app (under APP) and a project may differ. */
export const PER_PROJECT: readonly string[] = ["flightPlan.pilot", "flightPlan.preflight.reviews", "flightPlan.project.enabled", "flightPlan.autopilot.askOnLarge", "flightPlan.autopilot.askOnSensitive", "orchestration.review.who", "orchestration.review.rounds", "orchestration.review.second", "orchestration.presets", "agents.permissionMode", "workers.claudeConfigDir", "workers.unixSockets", "workers.gitInternals", "workers.unwalledEngines", "workers.appDoors.agentglass-agent", "workers.appDoors.agentglass-ui", "workers.appDoors.agentglass-cockpit-mcp", "workers.commands.ssh", "workers.commands.scp", "workers.commands.rm", "workers.commands.kill", "workers.commands.pkill", "workers.commands.killall", "workers.commands.killall5", "workers.commands.xkill", "workers.projectSkills", "workers.mcpServers", "workers.plannerWrite", "workers.noClaude", "flow.sessionStart.move", "flow.sessionStart.moveStatus", "flow.autoContinue", "flow.enforce", "flow.notifyPrReviews", "flow.notifyPrReviews.bots", "flow.nextCard.enabled", "flow.nextCard.filterId", "flow.nextCard.cap"];

/*
 * Before Pilot, three keys each said off / ask / auto for one moment. They are
 * not read as settings any more, but a stored one still says what the project
 * wanted: off is not reviewed, ask and auto are. A project that never set any
 * has the default (the plan is reviewed). Never deleted, so a downgrade finds them.
 */
const LEGACY_MOMENT: Record<Review, string> = { plan: "flightPlan.preflight.beforeLaunch", taskDone: "flightPlan.preflight.onTaskDone", pr: "flightPlan.preflight.onPr" };
function legacyReviews(root: string): string[] | null {
  const seen = REVIEWS.map((r) => {
    const row = rowAt(root, LEGACY_MOMENT[r]) ?? (root !== APP ? rowAt(APP, LEGACY_MOMENT[r]) : null);
    return row ? (JSON.parse(row.value) as string) : null;
  });
  return seen.every((v) => v === null) ? null : REVIEWS.filter((_, i) => seen[i] === "ask" || seen[i] === "auto");
}

/**
 * The project's own value, else the app-wide one, else the shipped default.
 * Falling straight to the shipped default made a project the screen labels
 * "default" answer "off" while the global said "ask", so its first plan could
 * not be reviewed. The global lives under APP and not under the open project:
 * keyed on a project, setting that project to Off also changed "everyone".
 */
export function getSetting(root: string, key: SettingKey): Value {
  const own = rowAt(root, key) ?? (root !== APP && PER_PROJECT.includes(key) ? rowAt(APP, key) : null);
  if (own) return JSON.parse(own.value);
  if (key === "flightPlan.preflight.reviews") return legacyReviews(root) ?? DEFAULTS[key];
  return DEFAULTS[key];
}
/** True when this project says it itself, false when the value is the default (so "off" can be told from "not set"). */
export const hasSetting = (root: string, key: SettingKey): boolean =>
  !!rowAt(root, key) || (key === "flightPlan.preflight.reviews" && legacyReviews(root) !== null);
export function putSetting(root: string, key: SettingKey, value: Value): void {
  durably(() => db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, ?, ?) ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`)
    .run(rootKey(root), key, JSON.stringify(value)));
}
/**
 * A key this app stored per project and no longer reads: the model a Preflight
 * reviews with, which is the Reviewer role's now. It is deliberately absent
 * from DEFAULTS, so no default is written down twice; only the adoption in
 * flightPlan reads it, once, and clears it.
 */
export const PREFLIGHT_MODEL_ALIAS = "flightPlan.preflight.model";
/** What the project stored at the retired key, or "" when it has none. */
export function retiredSetting(root: string, key: typeof PREFLIGHT_MODEL_ALIAS): string {
  const row = rowAt(root, key);
  return row ? String(JSON.parse(row.value)) : "";
}
/** Takes the project's value at a retired key away, so `retiredSetting` reads "". */
export function clearRetired(root: string, key: typeof PREFLIGHT_MODEL_ALIAS): void {
  db.query(`DELETE FROM flight_plan_setting WHERE root = ? AND key = ?`).run(rootKey(root), key);
}

/**
 * What Preflight runs created since `since` have cost, whatever the project: a finished run its certificate's
 * cost, a failed one what it spent (a run stopped at its cap spent the cap), and a run still reading its cap,
 * held in advance so presses made while it reads cannot spend past the budget. A run that failed before it
 * was billed counts for nothing.
 */
export const preflightCostSince = (since: number): number =>
  db.query<{ usd: number | null }, [number]>(`SELECT SUM(COALESCE(json_extract(certificate, '$.costUsd'), spent_usd, CASE WHEN state = 'running' THEN json_extract(input, '$.budgetUsd') END)) AS usd FROM preflight_run WHERE created_at >= ?`).get(since)?.usd ?? 0;

/** Who held a project and when, beside the `held` flag: the flag is a setting anyone may flip, so `by` is null when the door did it without saying who. */
export interface HeldMeta { by: string | null; at: number }
export function markHeld(root: string, held: boolean, by: string | null): void {
  if (!held) { db.query(`DELETE FROM flight_plan_setting WHERE root = ? AND key = 'flightPlan.heldMeta'`).run(rootKey(root)); return; }
  db.query(`INSERT INTO flight_plan_setting (root, key, value) VALUES (?, 'flightPlan.heldMeta', ?) ON CONFLICT (root, key) DO UPDATE SET value = excluded.value`)
    .run(rootKey(root), JSON.stringify({ by, at: Date.now() } satisfies HeldMeta));
}
export const heldMeta = (root: string): HeldMeta | null => { const r = rowAt(root, "flightPlan.heldMeta"); return r ? JSON.parse(r.value) : null; };
