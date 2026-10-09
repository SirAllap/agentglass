/*
 * "Check on base": the same failing test run on the base branch's tip and on
 * the pull request's head, a few times each. The result is FACTS — counts of
 * what happened on each side — never a word like "yours" or "not yours": the
 * experiment shows what ran here, and a reader draws the conclusion.
 *
 * What counts as a run that did not run: a missing tool, a missing module, a
 * service that is not there, a timeout. Those say nothing about the test, so
 * they are never counted as a pass or as a failure.
 */

export type RunOutcome = "pass" | "fail" | "unrunnable";

/** One run of the command in one tree. `line` is the line that explains an unrunnable run. */
export interface RunRecord {
  outcome: RunOutcome;
  line?: string;
}

/** "bwrap": no network, only the export visible. "none": the command runs with this user's rights. */
export type Sandbox = "bwrap" | "none";

/** What one side (base or head) came to. */
export interface SideTally {
  runs: number;
  passed: number;
  failed: number;
  unrunnable: number;
  /** The first line that explains an unrunnable run. */
  line?: string;
}

/** Runs per side, and the longest one run may take. The server enforces both; the page states them. */
export const CHECK_RUNS = 3;
export const CHECK_RUN_TIMEOUT_S = 120;
export const CHECK_COMMAND_MAX = 1000;

/** The lines that say the environment, not the test, is what stopped the command. */
const ENV_LINE = /command not found|No such file or directory|No module named|ModuleNotFoundError|Cannot find (module|package)|ECONNREFUSED|ENOTFOUND|Connection refused|could not connect|Temporary failure in name resolution|Name or service not known|Cannot connect to the Docker daemon|docker: |Permission denied|EACCES/i;

const cut = (s: string) => s.trim().replace(/\s+/g, " ").slice(0, 160);

/** The first line of an output that names an environment problem, or "". */
export function envLine(output: string): string {
  for (const l of output.split("\n")) if (ENV_LINE.test(l)) return cut(l);
  return "";
}

/**
 * One run's outcome from how it ended. Exit 0 is a pass. A non-zero exit whose
 * output names a missing tool or service, or the shell's "not found" / "not
 * executable" (127/126), or a timeout, is unrunnable. Everything else that
 * exited non-zero is a failure — the test ran and said no.
 */
export function classifyRun(exit: number | null, output: string, timedOutS?: number): Pick<RunRecord, "outcome" | "line"> {
  if (timedOutS != null) return { outcome: "unrunnable", line: `timed out after ${timedOutS}s` };
  if (exit === 0) return { outcome: "pass" };
  const line = envLine(output);
  if (line) return { outcome: "unrunnable", line };
  if (exit === 127 || exit === 126) return { outcome: "unrunnable", line: exit === 127 ? "command not found (exit 127)" : "command not executable (exit 126)" };
  return { outcome: "fail" };
}

export function tally(runs: RunRecord[]): SideTally {
  const t: SideTally = { runs: runs.length, passed: 0, failed: 0, unrunnable: 0 };
  for (const r of runs) {
    if (r.outcome === "pass") t.passed++;
    else if (r.outcome === "fail") t.failed++;
    else { t.unrunnable++; t.line ??= r.line; }
  }
  return t;
}

const none = (t: SideTally) => t.passed + t.failed === 0;

/** "passed 3/3", "passed 1/3, failed 2/3", plus "1 could not run" when some runs did not. */
function phrase(t: SideTally): string {
  const parts: string[] = [];
  if (t.passed) parts.push(`passed ${t.passed}/${t.runs}`);
  if (t.failed) parts.push(`failed ${t.failed}/${t.runs}`);
  if (t.unrunnable) parts.push(`${t.unrunnable} could not run`);
  return parts.join(", ");
}

/**
 * The card's one line. Facts, in this order of care: nothing ran anywhere;
 * nothing ran on one side; the same failure on both sides; the plain pair.
 */
export function factsLine(base: SideTally, head: SideTally): string {
  if (none(base) && none(head)) return `could not run here${base.line || head.line ? ` (${base.line || head.line})` : ""}`;
  if (none(base)) return `could not run on base${base.line ? ` (${base.line})` : ""}; ${phrase(head)} on head`;
  if (none(head)) return `${phrase(base)} on base; could not run on head${head.line ? ` (${head.line})` : ""}`;
  if (base.failed > 0 && head.failed > 0) return `${phrase(head)} on head; failed on base too (${base.failed}/${base.runs})`;
  return `${phrase(base)} on base, ${phrase(head)} on head`;
}

const RUNNERS = /^(pytest|python3?|bun|npm|pnpm|yarn|npx|make|go|cargo|uv|tox|node|deno|dotnet|mvn|gradle|bundle|rspec|phpunit|\.\/)/;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command to put in the confirm box, from what the card knows: a step whose
 * name IS a command, or a pytest node id. Anything else is left empty — the
 * log's own `Run …` line is not kept, so a guess would be a guess. The person
 * edits it, and the page remembers what they settled on.
 */
export function suggestCommand(f: { kind: string; title: string }): string {
  const title = f.title.trim();
  if (!title || title.length > CHECK_COMMAND_MAX) return "";
  if (f.kind === "step" || f.kind === "annotation") return RUNNERS.test(title) ? title : "";
  if (f.kind === "pytest" && /^[\w./-]+\.py(::|$)/.test(title)) return `python3 -m pytest ${shellQuote(title)}`;
  return "";
}

/** Why a command is refused before anything runs; "" when it may run. */
export function commandProblem(cmd: unknown): string {
  if (typeof cmd !== "string" || !cmd.trim()) return "write the command to run";
  if (cmd.length > CHECK_COMMAND_MAX) return `the command is longer than ${CHECK_COMMAND_MAX} characters`;
  if (cmd.includes("\0")) return "the command holds a NUL byte";
  return "";
}

/** What the plan endpoint says before anything runs: which two commits, and whether they are here. */
export interface CheckOnBasePlan {
  ok: true;
  base: { ref: string; sha: string; local: boolean };
  /** The PR's head commit, not the merge commit CI built: that ref is not local. */
  head: { sha: string; local: boolean };
  sandbox: Sandbox;
  runs: number;
  timeoutS: number;
}

export type CheckOnBaseStatus =
  | { ok: true; state: "running"; done: number; total: number }
  | { ok: true; state: "done"; result: CheckOnBaseResult }
  | { ok: false; error: string };

export interface CheckOnBaseResult {
  base: { ref: string; sha: string; tally: SideTally };
  head: { sha: string; tally: SideTally };
  sandbox: Sandbox;
  facts: string;
  cancelled?: boolean;
}

/** Why the plan cannot run, in words; "" when it can. */
export function planBlock(p: CheckOnBasePlan): string {
  if (!p.base.local) return `the base commit is not local (${p.base.sha.slice(0, 7)} on ${p.base.ref})`;
  if (!p.head.local) return `the head commit is not local (${p.head.sha.slice(0, 7)})`;
  return "";
}
