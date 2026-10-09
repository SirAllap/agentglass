/*
 * The pull-request side of "Check on base": which two commits, whether they are
 * here, and the one experiment per repository that may run at a time. The
 * experiment itself, and the rule that it touches nothing in the person's git,
 * are in checkOnBase.ts.
 *
 * Two REST requests, asked when the box opens and not before: the PR (its base
 * branch's name and its head commit, fresh — the list's cached copy can be older
 * than the commit CI ran) and the base branch (its tip: the local `origin/<base>`
 * can be hours old, and a stale base is the wrong experiment, and the PR
 * object's own `base.sha` is the tip as of the PR's last update). Both must already be in the local
 * object database; if one is not, the answer is "the commit is not local" and
 * nothing is fetched.
 */
import { randomUUID } from "node:crypto";
import { CHECK_RUN_TIMEOUT_S, CHECK_RUNS, commandProblem, planBlock, tally, type CheckOnBasePlan, type CheckOnBaseResult, type CheckOnBaseStatus, type Sandbox } from "../../shared/checkOnBase.ts";
import { inScopeReal } from "./config.ts";
import { repoRootOf, safeAbs } from "./git.ts";
import { gh, repoIdFor } from "./prs.ts";
import { commitIsLocal, runCheckOnBase, sandboxKind, SHA } from "./checkOnBase.ts";

/** The one thing asked of GitHub, so a test hands it a fake instead of the network. */
export interface GhDeps {
  gh: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Test seam: what this machine can box with. */
  sandbox?: () => Sandbox;
}
const real: GhDeps = { gh: (args) => gh(args) };

type Planned = { ok: true; gitRoot: string; plan: CheckOnBasePlan } | { ok: false; error: string };

export async function planCheckOnBase(rootIn: unknown, numberIn: unknown, deps: GhDeps = real): Promise<Planned> {
  const abs = safeAbs(rootIn);
  const gitRoot = abs && repoRootOf(abs);
  if (!gitRoot) return { ok: false, error: "this pull request has no checkout on this machine" };
  // Held to the open project, as every git read that names a repository is:
  // the plan runs git in it and a start exports and runs its trees.
  if (!inScopeReal(gitRoot)) return { ok: false, error: "outside the open project" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const pr = await deps.gh(["api", `repos/${repo.nameWithOwner}/pulls/${number}`, "--jq", "{base: .base.ref, head: .head.sha}"]);
  let info: { base?: unknown; head?: unknown } = {};
  try { info = JSON.parse(pr.stdout); } catch { /* answered below */ }
  const headSha = typeof info.head === "string" ? info.head : "";
  const baseRef = typeof info.base === "string" ? info.base : "";
  if (pr.code !== 0 || !SHA.test(headSha) || !baseRef) return { ok: false, error: "could not read the pull request from GitHub" };
  const tip = await deps.gh(["api", `repos/${repo.nameWithOwner}/branches/${encodeURIComponent(baseRef)}`, "--jq", ".commit.sha"]);
  const baseSha = tip.stdout.trim();
  if (tip.code !== 0 || !SHA.test(baseSha)) return { ok: false, error: `could not read the tip of ${baseRef} on GitHub` };
  const [baseLocal, headLocal] = await Promise.all([commitIsLocal(gitRoot, baseSha), commitIsLocal(gitRoot, headSha)]);
  return {
    ok: true, gitRoot,
    plan: { ok: true, base: { ref: baseRef, sha: baseSha, local: baseLocal }, head: { sha: headSha, local: headLocal }, sandbox: deps.sandbox?.() ?? sandboxKind(), runs: CHECK_RUNS, timeoutS: CHECK_RUN_TIMEOUT_S },
  };
}

interface Job { repo: string; state: "running" | "done"; done: number; total: number; result?: CheckOnBaseResult; error?: string; ac: AbortController }
const jobs = new Map<string, Job>();
const KEEP = 20;
/** Checks running at once, across repositories: each is up to two lanes of repository code. */
const MAX_RUNNING = 2;

/** What the person saw when they pressed Run: the two commits, and whether a box held the command. */
export interface Confirmed { baseSha?: unknown; headSha?: unknown; sandbox?: unknown; allowNoSandbox?: unknown }

/**
 * Start the experiment the person confirmed, and only that one: the plan is read
 * again now, and the commits and the sandbox it finds must be the ones that were
 * shown, or nothing runs (a base branch that moved, or a box that stopped working,
 * is a reason to look again, not to run something else). A run with no sandbox
 * also needs the person's explicit say-so in the request: the warning on the page
 * is not a guard, this is. One per repository at a time.
 */
export async function startCheckOnBase(rootIn: unknown, numberIn: unknown, command: unknown, confirmed: Confirmed = {}, deps: GhDeps = real): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const problem = commandProblem(command);
  if (problem) return { ok: false, error: problem };
  const p = await planCheckOnBase(rootIn, numberIn, deps);
  if (!p.ok) return p;
  const { plan, gitRoot } = p;
  const blocked = planBlock(plan);
  if (blocked) return { ok: false, error: blocked };
  if (confirmed.baseSha !== plan.base.sha || confirmed.headSha !== plan.head.sha || confirmed.sandbox !== plan.sandbox) {
    return { ok: false, error: "the commits or the sandbox changed since you looked; open it again" };
  }
  if (plan.sandbox === "none" && confirmed.allowNoSandbox !== true) return { ok: false, error: "no sandbox is available here; running without one needs your explicit say-so" };
  let running = 0;
  for (const j of jobs.values()) {
    if (j.state !== "running") continue;
    if (j.repo === gitRoot) return { ok: false, error: "a check is already running on this repository" };
    running++;
  }
  if (running >= MAX_RUNNING) return { ok: false, error: "too many checks are running; wait for one to finish" };
  const id = randomUUID();
  const job: Job = { repo: gitRoot, state: "running", done: 0, total: plan.runs * 2, ac: new AbortController() };
  jobs.set(id, job);
  while (jobs.size > KEEP) { const old = [...jobs].find(([, j]) => j.state === "done"); if (!old) break; jobs.delete(old[0]); }
  void runCheckOnBase({
    sandbox: plan.sandbox, gitRoot, baseSha: plan.base.sha, headSha: plan.head.sha, command: command as string, signal: job.ac.signal,
    onProgress: (done, total) => { job.done = done; job.total = total; },
  }).then((r) => {
    if (!r.ok) job.error = r.error;
    else job.result = {
      base: { ref: plan.base.ref, sha: plan.base.sha, tally: tally(r.base) },
      head: { sha: plan.head.sha, tally: tally(r.head) },
      sandbox: r.sandbox, facts: r.facts, ...(r.cancelled ? { cancelled: true } : {}),
    };
  }, (e) => { job.error = e instanceof Error ? e.message : "the check failed"; }).finally(() => { job.state = "done"; });
  return { ok: true, id };
}

export function checkOnBaseStatus(id: unknown): CheckOnBaseStatus {
  const j = typeof id === "string" ? jobs.get(id) : undefined;
  if (!j) return { ok: false, error: "no such check" };
  if (j.state === "running") return { ok: true, state: "running", done: j.done, total: j.total };
  if (j.error || !j.result) return { ok: false, error: j.error ?? "the check failed" };
  return { ok: true, state: "done", result: j.result };
}

export function cancelCheckOnBase(id: unknown): { ok: boolean } {
  const j = typeof id === "string" ? jobs.get(id) : undefined;
  if (!j || j.state !== "running") return { ok: false };
  j.ac.abort();
  return { ok: true };
}
