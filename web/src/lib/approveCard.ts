/*
 * What the approve card says about one request: how much it needs a second look,
 * a plain-English line, what it lets the agent do, and the before/after rows its
 * diff carries.
 *
 * Keyed by setting id, with `*` standing for one or more dotted segments, the
 * same way shared/settingClass.ts names a family. A setting nobody wrote a row
 * for is medium risk, keeps the raw key as its title, and gets no "In short" and
 * no "This lets the agent": the card shows the change rather than inventing a
 * sentence about it.
 *
 * Ceiling: these are the families this app asks about today. A new setting is a
 * row here, and until then it reads as medium, which is the honest default for a
 * change nobody has described yet.
 */

export type Risk = "low" | "medium" | "high";

export interface ApproveRow {
  risk: Risk;
  /** The setting in plain words. */
  title: string;
  /** One sentence: what changes, in the person's terms. */
  short: string;
  /** What the agent may now do, one line each. */
  allows: readonly string[];
}

export const RISK_LABEL: Readonly<Record<Risk, string>> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

const row = (risk: Risk, title: string, short: string, allows: readonly string[]): ApproveRow =>
  ({ risk, title, short, allows });

export const APPROVE_ROWS: Readonly<Record<string, ApproveRow>> = {
  // ── reaches the machine, or turns off a guard ──
  "launch.mode": row("high", "The permission mode every agent the app starts runs in",
    "Every agent this app starts runs in this mode. A looser mode asks fewer questions before it acts.",
    ["Act with fewer questions in every terminal the app starts"]),
  "launch.flags.*": row("high", "The flags an engine starts with in one permission mode",
    "These flags are typed into every agent of that engine that starts in that mode.",
    ["Start every agent of that engine with these flags"]),
  "launch.deny": row("high", "Tools every launched agent is denied",
    "A shorter list denies less: a tool that was blocked can run again.",
    ["Use a tool the list no longer denies"]),
  "hooks.gate": row("high", "The gate that holds a tool call until you decide",
    "With the gate off, a tool call it would have held runs at once, with nobody asked.",
    ["Run tool calls the gate used to hold for you"]),
  "secrets.keyring": row("high", "Where stored tokens live: the system keyring or plain files",
    "Turning the keyring off writes every stored token back into plain files on this machine.",
    ["Read tokens from plain files on this machine"]),
  "agents.changeWithoutAsking": row("high", "Whether agents are asked at all",
    "With this on, an agent's widening change applies without a card like this one.",
    ["Change these settings without asking you"]),
  "browser.workers": row("high", "Which engines and roles may drive the built-in browser",
    "The browser is signed in to the sites you use. This names who may drive it.",
    ["Drive the signed-in browser from a worker"]),
  "plugin.*.unboxed": row("high", "A plugin running outside its box",
    "Outside its box a plugin is no longer held to the files and commands its manifest declares.",
    ["Run outside the box its manifest declares"]),
  "cleanup.config": row("high", "What cleaning up after a merged pull request may remove",
    "A wider list removes more from this machine after a pull request merges. Nothing brings it back.",
    ["Remove the containers, databases and folders listed"]),
  "flightPlan.builder.permissions": row("high", "The permission mode a launched builder starts in",
    "A looser mode asks the builder fewer questions before it acts.",
    ["Act with fewer questions in every launched builder"]),

  // ── spends, or widens a limit ──
  "plugins.master": row("medium", "The switch every plugin runs under",
    "With plugins on, each enabled plugin runs with what its manifest declares.",
    ["Run every enabled plugin"]),
  "plugin.*.enabled": row("medium", "A plugin running",
    "The plugin runs with the files and commands its manifest declares.",
    ["Run this plugin"]),
  "orchestration.policy": row("medium", "Which engine and model every worker runs on, and what it may touch",
    "This decides the engine and model behind every worker, and the envelope it runs in: write, network, commit, docker and what it is denied.",
    ["Run on the engines and models listed", "Touch what the envelope allows: network, commit, docker"]),
  "agents.role.*": row("medium", "The engine and model one worker role starts with",
    "Every worker of this role starts on that engine and model, and spends what it costs.",
    ["Start this role on that engine and model"]),
  "orchestration.review.*": row("medium", "How much the Builder and Reviewer loop does by itself",
    "A higher answer hands the chair the diff and the test log; each round and each second review spends tokens.",
    ["Read the diff and the test log, and run more rounds"]),
  "seat.*": row("medium", "The chair: its engine, model, powers and wakes",
    "The chair spends its model's tokens on every wake, and what it may do to other agents changes with its powers.",
    ["Wake the chair, and let it speak to, nudge or assign other agents"]),
  "budgets": row("medium", "The spending limits",
    "Raising or removing a limit lets agents spend more before they stop.",
    ["Spend past the limit that was there"]),
  "flightPlan.*": row("medium", "Flight plan: its budgets, limits and preflights",
    "An author agent and each Preflight spend tokens; a higher budget or more flying builders spends faster.",
    ["Write, review and launch plans up to the limits listed"]),
  "cleanup.*": row("medium", "When leftovers of a merged pull request are removed",
    "A looser mode or a shorter wait removes them sooner, by itself.",
    ["Remove leftovers without being asked each time"]),
  "polaris.*": row("medium", "What Polaris may do on pull requests",
    "Its doors read and draft on pull requests with the person's account.",
    ["Read and draft on pull requests at the position listed"]),
  "gate.onTimeout": row("low", "What a held action does when nobody answers",
    "Either way the held action is dropped; asking again only repeats the notice inside the same wait.",
    ["Ask again before dropping it"]),
  "flightPlan.held": row("low", "Hold a project's flight plans",
    "A held project gets no new Go and launches nothing until the person resumes it.",
    ["Hold the project's plans, which only you can release"]),

  // ── reads, and nothing else ──
  "plugins.sessionReads.repos": row("low", "The repos whose session text review plugins may read",
    "Review plugins will be able to read the session text of these repos. Nothing is written or sent out.",
    ["Read the session text of the repos listed above"]),
};

/** The row for a setting: its own, else the first family that covers it. */
export function approveRow(setting: string): ApproveRow | null {
  if (Object.prototype.hasOwnProperty.call(APPROVE_ROWS, setting)) return APPROVE_ROWS[setting]!;
  for (const [k, r] of Object.entries(APPROVE_ROWS)) {
    const star = k.indexOf("*");
    if (star < 0) continue;
    const head = k.slice(0, star);
    const tail = k.slice(star + 1);
    if (setting.length > head.length + tail.length && setting.startsWith(head) && setting.endsWith(tail)) return r;
  }
  return null;
}

/** A setting nobody described is medium: not proven safe, and not proven to reach the machine. */
export const riskOf = (setting: string): Risk => approveRow(setting)?.risk ?? "medium";

const RANK: Readonly<Record<Risk, number>> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (a: Risk, b: Risk): Risk => (RANK[a] >= RANK[b] ? a : b);

/** The powers a worker's envelope lifts, and how much each one needs a second look. */
export const LIFT_RISK: Readonly<Record<string, Risk>> = { docker: "high", network: "high", commit: "medium" };

/**
 * The card's risk: the setting's own, raised by any power a change turns on. A
 * policy is one setting, but lifting docker inside it is not a medium change, and
 * the diff says so leaf by leaf (`workers.builder.envelope.docker: false -> true`).
 */
export function riskOfChanges(setting: string, changes: readonly Change[]): Risk {
  let risk = riskOf(setting);
  for (const c of changes) {
    const leaf = (c.name.split(".").pop() ?? "").replace(/\[\d+\]$/, "");
    const lift = LIFT_RISK[leaf];
    if (lift && c.after === "true") risk = maxRisk(risk, lift);
  }
  return risk;
}

/** Approve answers only what the person has read: a high-risk card waits for the tick. */
export const approveReady = (risk: Risk, acked: boolean, busy: boolean): boolean =>
  !busy && (risk !== "high" || acked);

/** One row of a request's diff: the leaves the server computed, as it wrote them. */
export interface Change {
  /** The path inside the setting, or the setting's own label for a single scalar. */
  name: string;
  before: string;
  after: string;
  /** Long enough that the card clamps it and offers the whole value. */
  long: boolean;
}

/** The arrow that separates the two values, outside any JSON string. */
function splitArrow(line: string): [string, string] | null {
  let quoted = false;
  for (let i = 0; i + 4 <= line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") quoted = !quoted;
    if (!quoted && line.startsWith(" -> ", i)) return [line.slice(0, i), line.slice(i + 4)];
  }
  return null;
}

const LONG_ENOUGH = 60;

/**
 * The request's diff as the card draws it: `diff[0]` is the setting's label, and
 * each line after it is `path: old -> new`. A line without an arrow is the
 * server's own note (a plugin's declared permissions), which is shown as it is.
 */
export function changesOf(diff: readonly string[]): { changes: Change[]; notes: string[] } {
  const changes: Change[] = [];
  const notes: string[] = [];
  for (const line of diff.slice(1)) {
    const parts = splitArrow(line);
    if (!parts) { notes.push(line); continue; }
    const colon = parts[0].indexOf(": ");
    const name = colon > 0 ? parts[0].slice(0, colon) : parts[0];
    const before = colon > 0 ? parts[0].slice(colon + 2) : parts[0];
    changes.push({ name, before, after: parts[1], long: before.length + parts[1].length > LONG_ENOUGH });
  }
  return { changes, notes };
}

/** A value as the text it carries: a JSON string is shown as its lines, anything else as it is. */
function textOf(v: string): string {
  try {
    const parsed: unknown = JSON.parse(v);
    return typeof parsed === "string" ? parsed : v;
  } catch {
    return v;
  }
}

export interface DiffLine { kind: "same" | "del" | "add"; text: string }

/** A small line diff of two values, so "Show full" shows what moved rather than both walls of text. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = textOf(before).split("\n");
  const b = textOf(after).split("\n");
  // LCS, so a line that stayed put is context rather than a delete plus an add.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: "del", text: a[i]! }); i++; }
    else { out.push({ kind: "add", text: b[j]! }); j++; }
  }
  for (; i < a.length; i++) out.push({ kind: "del", text: a[i]! });
  for (; j < b.length; j++) out.push({ kind: "add", text: b[j]! });
  return out;
}

/** How much of the wait is left, and the minutes the footer names. */
export function timeLeft(r: { at: number; expires: number }, now: number): { fraction: number; minutes: number } {
  const total = Math.max(1, r.expires - r.at);
  const left = Math.max(0, r.expires - now);
  return { fraction: Math.min(1, left / total), minutes: Math.ceil(left / 60_000) };
}
