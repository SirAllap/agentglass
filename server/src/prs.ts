// Pull requests, through the `gh` CLI the user is already logged into.
//
// Three rules shape everything here, and breaking any one of them makes the
// panel worse than the browser it replaces:
//
// 1. NEVER on the poll path. A `gh` call costs 0.8-1.9s and this server has one
//    thread. The panel polls; the fetches do not. Every read below answers from
//    a cache and refreshes behind it, so a poll is a map lookup.
//
// 2. Keyed by the repo on the forge, not by the directory. Eighteen worktrees
//    of one clone are one repo — keying by path would fetch the same list
//    eighteen times.
//
// 3. Writes are public. A stray `gh pr merge` is not a UI bug, it is a deploy,
//    so every mutation goes through `writeGuard` and the irreversible ones are
//    named separately from the rest.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gitAsync, safeAbs, repoRootOf } from "./git.ts";
import { makeViewTempDir } from "./viewtemp.ts";
import { inScope } from "./config.ts";
import type {
  PrRepoId, PrSummary, PrBranchSummary, PrDetail, PrListResponse, PrActionResult, PrCheck, PrCheckRollup,
  PrCheckState, PrThread, PrReview, PrComment, PrCommit, PrFile, PrChecklistItem, PrMergeState, CiVerdict,
  PrAuthored, PrReaction, PrEvent, PrCheckJob, PrReviewer, PrMergePolicy, PrMergeMethod, PrLocalHead,
} from "../../shared/types.ts";

/** Same escape hatch the git writes use, so one variable disables both. */
const WRITE_ENABLED = process.env.AGENTGLASS_GIT_WRITE_DISABLED !== "1";

const GH_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// running gh
// ---------------------------------------------------------------------------

let ghPath: string | null | undefined;
function ghBin(): string | null {
  if (ghPath === undefined) ghPath = Bun.which("gh");
  return ghPath ?? null;
}

export interface GhResult { code: number; stdout: string; stderr: string }

/**
 * Always async, always time-bounded.
 *
 * `gh` talks to the network, and a hung TLS handshake with no timeout is an
 * agentglass that never answers again — the same failure mode as the sync git
 * spawns that used to freeze the terminal socket.
 */
export async function gh(args: string[], cwd?: string, stdin?: string): Promise<GhResult> {
  const bin = ghBin();
  if (!bin) return { code: 127, stdout: "", stderr: "gh not found" };
  try {
    const proc = Bun.spawn([bin, ...args], {
      cwd: cwd || undefined,
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, GH_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code: code ?? 1, stdout, stderr };
  } catch (e) {
    return { code: 1, stdout: "", stderr: String(e) };
  }
}

async function ghJson<T>(args: string[], cwd?: string): Promise<T | null> {
  const r = await gh(args, cwd);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// capability
// ---------------------------------------------------------------------------

export type GhCapability = { available: boolean; authed: boolean; login?: string; reason?: string };

let capCache: { at: number; cap: GhCapability } | null = null;
const CAP_TTL_MS = 60_000;

/**
 * Is `gh` here, and logged in?
 *
 * Cached, because the panel asks on every mount and `gh auth status` is a
 * network round trip. Both answers are first-class UI states rather than
 * errors: "install gh" and "run gh auth login" are things the user can act on,
 * and a red toast saying "failed" is not.
 */
/**
 * The last known answer, without waiting for a fresh one.
 *
 * `gh auth status` is a 344ms subprocess (measured), and it sat in front of
 * every list refresh — so a poll that had nothing else to do still paid it, on
 * the one thread the PTY shares. Auth does not change between two polls; a
 * minute-old answer is the right answer, and a stale one only ever means the
 * *next* refresh reports "not logged in" instead of this one. Returns null the
 * very first time, when there is genuinely nothing to go on.
 */
export function ghCapabilityCached(): GhCapability | null {
  if (capCache && Date.now() - capCache.at < CAP_TTL_MS * 10) return capCache.cap;
  return null;
}

export async function ghCapability(force = false): Promise<GhCapability> {
  if (!force && capCache && Date.now() - capCache.at < CAP_TTL_MS) return capCache.cap;
  let cap: GhCapability;
  if (!ghBin()) {
    cap = { available: false, authed: false, reason: "the GitHub CLI (gh) is not installed" };
  } else {
    const r = await gh(["auth", "status", "--active"]);
    if (r.code !== 0) {
      cap = { available: true, authed: false, reason: "not logged in — run `gh auth login`" };
    } else {
      const m = (r.stdout + r.stderr).match(/account\s+(\S+)/i) || (r.stdout + r.stderr).match(/as\s+(\S+)\s/i);
      cap = { available: true, authed: true, login: m?.[1] };
    }
  }
  capCache = { at: Date.now(), cap };
  return cap;
}

/**
 * How far behind its base a branch actually is.
 *
 * Asked separately, and asked at all, because `mergeStateStatus` does not
 * answer it. That field reports BEHIND only where the repository REQUIRES
 * branches to be up to date before merging; without that protection a branch
 * 194 commits behind its base still reports CLEAN — measured on a real pull
 * request whose branch was exactly that. Gating "Update branch" on BEHIND
 * therefore hid the button in the one case somebody wants it.
 *
 * Its own endpoint rather than part of the detail: it costs about 600ms
 * (measured), and a pull request should open at the speed it opened before.
 * The panel asks once the detail is on screen, and the button appears a moment
 * later — which is the right way round for something that is an offer, not
 * information you are waiting on.
 *
 * `per_page=1` because only the counts are wanted; the commit list and file
 * list are what make this call big.
 */
/** The two branch names a pull request is between. Shared, because everything
 *  that acts on a pull request locally needs exactly this pair. */
export async function prBranches(root: string, number: number): Promise<{ base: string; head: string } | null> {
  const id = await repoIdFor(root);
  if (!id) return null;
  const pr = await ghJson<{ baseRefName?: string; headRefName?: string }>(
    ["pr", "view", String(number), "--repo", `${id.owner}/${id.name}`, "--json", "baseRefName,headRefName"], root);
  return pr?.baseRefName && pr.headRefName ? { base: pr.baseRefName, head: pr.headRefName } : null;
}

/**
 * The open pull requests whose HEAD is this branch, and the ones whose BASE is.
 *
 * Asked of GitHub by branch rather than filtered out of a list this app already
 * holds, and that is the correction rather than an optimisation. The first
 * version read the `mine` scope and matched on head — which quietly answered
 * "there is no pull request" for a branch that had one, because somebody ELSE
 * had opened it. Measured on a real checkout: twelve pull requests pointed at
 * the branch and the one FROM it belonged to a colleague, so the chip never
 * appeared and the panel looked broken rather than narrow.
 *
 * Two `gh` calls with `--head` / `--base`, which are exact and cheap — a list of
 * fifteen thousand filtered client-side is neither. `--limit` is small on
 * purpose: one branch has one pull request out of it, and a base branch with
 * more than twenty incoming is a number, not a list.
 */
export async function prsForBranch(root: string, branchIn: unknown): Promise<{
  ok: boolean; repo?: string; from?: PrBranchSummary; into: PrBranchSummary[];
  /** `gh` is missing or logged out. Distinct from "no pull request here", which
   *  is what silence used to be indistinguishable from. */
  needsAuth?: boolean; error?: string;
}> {
  const branch = typeof branchIn === "string" ? branchIn.trim() : "";
  // Nothing that could be read as an option: this becomes a command argument.
  if (!branch || branch.startsWith("-") || /\s/.test(branch)) return { ok: false, into: [], error: "no branch" };
  const id = await repoIdFor(root);
  if (!id) return { ok: false, into: [], error: "no GitHub remote here" };

  /*
   * The cheap field set, deliberately — and the caller has to know it.
   *
   * `statusCheckRollup` is a separate GraphQL walk per pull request and was
   * measured at four times the cost of everything else together (1.5s against
   * 5.5s on fifty pull requests). That is not a price worth paying behind a chip
   * in a header. So there is NO `checks` on what comes back from here, and a
   * consumer that reads one off it will throw at render — which is exactly what
   * happened, and it took the whole Source control view to a black screen.
   */
  const fields = "number,title,author,state,isDraft,headRefName,baseRefName,url,updatedAt,reviewDecision";
  /*
   * `null` for "could not ask", `[]` for "asked, nothing there".
   *
   * These were the same value, so `gh` uninstalled, logged out, or killed by
   * the 25s timeout all came back as `{ ok: true, into: [] }` — and the header
   * drew exactly what it draws for a branch with no pull request: nothing.
   * Measured by taking gh off the PATH: `{"ok":true,"repo":"…","into":[]}`.
   */
  const ask = async (flag: "--head" | "--base", limit: number) => {
    const r = await ghJson<Record<string, unknown>[]>(
      ["pr", "list", flag, branch, "--state", "open", "--json", fields, "--limit", String(limit)], root);
    return Array.isArray(r) ? r : null;
  };
  const [out, incoming] = await Promise.all([ask("--head", 5), ask("--base", 20)]);
  if (out === null || incoming === null) {
    const cap = await ghCapability();
    return { ok: false, repo: id.nameWithOwner, into: [],
      needsAuth: !cap.available || !cap.authed,
      error: !cap.available ? "the gh CLI is not installed"
        : !cap.authed ? "gh is not signed in to GitHub"
        : "GitHub did not answer" };
  }
  /*
   * Built field by field, not spread and cast.
   *
   * Narrowing the TYPE to a `Pick<>` fixed which fields are promised; it did
   * nothing about whether the values match. `gh` sends `reviewDecision: ""` for
   * a pull request nobody has reviewed, and the declared type says
   * `"APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null` — so the
   * first consumer to write `=== null` or to switch over the three names takes
   * the wrong arm with no type error. Exactly how `checks.failure` reached a
   * render and blacked out the Source control view.
   *
   * The two other mappers of this same `gh pr list --json` payload already do
   * `p.reviewDecision || null`. This one was the odd one out.
   */
  const shape = (p: Record<string, unknown>): PrBranchSummary => ({
    number: Number(p.number ?? 0),
    title: String(p.title ?? ""),
    author: typeof p.author === "object" && p.author ? (p.author as { login?: string }).login ?? "" : String(p.author ?? ""),
    state: (p.state === "CLOSED" || p.state === "MERGED" ? p.state : "OPEN") as PrBranchSummary["state"],
    isDraft: !!p.isDraft,
    headRefName: String(p.headRefName ?? ""),
    baseRefName: String(p.baseRefName ?? ""),
    url: String(p.url ?? ""),
    updatedAt: String(p.updatedAt ?? ""),
    reviewDecision: (p.reviewDecision || null) as PrBranchSummary["reviewDecision"],
  });
  /* `repo` travels with the answer so a caller can OPEN one of these rather
     than search for it: the panel's jump is addressed by owner/name and number,
     and without the name the only thing left to do with a number is type it
     into a search box. */
  return { ok: true, repo: id.nameWithOwner, from: out[0] ? shape(out[0]) : undefined, into: incoming.map(shape) };
}

export async function branchBehind(root: string, number: number): Promise<{ ok: boolean; behind?: number; ahead?: number; local?: PrLocalHead; error?: string }> {
  const id = await repoIdFor(root);
  if (!id) return { ok: false, error: "no GitHub remote here" };
  const pr = await prBranches(root, number);
  if (!pr) return { ok: false, error: "could not read the branches" };
  const cmp = await ghJson<{ behind_by?: number; ahead_by?: number }>(
    ["api", `repos/${id.owner}/${id.name}/compare/${encodeURIComponent(pr.base)}...${encodeURIComponent(pr.head)}?per_page=1`], root);
  if (!cmp) return { ok: false, error: "GitHub would not compare those branches" };
  // Local state rides along. It is git only — no network — so it costs a few
  // milliseconds on a call the panel already makes, rather than a second round
  // trip for the one thing the button was never telling anybody.
  const local = await localHead(root, pr.head);
  return { ok: true, behind: Number(cmp.behind_by ?? 0), ahead: Number(cmp.ahead_by ?? 0), local };
}

/** The upstream this branch tracks, as a remote name and the ref that follows
 *  it. `@{upstream}` is asked first because a branch may track something other
 *  than `origin/<same name>`; origin is the fallback, not the assumption. */
async function upstreamOf(root: string, branch: string): Promise<{ remote: string; ref: string; remoteBranch: string } | null> {
  const full = await gitAsync(root, ["rev-parse", "--symbolic-full-name", `${branch}@{upstream}`]);
  if (full.code === 0 && full.stdout.trim().startsWith("refs/remotes/")) {
    const ref = full.stdout.trim();
    const cfg = await gitAsync(root, ["config", "--get", `branch.${branch}.remote`]);
    const remote = cfg.code === 0 ? cfg.stdout.trim() : ref.slice("refs/remotes/".length).split("/")[0]!;
    // The remote's own name for it, which is not always this branch's name.
    const merge = await gitAsync(root, ["config", "--get", `branch.${branch}.merge`]);
    const remoteBranch = merge.code === 0 && merge.stdout.trim().startsWith("refs/heads/")
      ? merge.stdout.trim().slice("refs/heads/".length)
      : ref.slice(`refs/remotes/${remote}/`.length);
    return { remote, ref, remoteBranch };
  }
  // No upstream configured. A branch fetched by somebody else's tooling often
  // has none, and origin/<branch> is still the thing it is behind.
  const guess = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return guess.code === 0 ? { remote: "origin", ref: `refs/remotes/origin/${branch}`, remoteBranch: branch } : null;
}

/** Which worktree has this branch checked out, if any. */
async function worktreeOf(root: string, branch: string): Promise<string | undefined> {
  const r = await gitAsync(root, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return undefined;
  let path = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return path || undefined;
  }
  return undefined;
}

/** Mid-merge, mid-rebase, mid-cherry-pick: a checkout in the middle of an
 *  operation is not somewhere to fast-forward into. */
async function midOperation(dir: string): Promise<boolean> {
  for (const head of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    if ((await gitAsync(dir, ["rev-parse", "--verify", "--quiet", head])).code === 0) return true;
  }
  for (const d of ["rebase-merge", "rebase-apply"]) {
    const p = await gitAsync(dir, ["rev-parse", "--git-path", d]);
    if (p.code === 0 && existsSync(resolve(dir, p.stdout.trim()))) return true;
  }
  return false;
}

/**
 * The local copy of a branch, and what may safely be done to it.
 *
 * Read-only, and deliberately pessimistic: the only verdict that leads to a
 * write is `ff`, and everything else is a sentence for the person to act on.
 * The machine this runs on has a dozen worktrees with agents working in them,
 * so "probably fine" is not a good enough reason to move somebody's HEAD.
 */
export async function localHead(root: string, branch: string): Promise<PrLocalHead> {
  const none: PrLocalHead = { branch, exists: false, ahead: 0, behind: 0, dirty: false, sync: "absent" };
  if (!branch) return none;
  const has = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (has.code !== 0) return none;

  const up = await upstreamOf(root, branch);
  let ahead = 0, behind = 0;
  if (up) {
    // left = ours, right = theirs. Ahead is what GitHub has not got, which is
    // the one that makes a fast-forward impossible once GitHub merges.
    const counts = await gitAsync(root, ["rev-list", "--left-right", "--count", `${branch}...${up.ref}`]);
    if (counts.code === 0) {
      const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
      ahead = a ?? 0; behind = b ?? 0;
    }
  }

  const worktree = await worktreeOf(root, branch);
  const dirty = worktree ? (await gitAsync(worktree, ["status", "--porcelain"])).stdout.trim().length > 0 : false;
  const busy = worktree ? await midOperation(worktree) : false;

  // Order matters: a checkout in the middle of something is the most specific
  // "leave it alone", and divergence outranks dirtiness because no amount of
  // committing turns it back into a fast-forward.
  const sync: PrLocalHead["sync"] = busy ? "busy" : ahead > 0 ? "diverged" : dirty ? "dirty" : "ff";
  return { branch, exists: true, worktree, ahead, behind, dirty, sync };
}

// ---------------------------------------------------------------------------
// what is left of GitHub's rate limit
// ---------------------------------------------------------------------------

/**
 * How much of GitHub's hourly budget is left.
 *
 * Worth surfacing because this app is made of `gh`: every pull-request list,
 * every check, every review is a call against a budget that is invisible until
 * it runs out — and when it does, the panel does not say "rate limited", it
 * says nothing, twice, and then a list that is a minute stale.
 *
 * Three budgets rather than one, because they are separate pots and the small
 * one is the one that bites: Search is 30 a minute against REST's 5,000 an
 * hour, and searching is exactly what "find the pull requests for this card"
 * does.
 *
 * Never cached here. It is asked for by a settings page somebody is looking at,
 * which is the one moment a stale answer is worse than a slow one — and the
 * call itself does not count against any of the budgets it reports.
 */
export interface RateBudget {
  /** `core` | `search` | `graphql`, as GitHub names them. */
  id: string;
  label: string;
  limit: number;
  remaining: number;
  /** Epoch seconds, as GitHub sends it. */
  reset: number;
}

export async function ghRateLimit(): Promise<{ ok: boolean; error?: string; budgets?: RateBudget[] }> {
  const cap = await ghCapability();
  if (!cap.available) return { ok: false, error: cap.reason ?? "the GitHub CLI (gh) is not installed" };
  if (!cap.authed) return { ok: false, error: cap.reason ?? "not logged in — run `gh auth login`" };
  const r = await ghJson<{ resources?: Record<string, { limit: number; remaining: number; reset: number }> }>(
    ["api", "rate_limit"]);
  if (!r?.resources) return { ok: false, error: "GitHub did not answer with a budget" };
  const NAMED: [string, string][] = [["core", "REST"], ["search", "Search"], ["graphql", "GraphQL"]];
  const budgets = NAMED
    .filter(([id]) => r.resources![id])
    .map(([id, label]) => ({ id, label, ...r.resources![id]! }));
  return { ok: true, budgets };
}

// ---------------------------------------------------------------------------
// repo identity
// ---------------------------------------------------------------------------

/**
 * `git@github.com:acme/orbit.git` and
 * `https://github.com/acme/orbit.git` are the same repo.
 *
 * Returns null rather than guessing for anything that is not an obvious
 * host/owner/name — a local path remote, a weird protocol. Guessing here would
 * send `gh` at a repo that isn't yours.
 */
export function parseRemote(url: string): PrRepoId | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  let host = "", path = "";
  const scp = raw.match(/^(?:([^@]+)@)?([^/:]+):(.+)$/);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ssh:") return null;
      host = u.hostname;
      path = u.pathname;
    } catch { return null; }
  } else if (scp) {
    host = scp[2]!;
    path = scp[3]!;
  } else {
    return null;
  }
  const parts = path.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2 || !host) return null;
  // Owner is the second-to-last segment: GHE can serve from a subpath.
  const name = parts[parts.length - 1]!;
  const owner = parts[parts.length - 2]!;
  const nameWithOwner = `${owner}/${name}`;
  return { key: `${host}/${nameWithOwner}`, host, owner, name, nameWithOwner };
}

const idCache = new Map<string, { at: number; id: PrRepoId | null }>();
const ID_TTL_MS = 5 * 60_000;

/**
 * Which repo is this directory part of?
 *
 * `upstream` wins over `origin`: on a fork, the pull requests live on the
 * upstream and a panel pointed at the fork shows an empty list forever. That is
 * three lines here and confusing to retrofit later.
 */
/**
 * Single-flighted as well as cached, because `gitwork`'s base ladder asks this
 * once per checkout and launches all of them in one `Promise.all` — twenty-two
 * on a worktree-heavy repo, every one of them missing an empty cache before any
 * has filled it. Two `git remote get-url` each is nothing on its own and forty
 * of them at once, five minutes apart, is not nothing.
 */
const idInflight = new Map<string, Promise<PrRepoId | null>>();

export async function repoIdFor(rootIn: unknown): Promise<PrRepoId | null> {
  const abs = safeAbs(rootIn);
  if (!abs) return null;
  const root = repoRootOf(abs);
  if (!root) return null;
  const hit = idCache.get(root);
  if (hit && Date.now() - hit.at < ID_TTL_MS) return hit.id;
  const flying = idInflight.get(root);
  if (flying) return flying;
  const p = (async () => {
    try {
      let id: PrRepoId | null = null;
      for (const remote of ["upstream", "origin"]) {
        const r = await gitAsync(root, ["remote", "get-url", remote]);
        if (r.code !== 0) continue;
        id = parseRemote(r.stdout.trim());
        if (id) break;
      }
      idCache.set(root, { at: Date.now(), id });
      return id;
    } finally {
      idInflight.delete(root);
    }
  })();
  idInflight.set(root, p);
  return p;
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

type RawCheck = {
  __typename?: string;
  name?: string; workflowName?: string; context?: string;
  status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string;
};

const TERMINAL_CONCLUSIONS = new Set([
  "SUCCESS", "FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "NEUTRAL", "SKIPPED", "STALE", "STARTUP_FAILURE",
]);

function checkState(c: RawCheck): { state: PrCheckState; done: boolean } {
  // Two shapes come back in one array: CheckRun (status + conclusion) and
  // StatusContext (state). Normalising here keeps every caller from re-learning
  // GitHub's two vocabularies for the same idea.
  if (c.__typename === "StatusContext" || (!c.status && c.state)) {
    const s = (c.state || "").toUpperCase();
    if (s === "SUCCESS") return { state: "success", done: true };
    if (s === "FAILURE" || s === "ERROR") return { state: "failure", done: true };
    return { state: "pending", done: false };
  }
  const status = (c.status || "").toUpperCase();
  const concl = (c.conclusion || "").toUpperCase();
  if (status !== "COMPLETED") return { state: "pending", done: false };
  if (!TERMINAL_CONCLUSIONS.has(concl)) return { state: "pending", done: false };
  if (concl === "SUCCESS") return { state: "success", done: true };
  if (concl === "SKIPPED" || concl === "STALE") return { state: "skipped", done: true };
  if (concl === "NEUTRAL") return { state: "neutral", done: true };
  return { state: "failure", done: true };
}

export function rollupChecks(raw: RawCheck[] | null | undefined): { rollup: PrCheckRollup; all: PrCheck[] } {
  const all: PrCheck[] = [];
  let success = 0, failure = 0, skipped = 0, pending = 0;
  for (const c of raw || []) {
    const { state, done } = checkState(c);
    const check: PrCheck = {
      name: c.name || c.context || "check",
      workflow: c.workflowName || "",
      state, done,
      url: c.detailsUrl || c.targetUrl || undefined,
    };
    all.push(check);
    if (state === "success") success++;
    else if (state === "failure") failure++;
    else if (state === "skipped" || state === "neutral") skipped++;
    else pending++;
  }
  const total = all.length;
  const allDone = total > 0 && pending === 0;
  return {
    rollup: {
      total, success, failure, skipped, pending, allDone,
      // Skipped is not failure. Eighteen of a real PR's sixty-one checks are
      // skipped and that PR is green.
      verdict: allDone ? (failure > 0 ? "red" : "green") : null,
      failing: all.filter((c) => c.state === "failure"),
    },
    all,
  };
}

// ---------------------------------------------------------------------------
// CI notification latch
// ---------------------------------------------------------------------------

/** What we last told the user about each PR, so we tell them once. */
const latch = new Map<string, "green" | "red">();
/**
 * PRs whose suite we have actually watched running.
 *
 * The latch alone made every first observation an announcement, so starting the
 * app told you the standing state of everything you have a stake in — seventeen
 * "checks green" in one burst, about runs that finished days ago. That is not a
 * notification, it is an inventory, and it is what makes people stop reading
 * the ones that matter.
 *
 * A notification is for something that happened while you were watching. So a
 * verdict counts as news only for a PR we saw with checks still running: that
 * is the difference between "this just went green" and "this was already
 * green when I arrived". Everything else is recorded silently and reported the
 * moment it CHANGES, which covers the re-run, the flip from green to red, and
 * every case anyone actually wants to be interrupted for.
 */
const watched = new Set<string>();
const ciListeners = new Set<(v: CiVerdict) => void>();

export function subscribeCi(fn: (v: CiVerdict) => void): () => void {
  ciListeners.add(fn);
  return () => { ciListeners.delete(fn); };
}

/**
 * One notification per PR, at the end.
 *
 * A PR with sixty-one checks offers sixty-one chances to interrupt someone. The
 * latch holds until every check is terminal and then reports the aggregate
 * once. A re-run puts checks back to pending, which clears the latch, so a
 * genuine second result still arrives — but a single green check inside a
 * still-running suite never does.
 *
 * Exported so the latch can be tested without a network: it is the piece here
 * whose failure mode — sixty-one notifications instead of one — the user would
 * feel immediately.
 */
export function noteCi(repo: PrRepoId, pr: PrSummary): void {
  const key = `${repo.key}#${pr.number}`;
  // Seeing it run is what earns the announcement when it lands.
  if (!pr.checks.allDone) { latch.delete(key); watched.add(key); return; }
  const verdict = pr.checks.verdict;
  if (!verdict) return;
  const prev = latch.get(key);
  latch.set(key, verdict);
  if (prev === verdict) return;
  // First sight of a suite we never saw running: this is the state of the world
  // as we found it, not something that happened. Remembered, not announced —
  // any later change from here is news and does get through.
  if (prev === undefined && !watched.has(key)) return;
  const v: CiVerdict = {
    repo: repo.nameWithOwner, number: pr.number, title: pr.title, verdict,
    failing: pr.checks.failing.map((c) => c.name), url: pr.url,
    // The poll has this and the notification path does not, so it travels with
    // the verdict rather than being looked up again later against a list that
    // may never have been fetched.
    approved: pr.reviewDecision === "APPROVED",
  };
  for (const fn of ciListeners) { try { fn(v); } catch { /* a listener must not break the poll */ } }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type PrFilter = "mine" | "review" | "all";
// The open/closed axis, orthogonal to the mine/review/all scope. `closed`
// includes merged, exactly as gh's `--state closed` and GitHub's own "Closed"
// tab do; `all` is everything. Drives the fetch (a closed PR is never fetched
// under `open`), so it is part of the cache key, not a client-side facet.
export type PrState = "open" | "closed" | "all";

/**
 * Whether probing a filter's PRs should also raise CI notifications.
 *
 * The panel warms all three filters to fill the tab counts, so `all` is fetched
 * passively the moment the panel opens — on a busy repo that is hundreds of PRs
 * the user never authored and was not asked to review. A notification is meant
 * to be about YOUR stake in a PR, so only the filters that encode a stake —
 * authored (`mine`) and review-requested (`review`) — notify. Browsing `all`
 * still renders check states; it just does not push. A PR that is both yours and
 * in `all` still notifies exactly once, because the `mine`/`review` probe runs
 * too and the per-PR latch dedupes across filters.
 */
export function ciNotifiesFor(filter: PrFilter): boolean {
  return filter !== "all";
}

/**
 * Two field sets, because one of them costs four times the other.
 *
 * Measured on a real repo, 50 open pull requests: 1.5s without
 * `statusCheckRollup` and 5.5s with it. The rollup is a separate GraphQL walk
 * per pull request, so it dominates — and it is also the part nobody is waiting
 * for when they open the panel to find a title.
 *
 * So the list arrives in two passes. The cheap one lands first and the rows are
 * usable immediately; the rollup fills the check states in behind it. A row
 * whose checks have not landed says so rather than claiming "no checks", which
 * is a different and wrong answer.
 */
const LIST_FIELDS_FAST = "number,title,author,state,isDraft,headRefName,baseRefName,url,updatedAt,reviewDecision,additions,deletions,changedFiles,labels,assignees,milestone";

type Entry = { at: number; prs: PrSummary[]; loading: boolean; checksPending: boolean; error?: string; total?: number; hasNext?: boolean; cursor?: string | null };
const listCache = new Map<string, Entry>();
const inflight = new Set<string>();

/**
 * The list cache, kept across restarts.
 *
 * Measured: a no-op call to api.github.com costs ~280ms before it does anything,
 * and the list query 650-1000ms — while github.com's own page, rendered next to
 * its database and served from their edge, answers in ~115ms. That gap is not
 * something a better query closes; it is the internet. So the answer is to stop
 * starting from nothing: the last known list is written to disk, read back at
 * boot, and shown at once while a refresh runs behind it. Stale rows you can
 * read beat a spinner you cannot, and the age is on screen either way.
 *
 * Rows only. Nothing here is secret (it is a public pull request list you can
 * already read), but it is scoped to the user's own cache directory all the
 * same, and a corrupt or unreadable file is simply ignored.
 */
/**
 * The base branch an open pull request declares for this head.
 *
 * Read straight off the list cache — the rows are already fetched with
 * `baseRefName` in them (`LIST_FIELDS_FAST`), and that cache survives restarts
 * on disk, so the answer is usually there before anything has refreshed. No
 * `gh`, no network: the only subprocess this can reach is `repoIdFor`'s
 * `git remote get-url`, itself cached for five minutes.
 *
 * This exists for `gitwork`'s base ladder, which otherwise has to guess what a
 * branch was cut from by the shape of history — ambiguous exactly when branches
 * are stacked, which is exactly when it matters. Null whenever there is nothing
 * to say (no repo id, cold cache, no pull request for this branch); the caller
 * falls back to inference.
 *
 * An open pull request wins over a closed or merged one: the same branch can
 * have been proposed twice, and the live proposal is the one whose base is
 * still being merged into.
 */
export async function prBaseOf(rootIn: string, branch: string): Promise<string | null> {
  if (!branch) return null;
  const id = await repoIdFor(rootIn);
  if (!id) return null;
  const mine = `${id.key}\u0000`;
  let fallback: string | null = null;
  for (const [k, e] of listCache) {
    if (!k.startsWith(mine)) continue;
    for (const p of e.prs) {
      if (p.headRefName !== branch || !p.baseRefName) continue;
      if (p.state === "OPEN") return p.baseRefName;
      fallback ??= p.baseRefName;
    }
  }
  return fallback;
}

/**
 * Where the three pull-request caches live.
 *
 * An environment override, and not for configurability: the suite writes to
 * these the moment it exercises a code path that caches, and without a seam
 * that write lands in the developer's own `~/.cache/agentglass`. The ClickUp
 * module learned this the hard way — its test read the real config file, so a
 * toggle flipped in the app decided whether a test passed. One env var, set by
 * the tests, keeps every one of these inside its own temporary directory.
 */
const CACHE_DIR = process.env.AGENTGLASS_CACHE_DIR || join(homedir(), ".cache", "agentglass");
const CACHE_FILE = join(CACHE_DIR, "pr-list.json");
const CACHE_MAX_ENTRIES = 24;
let cacheWriteTimer: ReturnType<typeof setTimeout> | null = null;

function loadDiskCache(): void {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, Entry>;
    for (const [k, e] of Object.entries(raw)) {
      if (!e || !Array.isArray(e.prs)) continue;
      // Never restored as "fresh": `at` is what it was, so the age shown is
      // honest and the first read triggers a refresh.
      listCache.set(k, { ...e, loading: false, checksPending: false });
    }
  } catch { /* unreadable or from an older shape — start empty */ }
}

function saveDiskCache(): void {
  if (cacheWriteTimer) clearTimeout(cacheWriteTimer);
  // Debounced: a burst of refreshes writes once.
  cacheWriteTimer = setTimeout(() => {
    try {
      const entries = [...listCache.entries()]
        .filter(([, e]) => e.prs.length > 0 && !e.error)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, CACHE_MAX_ENTRIES);
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* a cache that cannot be written is not an error worth raising */ }
  }, 1_000);
}

loadDiskCache();
const LIST_TTL_MS = 90_000;

// `\u0000` written as an escape, never as the byte: a raw NUL makes the whole
// file read as binary to grep, which then skips it in silence. Same separator,
// same keys, still searchable.
const cacheKey = (repo: PrRepoId, filter: PrFilter, state: PrState, after?: string, query?: string) => `${repo.key}\u0000${filter}\u0000${state}\u0000${after ?? ""}\u0000${query ?? ""}`;

// Exported for the test that pins the gh-JSON field extraction (assignees,
// milestone) — the shapes gh returns are an assumption worth guarding.
export function mapSummary(p: any, withChecks: boolean): PrSummary {
  const { rollup } = rollupChecks(withChecks ? p.statusCheckRollup : []);
  return {
    number: p.number,
    title: p.title || "",
    author: p.author?.login || "",
    state: (p.state || "OPEN") as PrSummary["state"],
    isDraft: !!p.isDraft,
    headRefName: p.headRefName || "",
    baseRefName: p.baseRefName || "",
    url: p.url || "",
    updatedAt: p.updatedAt || "",
    reviewDecision: p.reviewDecision || null,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changedFiles ?? 0,
    labels: (p.labels || []).map((l: any) => ({ name: l.name, color: l.color })),
    assignees: (p.assignees || []).map((a: any) => a.login).filter(Boolean),
    milestone: p.milestone?.title || null,
    checks: rollup,
    // Absent is not zero: a row without this must say "checks loading", never
    // "no checks", which is a claim about the repository rather than about us.
    checksLoaded: withChecks,
  };
}

/**
 * `reviewRequests` as the Reviewers column reads them.
 *
 * A requested reviewer is a User or a Team, and the two are drawn differently:
 * a team has a `name` and no face, so it is flagged rather than sent to the
 * avatar proxy, which would 404 and fall back to initials that look like a
 * person. Anything else GitHub might add to that union is dropped rather than
 * rendered as a blank face. The picture itself is derived from the login by the
 * Avatar component, so no URL travels with the row.
 */
export function mapReviewers(nodes: any[] | null | undefined): PrReviewer[] {
  const out: PrReviewer[] = [];
  for (const n of nodes ?? []) {
    const r = n?.requestedReviewer;
    if (!r) continue;
    if (typeof r.login === "string" && r.login) out.push({ login: r.login });
    else if (typeof r.name === "string" && r.name) out.push({ login: r.name, isTeam: true });
  }
  return out;
}

/** One page of the list, and everything the rows need, in a single request. */
const LIST_PAGE = 25;

/**
 * The rows, and nothing that costs more than a row is worth.
 *
 * `additions`, `deletions`, `changedFiles` and `reviewDecision` used to travel
 * here, and they are why the panel took two seconds to show anything. Measured
 * against a repository with 25 open PRs: this query costs ~0.70s without them and
 * ~1.85s with them — the four fields make GitHub compute a diff stat per PR
 * before it will answer with any of the list. Three of them are not even drawn
 * on a row (only `reviewDecision` is, as the review chip); they were paying a
 * 2.6x first-paint tax for the detail view's benefit.
 *
 * They now ride on SEARCH_CHECKS, which runs beside this one and is the slower
 * of the pair — measured, adding them there costs nothing at all.
 */
const SEARCH_ROWS = `query($q:String!,$first:Int!,$after:String){
  search(query:$q, type:ISSUE, first:$first, after:$after){
    issueCount
    pageInfo{hasNextPage endCursor}
    nodes{ ... on PullRequest {
      number title url state isDraft createdAt updatedAt
      baseRefName headRefName
      author{login}
      labels(first:10){nodes{name color}}
      assignees(first:5){nodes{login}}
      milestone{title}
    } }
  }
}`;

/**
 * The same page, but only what the rows can afford to wait for.
 *
 * Measured against this repo: the row fields cost ~730ms and `statusCheckRollup`
 * adds ~410ms on top when they travel together. Asked for separately the two
 * run at the same time, so the whole thing costs what the slower one costs
 * (~810ms) instead of their sum — and, more to the point, the rows can be put
 * on screen the moment they land rather than waiting for the checks.
 *
 * The diff stats and `reviewDecision` live here rather than on SEARCH_ROWS for
 * the same reason, and because it is free: measured on that same repo this query
 * costs ~1.00s either way, while carrying them on the rows query costs it an
 * extra ~1.15s. This is the slower half of the pair, so the four fields land in
 * the shadow of work that was happening anyway.
 */
const SEARCH_CHECKS = `query($q:String!,$first:Int!,$after:String){
  search(query:$q, type:ISSUE, first:$first, after:$after){
    nodes{ ... on PullRequest {
      number additions deletions changedFiles reviewDecision
      reviewRequests(first:5){nodes{requestedReviewer{
        ... on User{login}
        ... on Team{name}
      }}}
      commits(last:1){nodes{commit{oid statusCheckRollup{
        state
        contexts(first:0){checkRunCountsByState{state count} statusContextCountsByState{state count}}
      }}}}
    } }
  }
}`;

/** The search expression for a scope + state, in GitHub's own qualifier grammar. */
/**
 * The panel's filter, expressed as GitHub's own search.
 *
 * The facets used to be applied to whatever page happened to be loaded, which
 * meant the Author menu listed only the authors on that page and picking one
 * filtered 25 rows out of 216 — you could not see all of a contributor's pull
 * requests at all. Every facet GitHub's search understands is therefore sent to
 * GitHub, and the answer is the whole repository rather than the current page.
 *
 * The panel's grammar and GitHub's differ in three places, so those are mapped:
 * `checks:` is GitHub's `status:`, `is:draft|ready` is `draft:true|false`, and a
 * value with spaces is quoted. Repeated values of one facet are OR-ed, which
 * search does natively for the qualifiers that allow repetition.
 */
const QUALIFIER: Record<string, string> = {
  author: "author", assignee: "assignee", label: "label",
  milestone: "milestone", review: "review", base: "base",
};

function quoteQ(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

function searchExpr(repo: PrRepoId, filter: PrFilter, state: PrState, query?: string): string {
  const parts = [`repo:${repo.nameWithOwner}`, "is:pr"];
  // `is:closed` covers merged as well, which is what GitHub's own Closed tab
  // means and what this panel promises.
  if (state === "open") parts.push("is:open");
  else if (state === "closed") parts.push("is:closed");
  if (filter === "mine") parts.push("author:@me");
  else if (filter === "review") parts.push("review-requested:@me");

  const free: string[] = [];
  for (const tok of tokenize(query ?? "")) {
    const ci = tok.indexOf(":");
    const key = ci > 0 ? tok.slice(0, ci).toLowerCase() : "";
    const rawValue = ci > 0 ? tok.slice(ci + 1) : "";
    const value = rawValue.startsWith('"') ? rawValue.slice(1, rawValue.endsWith('"') ? -1 : undefined) : rawValue;
    // A half-typed `author:` is a filter in progress, not a phrase to search
    // for — sending it makes GitHub narrow to an empty author, or reject the
    // query outright.
    if (key && !value) continue;
    if (!key) { if (tok.trim()) free.push(tok); continue; }
    const q = QUALIFIER[key];
    if (q) { parts.push(`${q}:${quoteQ(value)}`); continue; }
    if (key === "checks") {
      const st = value.toLowerCase() === "green" ? "success" : value.toLowerCase() === "red" ? "failure" : "pending";
      parts.push(`status:${st}`);
      continue;
    }
    if (key === "is") {
      if (value.toLowerCase() === "draft") parts.push("draft:true");
      else if (value.toLowerCase() === "ready") parts.push("draft:false");
      continue;
    }
    if (key === "sort") continue; // ordering is decided below, not by the user's text
    free.push(tok); // an unknown qualifier is somebody's words, not a filter
  }
  // Free words search the title and body, which is what typing into the box
  // means. ALWAYS quoted: `foo:bar` is not a qualifier we know, and sent bare it
  // would either be read as one or make GitHub reject the whole search.
  for (const w of free) parts.push(`"${w.replace(/"/g, "")}"`);

  parts.push("sort:updated-desc");
  return parts.join(" ");
}

/** Exported for the test that pins the translation to GitHub's grammar. */
export const __test_searchExpr = searchExpr;

/** Split on spaces, keeping `key:"two words"` in one piece. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A page of pull requests WITH their check states, in one GraphQL request.
 *
 * This used to be two round trips — `gh pr list` for the rows, then a second
 * batched query for the check rollups — which is why every row said "Checks…"
 * for a beat, and why the whole list waited on a REST call that returns
 * everything or nothing. `search` takes a cursor, so it also gives the panel
 * something it never had: a second page. `contexts(first: 0)` keeps the
 * rollup to its cheap aggregate counts (see fetchCheckRollups).
 */
type ListPage = { rows: PrSummary[]; total: number; hasNext: boolean; cursor: string | null };
async function fetchList(repo: PrRepoId, filter: PrFilter, state: PrState, after?: string, onRows?: (p: ListPage) => void, query?: string): Promise<ListPage | null> {
  const vars = { q: searchExpr(repo, filter, state, query), first: LIST_PAGE, ...(after ? { after } : {}) };
  // Both at once — GitHub really does run them concurrently (measured: the pair
  // costs what the slower one costs, not their sum). The rows are handed over
  // the moment they land rather than waiting on the checks, so the list appears
  // as soon as there is a list to show.
  const rowsP = ghGraphql<any>(SEARCH_ROWS, vars);
  const checksP = ghGraphql<any>(SEARCH_CHECKS, vars);
  const rowsRes = await rowsP;
  const search = rowsRes?.data?.search;
  // null (gh failed / unparsable) and an empty page are different facts: keep
  // null distinct so a network blip holds the last good list while a genuine
  // empty is allowed to empty the panel.
  if (!search) return null;
  const bare: PrSummary[] = (search.nodes || [])
    .filter((n: any) => n && typeof n.number === "number")
    .map((n: any) => mapSummary({ ...n, labels: n.labels?.nodes ?? [], assignees: n.assignees?.nodes ?? [] }, false));
  const meta = {
    total: Number(search.issueCount ?? bare.length),
    hasNext: !!search.pageInfo?.hasNextPage,
    cursor: search.pageInfo?.endCursor ?? null,
  };
  onRows?.({ rows: bare, ...meta });

  const checksRes = await checksP;
  // The second pass carries the costly row fields as well as the rollups, so a
  // row is complete the moment this lands. A PR missing from the answer keeps
  // the first-pass row: `checksLoaded` stays false, the review chip stays off,
  // and the stats stay at zero — all of which read as "not yet", which is true.
  type SecondPass = { rollup: PrCheckRollup; stats: Pick<PrSummary, "additions" | "deletions" | "changedFiles" | "reviewDecision" | "reviewers" | "headSha"> };
  const second = new Map<number, SecondPass>();
  for (const n of checksRes?.data?.search?.nodes ?? []) {
    if (!n?.number) continue;
    const head = n.commits?.nodes?.[0]?.commit;
    const roll = head?.statusCheckRollup;
    const ctx = roll?.contexts;
    second.set(n.number, {
      rollup: rollupFromCounts(ctx?.checkRunCountsByState, ctx?.statusContextCountsByState, roll?.state),
      stats: {
        additions: n.additions ?? 0,
        deletions: n.deletions ?? 0,
        changedFiles: n.changedFiles ?? 0,
        reviewDecision: n.reviewDecision ?? null,
        reviewers: mapReviewers(n.reviewRequests?.nodes),
        /* The commit the rollup above belongs to, read off the same node rather
           than asked for separately — which is the whole reason it can be
           trusted as a merge precondition. A row says "green"; that word is
           about THIS commit, and a merge sent without it lands on whatever the
           tip is by then. See mergePr's --match-head-commit. */
        headSha: typeof head?.oid === "string" ? head.oid : undefined,
      },
    });
  }
  const rows: PrSummary[] = bare.map((r) => {
    const hit = second.get(r.number);
    return hit ? { ...r, ...hit.stats, checks: hit.rollup, checksLoaded: true } : r;
  });
  return { rows, ...meta };
}

/**
 * Check states for the whole list in ONE GraphQL request.
 *
 * The old shape was one `gh pr view --json statusCheckRollup` per PR — fifty
 * subprocesses, ~0.8s each, ~40s of background network to fill a busy list, on
 * the single thread the PTY rides. Batching the FULL contexts was what forced
 * that: fifty full rollups in one query answered `HTTP 504`. The aggregate
 * counts field does not (cli/cli#7421), and the panel rows only read the counts,
 * so the whole set is now one process and ~1 rate-limit point (measured ~0.8s
 * for the list this repo has). fetchCheckRollups above does the fetch; here we
 * decide which PRs still need it.
 *
 * Keyed by `updatedAt`, so a poll that finds nothing changed costs nothing.
 */
/** Matched to the list's own limit on purpose. A lower cap leaves the rows past
 *  it saying "checks…" for ever, which is a lie the UI has no way to correct.
 *  One batched request for all fifty now, and the cache keyed by `updatedAt`
 *  makes every later visit free. */
const CHECK_PROBE_MAX = 50;
const checkCache = new Map<string, { updatedAt: string; rollup: PrCheckRollup }>();
const checkRunning = new Set<string>();

// The GraphQL rollup states, bucketed exactly as checkState() buckets the
// per-check shapes — the aggregate-counts path and the full per-check path must
// agree on what counts as failing, or a PR would read red in the list and green
// in its detail. Unknown states fall to `pending` so an unrecognised one never
// makes a PR look falsely done/green.
const COUNT_BUCKET: Record<string, "success" | "failure" | "skipped" | "pending"> = {
  SUCCESS: "success",
  FAILURE: "failure", ERROR: "failure", CANCELLED: "failure", TIMED_OUT: "failure",
  ACTION_REQUIRED: "failure", STARTUP_FAILURE: "failure",
  SKIPPED: "skipped", STALE: "skipped", NEUTRAL: "skipped",
  IN_PROGRESS: "pending", PENDING: "pending", QUEUED: "pending", REQUESTED: "pending",
  WAITING: "pending", EXPECTED: "pending", COMPLETED: "pending",
};

type StateCount = { state: string; count: number };

/**
 * A check rollup from the cheap aggregate counts (checkRunCountsByState +
 * statusContextCountsByState) rather than the full per-check list. The counts
 * are "dramatically faster" and batch without the 504 that full contexts hit
 * (cli/cli#7421), and the panel rows read only the counts and the verdict.
 * `failing` is empty — the names are not in the aggregate; the expanded PR
 * detail (prDetail) still fetches them on open. Aggregation matches
 * rollupChecks: allDone iff there are checks and none pending; skipped/neutral
 * never count as failure. Exported for testing.
 */
// `rollupState` is GitHub's own `statusCheckRollup.state` (SUCCESS/FAILURE/
// ERROR/PENDING/EXPECTED). When present it decides the verdict authoritatively;
// the counts only fill the numbers the row shows. Absent (no CI on the commit),
// we fall back to deriving the verdict from the counts.
export function rollupFromCounts(checkRun: StateCount[] | undefined, statusCtx: StateCount[] | undefined, rollupState?: string | null): PrCheckRollup {
  let success = 0, failure = 0, skipped = 0, pending = 0;
  for (const c of [...(checkRun ?? []), ...(statusCtx ?? [])]) {
    const n = typeof c?.count === "number" && c.count > 0 ? c.count : 0;
    if (!n) continue;
    switch (COUNT_BUCKET[String(c.state ?? "").toUpperCase()] ?? "pending") {
      case "success": success += n; break;
      case "failure": failure += n; break;
      case "skipped": skipped += n; break;
      default: pending += n;
    }
  }
  const total = success + failure + skipped + pending;
  const st = String(rollupState ?? "").toUpperCase();
  const authoritative = st === "SUCCESS" || st === "FAILURE" || st === "ERROR" || st === "PENDING" || st === "EXPECTED";
  const allDone = authoritative ? (st === "SUCCESS" || st === "FAILURE" || st === "ERROR") : (total > 0 && pending === 0);
  const verdict = !allDone ? null : authoritative ? (st === "SUCCESS" ? "green" : "red") : (failure > 0 ? "red" : "green");
  return { total, success, failure, skipped, pending, allDone, verdict, failing: [] };
}

/**
 * Check rollups for a set of PRs in ONE GraphQL request — the aggregate counts,
 * not the full per-check list. This replaces the per-PR `gh pr view` fan-out
 * (one subprocess and ~0.8s each, ~40s for fifty); the same set is one process
 * and ~1 rate-limit point. Batching the FULL contexts is what 504'd, so the
 * counts field is exactly what makes batching viable. Keyed by number; a PR
 * absent from the answer (or a failed call) is simply left out, and its row
 * keeps saying "checks…" rather than claiming "no checks".
 */
async function fetchCheckRollups(repo: PrRepoId, numbers: number[]): Promise<Map<number, PrCheckRollup>> {
  const out = new Map<number, PrCheckRollup>();
  if (!numbers.length) return out;
  const [owner, name] = repo.nameWithOwner.split("/");
  // Numbers are integers straight off the list, and owner/name come from a
  // parsed remote (no quotes possible), so interpolating them as GraphQL
  // aliases/args is safe — there is no string a caller controls here.
  const field = `commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 0) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
    }
  } } } } }`;
  const body = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${field} }`).join("\n");
  const query = `query { repository(owner: "${owner}", name: "${name}") { ${body} } }`;
  const res = await ghJson<{ data?: { repository?: Record<string, any> } }>(["api", "graphql", "-f", `query=${query}`]);
  const repoData = res?.data?.repository;
  if (!repoData) return out;
  for (const n of numbers) {
    const pr = repoData[`p${n}`];
    if (!pr) continue;
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const ctx = rollup?.contexts;
    out.set(n, rollupFromCounts(ctx?.checkRunCountsByState, ctx?.statusContextCountsByState, rollup?.state));
  }
  return out;
}

function refreshChecks(repo: PrRepoId, filter: PrFilter, state: PrState, rows: PrSummary[], notify: boolean): void {
  const key = cacheKey(repo, filter, state);
  if (checkRunning.has(key)) return;
  checkRunning.add(key);

  void (async () => {
    try {
      const visible = rows.slice(0, CHECK_PROBE_MAX);
      // Cache hits (same `updatedAt`) cost nothing; only the misses are fetched.
      const rollups = new Map<number, PrCheckRollup>();
      const misses: number[] = [];
      for (const pr of visible) {
        const hit = checkCache.get(`${repo.key}\u0000${pr.number}`);
        if (hit && hit.updatedAt === pr.updatedAt) rollups.set(pr.number, hit.rollup);
        else misses.push(pr.number);
      }
      // One request for every miss, versus one subprocess per PR before.
      const fetched = await fetchCheckRollups(repo, misses);
      for (const pr of visible) {
        const roll = fetched.get(pr.number);
        if (!roll) continue; // absent from the answer - leave the row saying "checks..."
        checkCache.set(`${repo.key}\u0000${pr.number}`, { updatedAt: pr.updatedAt, rollup: roll });
        rollups.set(pr.number, roll);
      }

      // Fill every row that now has a rollup, in one pass. Re-read the entry: a
      // newer list may have replaced it while the fetch was in flight.
      const cur = listCache.get(key);
      if (!cur) return;
      const next = cur.prs.map((p) => (rollups.has(p.number) ? { ...p, checks: rollups.get(p.number)!, checksLoaded: true } : p));
      listCache.set(key, { ...cur, prs: next, checksPending: false });
      // Notify only for the filters the user has a stake in (never the
      // passively-warmed `all`, see #244). The latch dedupes, so a cache hit with
      // an unchanged verdict re-notifies nobody.
      if (notify) for (const pr of visible) { const r = rollups.get(pr.number); if (r) noteCi(repo, { ...pr, checks: r }); }
    } catch {
      const cur = listCache.get(key);
      if (cur) listCache.set(key, { ...cur, checksPending: false });
    } finally {
      checkRunning.delete(key);
    }
  })();
}

/** Refresh behind the response. Never awaited by a request handler. */
function refreshList(repo: PrRepoId, filter: PrFilter, state: PrState, after?: string, query?: string): void {
  const key = cacheKey(repo, filter, state, after, query);
  if (inflight.has(key)) return;
  inflight.add(key);
  const prev = listCache.get(key);
  const keep = (over: Partial<Entry>): Entry => ({
    at: prev?.at ?? 0, prs: prev?.prs ?? [], loading: true, checksPending: true, error: prev?.error, ...over,
  });
  listCache.set(key, keep({}));

  void (async () => {
    try {
      // Do not pay `gh auth status` (344ms) before every refresh. Trust the
      // last answer if there is one, and only block on a fresh check the very
      // first time — after that, a failed fetch is what tells us auth broke.
      const cap = ghCapabilityCached() ?? await ghCapability();
      if (!cap.available || !cap.authed) {
        listCache.set(key, keep({ at: Date.now(), loading: false, checksPending: false, error: cap.reason }));
        return;
      }

      // Rows and their check rollups, in one request.
      // Put the rows on screen the moment they arrive; the checks land a beat
      // later and only fill in the dots.
      const page = await fetchList(repo, filter, state, after, (early) => {
        listCache.set(key, {
          at: Date.now(), prs: early.rows, loading: false, checksPending: true,
          total: early.total, hasNext: early.hasNext, cursor: early.cursor,
        });
      }, query);
      if (page === null) {
        // gh itself failed (a network blip, a rate-limit) — far more likely than
        // a repository that lost every pull request, so keep whatever we had. But
        // DO advance `at`: leaving it stale re-runs gh on every single poll and
        // lets the "updated N ago" age climb without bound. A genuinely empty
        // answer is NOT this branch — `rows` is [] there, not null — so a PR that
        // merged or closed outside actually clears instead of lingering for ever.
        listCache.set(key, keep({ at: Date.now(), loading: false, checksPending: false }));
        return;
      }
      // The rollups arrived with the rows, so there is no second pass to wait
      // on and nothing to carry over. Feed the per-PR cache anyway: the detail
      // view and the notification latch both read it.
      for (const r of page.rows) checkCache.set(`${repo.key}\u0000${r.number}`, { updatedAt: r.updatedAt, rollup: r.checks });
      listCache.set(key, {
        at: Date.now(), prs: page.rows, loading: false, checksPending: false,
        total: page.total, hasNext: page.hasNext, cursor: page.cursor,
      });
      saveDiskCache();
      // Only open PRs raise CI notifications — a merged or closed PR's checks
      // are history, not something to alert on.
      if (state === "open" && ciNotifiesFor(filter)) for (const r of page.rows) noteCi(repo, r);
    } catch (e) {
      listCache.set(key, keep({ loading: false, checksPending: false, error: String(e) }));
    } finally {
      inflight.delete(key);
    }
  })();
}

/**
 * Exact counts for every saved view, in one request.
 *
 * The panel used to get these by fetching the OTHER scopes' lists in the
 * background — two extra full list queries, each costing what the visible one
 * costs, purely to put a number on a pill. `issueCount` with `first: 0` returns
 * the count and no rows, so all five arrive together for ~700ms and nothing is
 * fetched twice. They are also the TRUE totals: a count taken from the page on
 * screen stopped being the answer the moment the list got pages.
 */
const VIEW_COUNT_QUERY = `query($a:String!,$b:String!,$c:String!,$d:String!,$e:String!){
  review:search(query:$a,type:ISSUE,first:0){issueCount}
  mine:search(query:$b,type:ISSUE,first:0){issueCount}
  failing:search(query:$c,type:ISSUE,first:0){issueCount}
  ready:search(query:$d,type:ISSUE,first:0){issueCount}
  all:search(query:$e,type:ISSUE,first:0){issueCount}
}`;

export type PrViewCounts = { review: number; mine: number; failing: number; ready: number; all: number };
const countCache = new Map<string, { at: number; counts: PrViewCounts }>();
const COUNT_TTL_MS = 60_000;

export async function viewCounts(rootIn: unknown, stateIn: unknown): Promise<{ ok: boolean; counts?: PrViewCounts; error?: string }> {
  const state: PrState = stateIn === "closed" || stateIn === "all" ? stateIn : "open";
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const key = `${repo.key}|${state}`;
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return { ok: true, counts: hit.counts };
  const base = `repo:${repo.nameWithOwner} is:pr${state === "open" ? " is:open" : state === "closed" ? " is:closed" : ""}`;
  const res = await ghGraphql<any>(VIEW_COUNT_QUERY, {
    a: `${base} review-requested:@me`,
    b: `${base} author:@me`,
    c: `${base} status:failure`,
    d: `${base} review:approved status:success`,
    e: base,
  });
  const d = res?.data;
  if (!d) return { ok: false, error: "could not read the counts" };
  const counts: PrViewCounts = {
    review: Number(d.review?.issueCount ?? 0),
    mine: Number(d.mine?.issueCount ?? 0),
    failing: Number(d.failing?.issueCount ?? 0),
    ready: Number(d.ready?.issueCount ?? 0),
    all: Number(d.all?.issueCount ?? 0),
  };
  countCache.set(key, { at: Date.now(), counts });
  return { ok: true, counts };
}

/**
 * What `@` and `#` can complete to.
 *
 * Typing a mention or an issue reference by hand means leaving the panel to go
 * look the name up, which is the thing this is trying to avoid. Both lists are
 * small, change slowly, and are cached for a few minutes — the point is that
 * the dropdown is instant, not that it is live to the second.
 */
export type PrMentions = { users: string[]; issues: { number: number; title: string }[] };
const mentionCache = new Map<string, { at: number; data: PrMentions }>();
const MENTION_TTL_MS = 5 * 60_000;

export async function mentionables(rootIn: unknown): Promise<{ ok: boolean; data?: PrMentions; error?: string }> {
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const hit = mentionCache.get(repo.key);
  if (hit && Date.now() - hit.at < MENTION_TTL_MS) return { ok: true, data: hit.data };
  const [collab, issues] = await Promise.all([
    ghJson<any[]>(["api", `repos/${repo.nameWithOwner}/collaborators?per_page=100`]),
    ghJson<any[]>(["api", `repos/${repo.nameWithOwner}/issues?state=all&per_page=50&sort=updated`]),
  ]);
  const data: PrMentions = {
    users: (collab ?? []).map((c: any) => String(c?.login ?? "")).filter(Boolean),
    issues: (issues ?? [])
      .filter((i: any) => typeof i?.number === "number")
      .map((i: any) => ({ number: i.number, title: String(i.title ?? "") })),
  };
  mentionCache.set(repo.key, { at: Date.now(), data });
  return { ok: true, data };
}

/**
 * What the facet menus can offer, taken from the repository rather than the
 * page on screen.
 *
 * This is the fix for a menu that listed three authors because three authors
 * happened to appear in the first twenty-five rows — with pages, anything
 * derived from the loaded rows is a sample, not a set. Cached for a few
 * minutes: labels and milestones change on a human timescale.
 */
export type PrFacetOptions = {
  authors: string[];
  assignees: string[];
  labels: { name: string; color: string }[];
  milestones: string[];
  bases: string[];
};
const facetCache = new Map<string, { at: number; data: PrFacetOptions }>();
const FACET_TTL_MS = 5 * 60_000;

export async function facetOptions(rootIn: unknown): Promise<{ ok: boolean; data?: PrFacetOptions; error?: string }> {
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const hit = facetCache.get(repo.key);
  if (hit && Date.now() - hit.at < FACET_TTL_MS) return { ok: true, data: hit.data };
  const r = repo.nameWithOwner;
  const [contribs, assignees, labels, milestones, branches] = await Promise.all([
    ghJson<any[]>(["api", `repos/${r}/contributors?per_page=100`]),
    ghJson<any[]>(["api", `repos/${r}/assignees?per_page=100`]),
    ghJson<any[]>(["api", `repos/${r}/labels?per_page=100`]),
    ghJson<any[]>(["api", `repos/${r}/milestones?state=all&per_page=100`]),
    ghJson<any[]>(["api", `repos/${r}/branches?per_page=100`]),
  ]);
  const data: PrFacetOptions = {
    authors: (contribs ?? []).map((c: any) => String(c?.login ?? "")).filter(Boolean),
    assignees: (assignees ?? []).map((a: any) => String(a?.login ?? "")).filter(Boolean),
    labels: (labels ?? []).map((l: any) => ({ name: String(l?.name ?? ""), color: String(l?.color ?? "") })).filter((l) => l.name),
    milestones: (milestones ?? []).map((m: any) => String(m?.title ?? "")).filter(Boolean),
    bases: (branches ?? []).map((b: any) => String(b?.name ?? "")).filter(Boolean),
  };
  facetCache.set(repo.key, { at: Date.now(), data });
  return { ok: true, data };
}

/**
 * The checkout's current branch, cached briefly.
 *
 * `git rev-parse` ran on every single list read — a process spawn on the 20s
 * poll, for a value that only changes when somebody checks out. Five seconds is
 * short enough that switching branches still lights up "you are here" almost at
 * once, and long enough that the poll costs nothing.
 */
const headCache = new Map<string, { at: number; head: string }>();
const HEAD_TTL_MS = 5_000;
async function headBranch(root: string): Promise<string> {
  const hit = headCache.get(root);
  if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.head;
  const r = await gitAsync(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = r.code === 0 ? r.stdout.trim() : "";
  headCache.set(root, { at: Date.now(), head });
  return head;
}

/**
 * The panel's read. Answers from cache and triggers a refresh if the copy is
 * old — so the poll never waits on the network, and the age is shown rather
 * than hidden behind a spinner that lies.
 */
export async function listPrs(rootIn: unknown, filterIn: unknown, stateIn: unknown, force = false, afterIn?: unknown, queryIn?: unknown): Promise<PrListResponse> {
  const filter: PrFilter = filterIn === "review" || filterIn === "all" ? filterIn : "mine";
  const state: PrState = stateIn === "closed" || stateIn === "all" ? stateIn : "open";
  // A cursor is opaque base64 from GitHub; anything else is not ours to send on.
  const after = typeof afterIn === "string" && /^[A-Za-z0-9+/=_-]{1,200}$/.test(afterIn) ? afterIn : undefined;
  // The panel's filter text, kept whole: searchExpr decides what of it is a
  // qualifier and what is somebody's words.
  const query = typeof queryIn === "string" ? queryIn.slice(0, 400) : undefined;
  const repo = await repoIdFor(rootIn);
  if (!repo) {
    const cap = await ghCapability();
    return {
      ok: true, repo: null, prs: [], fetchedAt: 0, stale: false, loading: false,
      needsAuth: !cap.available || !cap.authed,
      error: !cap.available || !cap.authed ? cap.reason : "no GitHub remote on this repository",
    };
  }
  const key = cacheKey(repo, filter, state, after, query);
  const hit = listCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (force || !hit || age > LIST_TTL_MS) refreshList(repo, filter, state, after, query);
  const cur = listCache.get(key);

  // "you are here" — the checkout's branch, matched against the PR heads. This
  // is the branch/PR link, and it falls out of the dedupe rather than costing
  // a call of its own.
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  const head = root ? await headBranch(root) : "";
  const prs = (cur?.prs ?? []).map((p) => (p.headRefName && p.headRefName === head ? { ...p, isCurrentBranch: true } : p));

  // Never block the read on it. With rows already in hand (from the disk cache
  // at boot, or a previous refresh) waiting 344ms on `gh auth status` only
  // delays showing them; if auth really is broken the refresh behind this
  // response says so, and the next poll reports it. Only a first read with
  // nothing to show waits.
  let cap = ghCapabilityCached();
  if (!cap) {
    if (cur?.prs.length) void ghCapability();
    else cap = await ghCapability();
  }
  return {
    ok: true,
    repo,
    prs,
    fetchedAt: cur?.at ?? 0,
    stale: !cur?.at || Date.now() - (cur?.at ?? 0) > LIST_TTL_MS,
    loading: !!cur?.loading,
    checksPending: !!cur?.checksPending,
    error: cur?.error,
    // Unknown yet (the check runs behind an already-cached list) is not the
    // same as "not logged in" — claiming the latter would put a "run gh auth
    // login" banner over rows that are plainly on screen.
    needsAuth: cap ? !cap.available || !cap.authed : false,
    // What the panel needs to offer a second page: how many there are in total,
    // whether another page exists, and the cursor that fetches it.
    total: cur?.total,
    hasNext: !!cur?.hasNext,
    cursor: cur?.cursor ?? null,
    pageSize: LIST_PAGE,
  };
}

// ---------------------------------------------------------------------------
// bot noise
// ---------------------------------------------------------------------------

const BOT_RE = /\[bot\]$|^(github-actions|dependabot|codecov|sonarcloud|claude)$/i;
export const isBotLogin = (login: string): boolean => BOT_RE.test(login || "");

/**
 * Reduce a machine comment to the few numbers a person reads.
 *
 * A real coverage comment on a real PR is 46,551 characters — one table, 1,847
 * rows, and about three figures anyone looks at. The raw text is kept; this
 * only decides what is shown first.
 */
export function digestBotComment(body: string): string | null {
  // These arrive as HTML tables, so tags and entities come off first — the
  // fallback below otherwise reports `<a href=...><img alt="Coverage"` as if it
  // were the summary.
  const text = (body || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&#46;/g, ".")
    .replace(/&amp;/g, "&");

  const bits: string[] = [];

  // "Coverage (django) ... TOTAL 1829 315 82%" — the whole-project number, and
  // the scope, which is the only reason two of these comments differ.
  const scope = text.match(/Coverage\s*\(([^)]+)\)/i)?.[1]?.trim();
  const total = text.match(/TOTAL[^%]*?(\d{1,3}(?:\.\d+)?)\s*%/i);
  if (total) bits.push(`${scope ? `${scope} ` : ""}coverage ${total[1]}%`);

  // "## Patch coverage . django" — the number that actually gates a review.
  if (/Patch coverage/i.test(text)) {
    const patchScope = text.match(/Patch coverage\s*[.·]\s*(\S+)/i)?.[1];
    if (/No lines with coverage information/i.test(text)) {
      bits.push(`${patchScope ? `${patchScope} ` : ""}patch: nothing measurable`);
    } else {
      const pcts = [...text.matchAll(/\((\d{1,3}(?:\.\d+)?)%\)/g)].map((m) => Number(m[1]));
      if (pcts.length) {
        const worst = Math.min(...pcts);
        bits.push(`${patchScope ? `${patchScope} ` : ""}patch ${worst === 100 ? "100%" : `${worst}%..100%`} over ${pcts.length} file${pcts.length === 1 ? "" : "s"}`);
      }
    }
  }

  const failed = text.match(/(\d+)\s+failed/i);
  if (failed) bits.push(`${failed[1]} failed`);

  if (bits.length) return bits.join(" · ");

  // Nothing recognised: the first line with words in it beats showing a table.
  const first = text.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l && !l.startsWith("|") && !l.startsWith("#") && /[a-z]{3}/i.test(l));
  return first ? first.replace(/\s+/g, " ").slice(0, 140) : null;
}

/**
 * Checklist boxes out of a PR body. Unchecked ones are a merge signal on any
 * repo whose template carries a real checklist.
 *
 * Split on `\r?\n`, and it matters: GitHub stores bodies with CRLF endings, and
 * in a JavaScript regex `.` excludes every line terminator — `\r` among them.
 * So `(.*)$` cannot match a line that ends in `\r`, and a naive split on `\n`
 * finds exactly zero checkboxes in a real pull request while passing every test
 * written with a `\n` fixture. Measured on a live PR: nine boxes, none found.
 */
export function parseChecklist(body: string): PrChecklistItem[] {
  const out: PrChecklistItem[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    out.push({ checked: m[1]!.toLowerCase() === "x", text: m[2]!.trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------

// Everything the detail view renders, in one request.
//
// `reactionGroups`, `lastEditedAt`, `authorAssociation` and `viewerDidAuthor`
// ride along on every authored thing — they are what turn a wall of text into
// a conversation you can read and answer (who has standing, what was edited,
// what people already said with an emoji rather than another paragraph).
//
// Note `comments(last:…)`: GraphQL's `first:` is oldest-first, so a PR with
// more comments than the page size lost its NEWEST ones — the opposite of what
// anyone wants from a conversation. `last:` keeps the recent end.
const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge
    pullRequest(number:$number){
    id number title url state isDraft createdAt updatedAt closedAt mergedAt
    additions deletions changedFiles totalCommentsCount
    baseRefName headRefName body
    headRepositoryOwner{login}
    mergeable mergeStateStatus reviewDecision viewerDidAuthor viewerCanUpdate
    author{login}
    mergedBy{login}
    reactionGroups{content viewerHasReacted users{totalCount}}
    labels(first:50){nodes{name color}}
    milestone{title}
    closingIssuesReferences(first:10){nodes{number title url state}}
    participants(first:30){nodes{login}}
    autoMergeRequest{enabledBy{login} mergeMethod}
    assignees(first:20){nodes{login}}
    reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
    reviews(last:60){nodes{
      id author{login} state body submittedAt url lastEditedAt authorAssociation viewerDidAuthor
      reactionGroups{content viewerHasReacted users{totalCount}}
    }}
    comments(last:80){nodes{
      id databaseId author{login} body createdAt url lastEditedAt authorAssociation viewerDidAuthor
      reactionGroups{content viewerHasReacted users{totalCount}}
    }}
    commits(last:100){nodes{commit{
      oid message committedDate parents{totalCount}
      author{user{login} name}
      authors(first:8){nodes{user{login} name}}
      signature{isValid state}
      statusCheckRollup{state}
    }}}
    files(first:100){nodes{path additions deletions changeType viewerViewedState}}
    reviewThreads(first:80){nodes{
      id isResolved isOutdated path line startLine
      comments(first:50){nodes{
        id databaseId author{login} body createdAt url diffHunk originalLine
        lastEditedAt authorAssociation viewerDidAuthor
        reactionGroups{content viewerHasReacted users{totalCount}}
      }}
    }}
    timelineItems(last:80, itemTypes:[
      HEAD_REF_FORCE_PUSHED_EVENT, RENAMED_TITLE_EVENT, LABELED_EVENT, UNLABELED_EVENT,
      ASSIGNED_EVENT, UNASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT,
      READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT,
      CROSS_REFERENCED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, HEAD_REF_DELETED_EVENT,
      AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT
    ]){nodes{
      __typename
      ... on HeadRefForcePushedEvent{createdAt actor{login} beforeCommit{oid} afterCommit{oid}}
      ... on RenamedTitleEvent{createdAt actor{login} previousTitle currentTitle}
      ... on LabeledEvent{createdAt actor{login} label{name color}}
      ... on UnlabeledEvent{createdAt actor{login} label{name color}}
      ... on AssignedEvent{createdAt actor{login} assignee{... on User{login}}}
      ... on UnassignedEvent{createdAt actor{login} assignee{... on User{login}}}
      ... on ReviewRequestedEvent{createdAt actor{login} requestedReviewer{... on User{login} ... on Team{name}}}
      ... on ReviewRequestRemovedEvent{createdAt actor{login} requestedReviewer{... on User{login} ... on Team{name}}}
      ... on ReadyForReviewEvent{createdAt actor{login}}
      ... on ConvertToDraftEvent{createdAt actor{login}}
      ... on MergedEvent{createdAt actor{login} mergeRefName commit{oid} url}
      ... on ClosedEvent{createdAt actor{login} url}
      ... on ReopenedEvent{createdAt actor{login}}
      ... on CrossReferencedEvent{createdAt actor{login} source{
        ... on PullRequest{number title url} ... on Issue{number title url}
      }}
      ... on MilestonedEvent{createdAt actor{login} milestoneTitle}
      ... on DemilestonedEvent{createdAt actor{login} milestoneTitle}
      ... on HeadRefDeletedEvent{createdAt actor{login} headRefName}
      ... on AutoMergeEnabledEvent{createdAt actor{login}}
      ... on AutoMergeDisabledEvent{createdAt actor{login} reason}
    }}
    statusCheckRollup:commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
      __typename
      ... on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
      ... on StatusContext{context state targetUrl}
    }}}}}}
  } } }`;

/** The reaction tallies, "edited", standing and ownership that ride on
 *  everything a person wrote. Shared by comments, reviews and thread replies so
 *  the three can never drift apart. */
function authoredOf(n: any): Partial<PrAuthored> {
  const reactions: PrReaction[] = (n?.reactionGroups || [])
    .map((g: any) => ({
      content: String(g?.content || ""),
      count: Number(g?.users?.totalCount ?? 0),
      viewerHasReacted: !!g?.viewerHasReacted,
    }))
    // Only what somebody actually pressed: GitHub returns all eight groups with
    // zeroes, and rendering eight empty buttons on every comment is noise.
    .filter((r: PrReaction) => r.count > 0 || r.viewerHasReacted);
  return {
    reactions,
    editedAt: n?.lastEditedAt ?? null,
    association: n?.authorAssociation ?? undefined,
    viewerDidAuthor: !!n?.viewerDidAuthor,
  };
}

const ACTOR = (n: any) => n?.actor?.login || "";
const REVIEWER = (n: any) => n?.requestedReviewer?.login || n?.requestedReviewer?.name || "";

/**
 * The conversation's non-comment events, in the shape the panel renders.
 *
 * GitHub interleaves these with comments, and without them a conversation reads
 * as if nothing happened between remarks — the force-push that invalidated a
 * review, the rename, the label, the merge itself all vanish. Unknown types are
 * dropped rather than guessed at.
 */
function mapTimeline(nodes: any[]): PrEvent[] {
  const out: PrEvent[] = [];
  for (const n of nodes || []) {
    const at = n?.createdAt || "";
    const actor = ACTOR(n);
    const base = { at, actor };
    switch (n?.__typename) {
      case "HeadRefForcePushedEvent":
        out.push({ ...base, kind: "force-push", detail: `${(n.beforeCommit?.oid || "").slice(0, 7)} → ${(n.afterCommit?.oid || "").slice(0, 7)}` });
        break;
      case "RenamedTitleEvent":
        out.push({ ...base, kind: "renamed", detail: n.currentTitle || "" });
        break;
      case "LabeledEvent":
        out.push({ ...base, kind: "labeled", detail: n.label?.name || "", tint: n.label?.color || null });
        break;
      case "UnlabeledEvent":
        out.push({ ...base, kind: "unlabeled", detail: n.label?.name || "", tint: n.label?.color || null });
        break;
      case "AssignedEvent":
        out.push({ ...base, kind: "assigned", detail: n.assignee?.login || "" });
        break;
      case "UnassignedEvent":
        out.push({ ...base, kind: "unassigned", detail: n.assignee?.login || "" });
        break;
      case "ReviewRequestedEvent":
        out.push({ ...base, kind: "review-requested", detail: REVIEWER(n) });
        break;
      case "ReviewRequestRemovedEvent":
        out.push({ ...base, kind: "review-request-removed", detail: REVIEWER(n) });
        break;
      case "ReadyForReviewEvent": out.push({ ...base, kind: "ready-for-review" }); break;
      case "ConvertToDraftEvent": out.push({ ...base, kind: "convert-to-draft" }); break;
      case "MergedEvent":
        out.push({ ...base, kind: "merged", detail: n.mergeRefName || "", url: n.url || undefined });
        break;
      case "ClosedEvent": out.push({ ...base, kind: "closed", url: n.url || undefined }); break;
      case "ReopenedEvent": out.push({ ...base, kind: "reopened" }); break;
      case "CrossReferencedEvent": {
        const s = n.source || {};
        if (s.number) out.push({ ...base, kind: "cross-referenced", detail: `#${s.number} ${s.title || ""}`.trim(), url: s.url || undefined });
        break;
      }
      case "MilestonedEvent": out.push({ ...base, kind: "milestoned", detail: n.milestoneTitle || "" }); break;
      case "DemilestonedEvent": out.push({ ...base, kind: "demilestoned", detail: n.milestoneTitle || "" }); break;
      case "HeadRefDeletedEvent": out.push({ ...base, kind: "head-ref-deleted", detail: n.headRefName || "" }); break;
      case "AutoMergeEnabledEvent": out.push({ ...base, kind: "auto-merge-enabled" }); break;
      case "AutoMergeDisabledEvent": out.push({ ...base, kind: "auto-merge-disabled", detail: n.reason || "" }); break;
      default: break; // a type we do not render yet; dropping beats guessing
    }
  }
  return out.filter((e) => e.at).sort((a, b) => a.at.localeCompare(b.at));
}

const detailCache = new Map<string, { at: number; detail: PrDetail }>();
const DETAIL_TTL_MS = 45_000;

/**
 * The detail cache, kept across restarts — the same trade the list already
 * makes, for the same reason.
 *
 * The list survives a restart and the detail did not, so opening the pull
 * request you were reading five minutes ago cost the full round trip again:
 * ~280ms before GitHub does anything, and the detail query a good deal more.
 * Every restart started from nothing on the one page you were most likely to
 * open first.
 *
 * Past its TTL the cached copy is now handed back AT ONCE, marked stale, and a
 * refresh runs behind it — rows you can read beat a spinner you cannot, and the
 * panel already says how old what it is showing is. The one thing that must not
 * act on a stale copy is the merge, and it does not: `gh pr merge` carries
 * `--match-head-commit`, so a merge aimed at a head that has moved is refused
 * by GitHub rather than landing on the wrong commit.
 */
const DETAIL_FILE = join(CACHE_DIR, "pr-detail.json");
/** Enough for a day's reading, not a mirror of the repository. Each entry is a
 *  few tens of KB — comments, reviews, threads, files, checks. */
const DETAIL_MAX_ENTRIES = 24;
let detailWriteTimer: ReturnType<typeof setTimeout> | null = null;
/** Refreshes already running, so ten glances at a stale card make one call. */
const detailInflight = new Set<string>();

function loadDetailCache(): void {
  try {
    if (!existsSync(DETAIL_FILE)) return;
    const raw = JSON.parse(readFileSync(DETAIL_FILE, "utf8")) as Record<string, { at: number; detail: PrDetail }>;
    for (const [k, e] of Object.entries(raw)) {
      // `at` is kept as it was: the age on screen stays honest and the first
      // read is a stale hit, which is what triggers the refresh.
      if (e && typeof e.at === "number" && e.detail && typeof e.detail.number === "number") detailCache.set(k, e);
    }
  } catch { /* unreadable or from an older shape — start empty */ }
}

function saveDetailCache(): void {
  if (detailWriteTimer) clearTimeout(detailWriteTimer);
  detailWriteTimer = setTimeout(() => {
    try {
      const entries = [...detailCache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, DETAIL_MAX_ENTRIES);
      mkdirSync(dirname(DETAIL_FILE), { recursive: true });
      writeFileSync(DETAIL_FILE, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* a cache that cannot be written is not an error worth raising */ }
  }, 1_000);
}

loadDetailCache();

/** GitHub's own precedence. Its merge button arrives checked on the first of
 *  these the repository allows, which is what somebody means when they say
 *  "we just press the blue button". */
const METHOD_FIELD: [PrMergeMethod, string][] = [
  ["merge", "mergeCommitAllowed"],
  ["squash", "squashMergeAllowed"],
  ["rebase", "rebaseMergeAllowed"],
];

/**
 * What the repository allows, asked rather than assumed.
 *
 * When the repository node carries none of the flags — an older cached shape,
 * a host that does not answer them — the fallback is all three rather than
 * none. An empty menu would take away methods that do work; offering one the
 * repository forbids only costs the error gh already returns.
 */
export function mergePolicyOf(r: any): PrMergePolicy {
  const allowed = METHOD_FIELD.filter(([, f]) => r?.[f] === true).map(([m]) => m);
  return {
    allowed: allowed.length ? allowed : METHOD_FIELD.map(([m]) => m),
    auto: r?.autoMergeAllowed === true,
    deletesBranch: r?.deleteBranchOnMerge === true,
  };
}

function mergeStateOf(s: string | undefined, isDraft: boolean): PrMergeState {
  if (isDraft) return "DRAFT";
  const v = (s || "").toUpperCase();
  const known: PrMergeState[] = ["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "HAS_HOOKS"];
  return (known as string[]).includes(v) ? (v as PrMergeState) : "UNKNOWN";
}

export async function prDetail(rootIn: unknown, numberIn: unknown, force = false): Promise<{ ok: boolean; detail?: PrDetail; error?: string; stale?: boolean }> {
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const key = `${repo.key}#${number}`;
  const hit = detailCache.get(key);
  if (!force && hit && Date.now() - hit.at < DETAIL_TTL_MS) return { ok: true, detail: hit.detail };
  /*
   * Stale, but on screen now.
   *
   * Past the TTL there IS an answer — it is simply old — and handing it back
   * while a refresh runs behind it is the difference between a page that paints
   * instantly and one that waits on the internet. This is what makes the disk
   * cache worth keeping: after a restart the first read is always past the TTL,
   * and without this the whole thing would be a file nobody ever reads from.
   *
   * `stale` travels with it so the caller knows to come back for the fresh one
   * rather than trusting a five-minute-old merge state indefinitely.
   */
  if (!force && hit) {
    if (!detailInflight.has(key)) {
      detailInflight.add(key);
      void prDetail(rootIn, number, true).catch(() => {}).finally(() => detailInflight.delete(key));
    }
    return { ok: true, detail: hit.detail, stale: true };
  }

  const cap = await ghCapability();
  if (!cap.available || !cap.authed) return { ok: false, error: cap.reason };

  const viewerLogin = cap.login || "";
  const data = await ghJson<any>([
    "api", "graphql",
    "-f", `query=${DETAIL_QUERY}`,
    "-F", `owner=${repo.owner}`,
    "-F", `name=${repo.name}`,
    "-F", `number=${number}`,
  ]);
  const p = data?.data?.repository?.pullRequest;
  if (!p) return { ok: false, error: "pull request not found, or gh could not reach the host" };
  const mergePolicy = mergePolicyOf(data?.data?.repository);

  const rawChecks = p.statusCheckRollup?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const normalised = rawChecks.map((c: any) => ({
    ...c,
    workflowName: c.checkSuite?.workflowRun?.workflow?.name || "",
  }));
  const { rollup, all } = rollupChecks(normalised);

  const reviews: PrReview[] = (p.reviews?.nodes || []).map((r: any) => ({
    author: r.author?.login || "",
    isBot: isBotLogin(r.author?.login || ""),
    state: r.state,
    body: r.body || "",
    submittedAt: r.submittedAt || "",
    url: r.url || "",
    nodeId: r.id || "",
    ...authoredOf(r),
  }));

  const comments: PrComment[] = (p.comments?.nodes || []).map((c: any) => {
    const author = c.author?.login || "";
    const bot = isBotLogin(author);
    return {
      id: c.databaseId,
      nodeId: c.id || "",
      author,
      isBot: bot,
      body: c.body || "",
      createdAt: c.createdAt || "",
      url: c.url || "",
      digest: bot ? digestBotComment(c.body || "") : null,
      ...authoredOf(c),
    };
  });

  const threads: PrThread[] = (p.reviewThreads?.nodes || []).map((t: any) => ({
    id: t.id,
    path: t.path || "",
    line: t.line ?? null,
    startLine: t.startLine ?? null,
    isResolved: !!t.isResolved,
    isOutdated: !!t.isOutdated,
    // The hunk GitHub stored with the comment, not one reconstructed from the
    // pull request's diff. It arrives with the thread, so the code a comment is
    // about is on screen without the diff having been fetched at all — and it
    // is the same few lines GitHub shows, including on an outdated thread whose
    // hunk no longer exists in the current diff.
    diffHunk: t.comments?.nodes?.[0]?.diffHunk || "",
    originalLine: t.comments?.nodes?.[0]?.originalLine ?? null,
    url: t.comments?.nodes?.[0]?.url || "",
    comments: (t.comments?.nodes || []).map((c: any) => ({
      id: c.id,
      databaseId: c.databaseId ?? null,
      author: c.author?.login || "",
      isBot: isBotLogin(c.author?.login || ""),
      body: c.body || "",
      createdAt: c.createdAt || "",
      url: c.url || "",
      ...authoredOf(c),
    })),
  }));

  const commits: PrCommit[] = (p.commits?.nodes || []).map((n: any) => {
    const c = n.commit || {};
    // Everyone credited, in order, deduped. A commit written with an agent
    // carries a Co-authored-by trailer, and GitHub says "X and claude
    // committed" — naming only the first author hides half of who wrote it.
    const authors: string[] = [];
    for (const a of c.authors?.nodes || []) {
      const who = a?.user?.login || a?.name || "";
      if (who && !authors.includes(who)) authors.push(who);
    }
    return {
      // Split the FULL message ourselves. `messageHeadline` is GitHub's own
      // truncation — it cuts the subject at ~70 characters with an ellipsis and
      // puts the remainder at the front of `messageBody`, so using the pair
      // renders a chopped subject and an orphan fragment underneath it.
      oid: c.oid || "",
      short: (c.oid || "").slice(0, 8),
      message: String(c.message || "").split("\n")[0] ?? "",
      body: String(c.message || "").split("\n").slice(1).join("\n").trim(),
      author: c.author?.user?.login || c.author?.name || "",
      authors,
      committedAt: c.committedDate || "",
      // A signature GitHub could verify. The badge is the whole point: it says
      // this commit is from who it claims to be from.
      verified: !!c.signature?.isValid,
      checks: c.statusCheckRollup?.state ?? null,
      // A trunk catch-up merge is not work to review. Naming it lets the UI
      // dim it instead of making you read it.
      isMerge: (c.parents?.totalCount ?? 1) > 1,
    };
  });

  const openByPath = new Map<string, number>();
  for (const t of threads) if (!t.isResolved) openByPath.set(t.path, (openByPath.get(t.path) ?? 0) + 1);

  const files: PrFile[] = (p.files?.nodes || []).map((f: any) => ({
    path: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    // Lowercased on purpose: GraphQL says `MODIFIED`, and the panel's "only
    // chip it when it is not a plain modification" test compares against
    // "modified" — so every single file was wearing a MODIFIED badge.
    status: String(f.changeType || "").toLowerCase(),
    comments: openByPath.get(f.path) ?? 0,
    // GitHub's own per-reviewer tick, so "viewed" survives leaving the panel
    // and agrees with what github.com shows.
    viewed: f.viewerViewedState === "VIEWED",
  }));

  const timeline = mapTimeline(p.timelineItems?.nodes || []);

  // A force-push after a submitted review makes that review stale — the
  // approval you are looking at was for code that no longer exists.
  const pushes: string[] = timeline.filter((e) => e.kind === "force-push").map((e) => e.at);
  const lastReviewAt = reviews.length ? reviews[reviews.length - 1]!.submittedAt : "";
  const forcePushedSinceReview = !!lastReviewAt && pushes.some((at) => at > lastReviewAt);

  const detail: PrDetail = {
    number: p.number,
    title: p.title || "",
    author: p.author?.login || "",
    state: p.state,
    isDraft: !!p.isDraft,
    headRefName: p.headRefName || "",
    baseRefName: p.baseRefName || "",
    url: p.url || "",
    updatedAt: p.updatedAt || "",
    reviewDecision: p.reviewDecision || null,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changedFiles ?? 0,
    labels: (p.labels?.nodes || []).map((l: any) => ({ name: l.name, color: l.color })),
    milestone: p.milestone?.title || null,
    checks: rollup,
    checksAll: all,
    body: p.body || "",
    mergeable: p.mergeable || "UNKNOWN",
    mergeState: mergeStateOf(p.mergeStateStatus, !!p.isDraft),
    checklist: parseChecklist(p.body || ""),
    reviewers: mapReviewers(p.reviewRequests?.nodes),
    assignees: (p.assignees?.nodes || []).map((n: any) => n.login),
    reviews, comments, threads, commits, files,
    forcePushedSinceReview,
    // Who you are on this pull request. Offering "approve" on your own work is
    // a control GitHub does not give you either, and a review button on every
    // row makes the ones that are actually waiting on you invisible.
    viewerDidAuthor: !!p.viewerDidAuthor,
    viewerRequested: (p.reviewRequests?.nodes || [])
      .some((n: any) => (n.requestedReviewer?.login || "") === viewerLogin && !!viewerLogin),
    timeline,
    participants: (p.participants?.nodes || []).map((n: any) => n?.login).filter(Boolean),
    bodyReactions: authoredOf(p).reactions ?? [],
    nodeId: p.id || "",
    // Deliberately not fetched: `projectsV2` needs the `read:project` scope,
    // which a normal `gh auth login` token does not carry — asking for it makes
    // the WHOLE query fail with INSUFFICIENT_SCOPES and the panel shows nothing.
    // A projects column is not worth costing everyone their pull requests.
    projects: [],
    linkedIssues: (p.closingIssuesReferences?.nodes || [])
      .filter((n: any) => n?.number)
      .map((n: any) => ({ number: n.number, title: n.title || "", url: n.url || "", state: n.state || "" })),
    autoMerge: p.autoMergeRequest
      ? { enabledBy: p.autoMergeRequest.enabledBy?.login || "", method: p.autoMergeRequest.mergeMethod || "" }
      : null,
    mergedBy: p.mergedBy?.login || null,
    mergedAt: p.mergedAt || null,
    closedAt: p.closedAt || null,
    createdAt: p.createdAt || "",
    viewerCanUpdate: !!p.viewerCanUpdate,
    mergePolicy,
    headRepoOwner: p.headRepositoryOwner?.login || "",
    // Say what a page size cut off, rather than letting it disappear. The file
    // list disagreeing with the header count is how nobody noticed for months.
    // Only claim truncation when a page came back FULL — that is the one
    // unambiguous signal there is more. Subtracting counts that measure
    // different things (totalCommentsCount includes review bodies) invents a
    // "1 more comment" that does not exist, and a lying badge is worse than
    // none. `files` is the exception: `changedFiles` is an exact total.
    truncated: {
      files: Math.max(0, (p.changedFiles ?? 0) - files.length) || undefined,
      commits: (p.commits?.nodes || []).length >= 100 ? 100 : undefined,
      comments: comments.length >= 80 ? 80 : undefined,
      threads: (p.reviewThreads?.nodes || []).length >= 80 ? 80 : undefined,
      checks: rawChecks.length >= 100 ? 100 : undefined,
    },
  };

  detailCache.set(key, { at: Date.now(), detail });
  saveDetailCache();
  return { ok: true, detail };
}

/** The unified diff, straight into the diff renderer the app already has. */
/*
 * The diff of a pull request, which was the last thing here still fetched from
 * nothing every single time.
 *
 * `gh pr diff` is another round trip to GitHub, and opening a pull request you
 * read ten minutes ago paid it again — for bytes that, on a merged or quiet
 * branch, cannot have changed at all. The list has been cached across restarts
 * for exactly this reason and the detail now is too; this is the same trade,
 * one layer down.
 *
 * Bounded by BYTES rather than by entries, and that is the whole reason the
 * cache is here rather than in the browser: a diff is not a row, it is however
 * large somebody's pull request happens to be, and twelve of them chosen by
 * count could be sixty megabytes chosen by accident. A single diff past the
 * budget is served and not kept — caching it would evict everything else to
 * hold one thing nobody re-opens.
 */
type DiffEntry = { at: number; text: string };
const diffCache = new Map<string, DiffEntry>();
const diffInflight = new Map<string, Promise<{ ok: boolean; text?: string; error?: string }>>();
/** Long, because a diff only changes when somebody pushes — and when they do,
 *  the list poll notices and the panel re-reads. */
const DIFF_TTL_MS = 5 * 60_000;
const DIFF_BUDGET = 24 * 1024 * 1024;
const DIFF_MAX_ONE = 6 * 1024 * 1024;

/**
 * The diffs, kept across restarts — a much smaller shelf than the memory one.
 *
 * In memory this holds 24MB because it can. On disk it holds a few of the most
 * recent, because the point is narrow: the pull request you were reading when
 * you closed the app is the one you open when you reopen it, and reading its
 * Files tab should not start with a `gh pr diff` on a cold process. Anything
 * beyond that is a mirror of the repository nobody asked for.
 *
 * Written debounced and never on the read path, so a slow disk cannot make a
 * diff arrive later than it would have.
 */
const DIFF_FILE = join(CACHE_DIR, "pr-diff.json");
const DIFF_DISK_BUDGET = 4 * 1024 * 1024;
let diffWriteTimer: ReturnType<typeof setTimeout> | null = null;

function loadDiffCache(): void {
  try {
    if (!existsSync(DIFF_FILE)) return;
    const raw = JSON.parse(readFileSync(DIFF_FILE, "utf8")) as Record<string, DiffEntry>;
    for (const [k, e] of Object.entries(raw)) {
      if (e && typeof e.at === "number" && typeof e.text === "string") diffCache.set(k, e);
    }
  } catch { /* unreadable or from an older shape — start empty */ }
}

function saveDiffCache(): void {
  if (diffWriteTimer) clearTimeout(diffWriteTimer);
  diffWriteTimer = setTimeout(() => {
    try {
      const out: Record<string, DiffEntry> = {};
      let held = 0;
      // Newest first, and stop at the budget rather than trimming afterwards:
      // the file should be small by construction, not by cleanup.
      for (const [k, e] of [...diffCache.entries()].sort((a, b) => b[1].at - a[1].at)) {
        if (held + e.text.length > DIFF_DISK_BUDGET) break;
        out[k] = e;
        held += e.text.length;
      }
      mkdirSync(dirname(DIFF_FILE), { recursive: true });
      writeFileSync(DIFF_FILE, JSON.stringify(out));
    } catch { /* a cache that cannot be written is not an error worth raising */ }
  }, 2_000);
}

loadDiffCache();

function keepDiff(key: string, text: string): void {
  if (text.length > DIFF_MAX_ONE) return;
  diffCache.delete(key);
  diffCache.set(key, { at: Date.now(), text });
  let held = 0;
  for (const e of diffCache.values()) held += e.text.length;
  // Oldest first, which is insertion order — and re-reading re-inserts, so the
  // one you keep coming back to is the last to go.
  for (const k of diffCache.keys()) {
    if (held <= DIFF_BUDGET) break;
    held -= diffCache.get(k)!.text.length;
    diffCache.delete(k);
  }
  saveDiffCache();
}

function fetchDiff(key: string, number: number, nameWithOwner: string) {
  const running = diffInflight.get(key);
  if (running) return running;
  const p = gh(["pr", "diff", String(number), "-R", nameWithOwner])
    .then((r) => {
      if (r.code !== 0) return { ok: false as const, error: r.stderr.trim() || "gh pr diff failed" };
      keepDiff(key, r.stdout);
      return { ok: true as const, text: r.stdout };
    })
    .finally(() => { diffInflight.delete(key); });
  diffInflight.set(key, p);
  return p;
}

export async function prDiff(rootIn: unknown, numberIn: unknown): Promise<{ ok: boolean; text?: string; error?: string }> {
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const key = `${repo.nameWithOwner}#${number}`;
  const hit = diffCache.get(key);
  if (hit) {
    // Stale-while-revalidate: hand back what we have, and go and check only if
    // it has aged. A diff on screen a moment sooner is worth more than one that
    // is guaranteed current, because the thing that makes it wrong — a push —
    // is rare and announces itself through the list.
    if (Date.now() - hit.at > DIFF_TTL_MS) void fetchDiff(key, number, repo.nameWithOwner).catch(() => {});
    return { ok: true, text: hit.text };
  }
  return fetchDiff(key, number, repo.nameWithOwner);
}

/** For a test, and for a Refresh that means it. */
export function __clearDiffCache(): void { diffCache.clear(); diffInflight.clear(); }

// ---------------------------------------------------------------------------
// asset proxy
// ---------------------------------------------------------------------------

/**
 * Hosts we will fetch a PR-body image from.
 *
 * A PR body is text written by anyone who can open a pull request, and it
 * reaches this server as a URL. Without an allowlist that is a request forger:
 * `?url=http://169.254.169.254/…` is a metadata endpoint, `file:///…` is the
 * disk. Only image hosts, only https.
 */
const ASSET_HOSTS = [
  "github.com", "objects.githubusercontent.com", "user-images.githubusercontent.com",
  "raw.githubusercontent.com", "avatars.githubusercontent.com", "media.githubusercontent.com",
  "private-user-images.githubusercontent.com",
];
const ASSET_HOST_SUFFIXES = [".githubusercontent.com", ".clickup-attachments.com", ".githubassets.com"];

export function assetAllowed(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (ASSET_HOSTS.includes(h)) return u;
  if (ASSET_HOST_SUFFIXES.some((s) => h.endsWith(s))) return u;
  return null;
}

/**
 * Whether this host may be shown the user's GitHub token.
 *
 * A separate, narrower question than `assetAllowed`: that one decides what we
 * will fetch, this one decides what we will hand a credential to. It has to be
 * an exact domain match — `hostname.endsWith("github.com")`, which is what
 * stood here, is also true of `evilgithub.com`. Nothing reachable today gets
 * through `assetAllowed` to ask, but a substring test on a hostname is one
 * allowlist edit away from posting `gh auth token` to somebody else's server,
 * and the edit would look harmless.
 */
export function tokenAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "github.com" || h.endsWith(".github.com");
}

let tokenCache: { at: number; token: string } | null = null;

/** The token `gh` already holds. Never sent anywhere but the allowlisted host. */
/**
 * A GraphQL call over HTTP, with no `gh` process in the way.
 *
 * `gh api graphql` is a Go binary that re-resolves auth on every invocation:
 * measured against this repo it costs 570-710ms where the same query over
 * `fetch` costs 520-540ms, and every one of those spawns lands on the single
 * thread the PTY rides. The token is already cached for five minutes, so the
 * subprocess buys nothing. It stays as the fallback for the case the token
 * cannot be read (an unusual `gh` setup, a keyring that will not answer).
 */
export async function ghGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const token = await ghToken();
  if (!token) return ghJson<T>(["api", "graphql", "-f", `query=${query}`,
    ...Object.entries(variables).flatMap(([k, v]) => ["-F", `${k}=${String(v)}`])]);
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "agentglass",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function ghToken(): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < 5 * 60_000) return tokenCache.token;
  const r = await gh(["auth", "token"]);
  const token = r.code === 0 ? r.stdout.trim() : "";
  tokenCache = { at: Date.now(), token };
  return token;
}

/**
 * Fetch an image in a PR body on the user's behalf.
 *
 * `https://github.com/user-attachments/assets/<uuid>` — which is what GitHub
 * rewrites a pasted screenshot to — returns 404 without credentials. Measured:
 * 404 raw, 200 image/png with the token attached. Since these are the
 * before/after screenshots that carry the actual evidence in a review, without
 * this every one of them is a broken box.
 */
export async function prAsset(rawUrl: unknown): Promise<Response> {
  const u = assetAllowed(String(rawUrl || ""));
  if (!u) return new Response("blocked", { status: 400 });
  const token = await ghToken();
  const headers: Record<string, string> = { accept: "image/*" };
  // Only GitHub gets the credential. ClickUp is public and has no business
  // receiving a GitHub token. Redirects stay safe on their own: fetch drops
  // Authorization when a redirect crosses to another origin.
  if (token && tokenAllowedHost(u.hostname)) headers.authorization = `token ${token}`;
  let res: Response;
  try {
    res = await fetch(u.toString(), { headers, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return new Response(`upstream: ${String(e)}`, { status: 502 });
  }
  if (!res.ok) return new Response(`upstream ${res.status}`, { status: res.status === 404 ? 404 : 502 });
  const type = res.headers.get("content-type") || "application/octet-stream";
  // Refuse to relay anything that is not an image: this endpoint must not
  // become a general-purpose fetcher for whatever a body links to.
  if (!/^image\//i.test(type)) return new Response("not an image", { status: 415 });
  return new Response(res.body, {
    headers: { "content-type": type, "cache-control": "private, max-age=600" },
  });
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

function writeGuard(rootIn: unknown): PrActionResult | null {
  if (!WRITE_ENABLED) return { ok: false, error: "writes are disabled (AGENTGLASS_GIT_WRITE_DISABLED=1)" };
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (!root) return { ok: false, error: "not a git repository" };
  if (!inScope(root)) return { ok: false, error: "outside the open project — open the parent folder to work across repos" };
  return null;
}

function invalidate(repo: PrRepoId, number?: number): void {
  for (const k of listCache.keys()) if (k.startsWith(`${repo.key}\u0000`)) listCache.delete(k);
  if (number !== undefined) detailCache.delete(`${repo.key}#${number}`);
}

async function runPr(rootIn: unknown, number: number, args: string[], stdin?: string): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh([...args, "-R", repo.nameWithOwner], undefined, stdin);
  invalidate(repo, number);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "gh failed" };
  // The first line, the same as the error path above. This is shown in a toast
  // — a phone-width one — and some of these commands print a paragraph.
  return { ok: true, detail: r.stdout.trim().split("\n")[0] || undefined };
}

const REVIEW_FLAG = { approve: "--approve", request_changes: "--request-changes", comment: "--comment" } as const;
export type ReviewVerb = keyof typeof REVIEW_FLAG;

/** Approve / request changes / comment. Body arrives on stdin so a review can
 *  contain anything a shell would otherwise eat. */
export async function submitReview(rootIn: unknown, number: unknown, verb: unknown, body: unknown): Promise<PrActionResult> {
  const v = String(verb) as ReviewVerb;
  if (!(v in REVIEW_FLAG)) return { ok: false, error: "invalid review type" };
  const text = String(body ?? "");
  if (v !== "approve" && !text.trim()) return { ok: false, error: "a comment or requested change needs a body" };
  const args = ["pr", "review", String(Number(number)), REVIEW_FLAG[v]];
  if (text.trim()) args.push("--body-file", "-");
  return runPr(rootIn, Number(number), args, text.trim() ? text : undefined);
}

export async function addComment(rootIn: unknown, number: unknown, body: unknown): Promise<PrActionResult> {
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, error: "empty comment" };
  return runPr(rootIn, Number(number), ["pr", "comment", String(Number(number)), "--body-file", "-"], text);
}

/**
 * Reply on a line thread.
 *
 * `gh pr comment` posts to the conversation, not to a thread — the reply has to
 * go through the REST endpoint with `in_reply_to`, which is where the actual
 * review conversation lives.
 */
export async function replyToThread(rootIn: unknown, number: unknown, commentId: unknown, body: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(number), cid = Number(commentId);
  const text = String(body ?? "").trim();
  if (!Number.isInteger(n) || !Number.isInteger(cid)) return { ok: false, error: "invalid thread" };
  if (!text) return { ok: false, error: "empty reply" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh([
    "api", "--method", "POST",
    `repos/${repo.nameWithOwner}/pulls/${n}/comments/${cid}/replies`,
    "-f", `body=${text}`,
  ]);
  invalidate(repo, n);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "reply failed" };
  return { ok: true };
}

/**
 * Resolve or unresolve a review thread.
 *
 * There is no `gh pr` subcommand for this — it is a GraphQL mutation and
 * nothing else. Worth stating because the obvious search for one comes up
 * empty and the feature looks impossible.
 */
export async function setThreadResolved(rootIn: unknown, threadId: unknown, resolved: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const id = String(threadId || "");
  if (!id) return { ok: false, error: "invalid thread id" };
  const want = resolved !== false && resolved !== "false";
  const mutation = want
    ? `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`
    : `mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${id}`]);
  const repo = await repoIdFor(rootIn);
  if (repo) invalidate(repo);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not change the thread" };
  return { ok: true };
}

/** The eight GitHub allows. There is no ninth, and no custom emoji. */
const REACTIONS = ["THUMBS_UP", "THUMBS_DOWN", "LAUGH", "HOORAY", "CONFUSED", "HEART", "ROCKET", "EYES"];

/**
 * React to anything: the pull request body, a conversation comment, a review, or
 * a line comment.
 *
 * GraphQL's `addReaction`/`removeReaction` take a node id and do not care which
 * kind of thing it is — which is the whole reason to use them. The REST route
 * this used to call was `/pulls/comments/{id}/reactions`, the *review comment*
 * endpoint, so reacting to an ordinary conversation comment answered 404: the
 * one case anybody actually hits. Toggling off needs a mutation of its own,
 * which REST could not express here either.
 */
export async function react(rootIn: unknown, nodeId: unknown, content: unknown, on: unknown = true): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const id = String(nodeId || "");
  const c = String(content || "THUMBS_UP").toUpperCase();
  if (!id) return { ok: false, error: "invalid comment" };
  if (!REACTIONS.includes(c)) return { ok: false, error: "invalid reaction" };
  const add = on !== false && on !== "false";
  const mutation = add
    ? `mutation($id:ID!,$c:ReactionContent!){addReaction(input:{subjectId:$id,content:$c}){clientMutationId}}`
    : `mutation($id:ID!,$c:ReactionContent!){removeReaction(input:{subjectId:$id,content:$c}){clientMutationId}}`;
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${id}`, "-F", `c=${c}`]);
  // Drop the cached detail either way: a reaction that does not show up until
  // the 45s TTL expires reads as a button that did nothing.
  const repo = await repoIdFor(rootIn);
  if (repo) invalidate(repo);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "reaction failed" };
  return { ok: true };
}

/** Edit your own comment. The PR body goes through `editPr`, not here. */
export async function editComment(rootIn: unknown, nodeId: unknown, body: unknown, kind: unknown = "issue"): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const id = String(nodeId || "");
  const text = String(body ?? "");
  if (!id) return { ok: false, error: "invalid comment" };
  if (!text.trim()) return { ok: false, error: "a comment cannot be empty" };
  const review = kind === "review";
  const mutation = review
    ? `mutation($id:ID!,$b:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$b}){clientMutationId}}`
    : `mutation($id:ID!,$b:String!){updateIssueComment(input:{id:$id,body:$b}){clientMutationId}}`;
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${id}`, "-F", `b=${text}`]);
  const repo = await repoIdFor(rootIn);
  if (repo) invalidate(repo);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not edit the comment" };
  return { ok: true };
}

/** Delete your own comment. */
export async function deleteComment(rootIn: unknown, nodeId: unknown, kind: unknown = "issue"): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const id = String(nodeId || "");
  if (!id) return { ok: false, error: "invalid comment" };
  const review = kind === "review";
  const mutation = review
    ? `mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}`
    : `mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}`;
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${id}`]);
  const repo = await repoIdFor(rootIn);
  if (repo) invalidate(repo);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not delete the comment" };
  return { ok: true };
}

/**
 * GitHub's own per-reviewer "viewed" tick.
 *
 * The panel has always kept this in localStorage, which means it disagreed with
 * github.com and was lost on another machine. GitHub also un-ticks a file by
 * itself when it changes after you marked it, which local state cannot do.
 */
/**
 * A slice of a file at one side of the pull request.
 *
 * What "expand context" needs: the diff only carries the hunks GitHub chose to
 * send, so the twenty lines above a change simply are not in the payload. And
 * what an image diff needs, in the other shape: the raw bytes of a binary file
 * on each side, which the unified diff cannot represent at all.
 */
/**
 * A pull request's version of one file, on disk, read-only.
 *
 * The working tree cannot answer this: a pull request from somebody else is on
 * a branch that is not checked out here, so the path either does not exist or
 * holds a different version of itself — and opening that while calling it the
 * pull request's file is the quiet kind of wrong.
 *
 * Fetched at the head commit into a temp file. Deliberately NOT `git fetch`:
 * bringing the branch down would write refs into somebody's repository to
 * satisfy a look, and this needs no repository at all.
 */
export async function prFileToTemp(rootIn: unknown, numberIn: unknown, pathIn: unknown): Promise<{ ok: true; file: string; sha: string } | { ok: false; error: string }> {
  const n = Number(numberIn);
  const path = typeof pathIn === "string" ? pathIn : "";
  if (!Number.isInteger(n) || n <= 0 || !path) return { ok: false, error: "invalid file" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const pr = await ghJson<any>(["api", `repos/${repo.nameWithOwner}/pulls/${n}`]);
  const sha = pr?.head?.sha;
  const from = pr?.head?.repo?.full_name || repo.nameWithOwner;
  if (!sha) return { ok: false, error: "could not resolve the pull request's head" };
  const r = await gh(["api", `repos/${from}/contents/${encodeURI(path)}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "GitHub would not return that file" };
  // Named for what it is, and kept out of the repository: a stray file inside a
  // checkout would show up in somebody's `git status` an hour later.
  const dir = makeViewTempDir("pr");
  const file = join(dir, `${sha.slice(0, 7)}-${path.split("/").pop() || "file"}`);
  writeFileSync(file, r.stdout);
  return { ok: true, file, sha };
}

export async function fileSlice(rootIn: unknown, numberIn: unknown, args: {
  path?: unknown; side?: unknown; from?: unknown; to?: unknown;
}): Promise<{ ok: boolean; lines?: string[]; start?: number; total?: number; binary?: boolean; url?: string; error?: string }> {
  const n = Number(numberIn);
  const path = typeof args.path === "string" ? args.path : "";
  if (!Number.isInteger(n) || n <= 0 || !path) return { ok: false, error: "invalid file" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const pr = await ghJson<any>(["api", `repos/${repo.nameWithOwner}/pulls/${n}`]);
  // LEFT is the base — the file as it was; RIGHT is the head — as it is now.
  const left = args.side === "LEFT";
  const ref = left ? pr?.base?.sha : pr?.head?.sha;
  const from = left ? repo.nameWithOwner : (pr?.head?.repo?.full_name ?? repo.nameWithOwner);
  if (!ref) return { ok: false, error: "could not read the pull request's commits" };
  const file = await ghJson<any>(["api", `repos/${from}/contents/${encodeURI(path)}?ref=${ref}`]);
  if (!file) return { ok: false, error: `${path} is not on that side` };
  // A file GitHub will not inline is a big one or a binary one; either way the
  // bytes come from `download_url`, which the asset proxy can fetch.
  if (!file.content || file.encoding !== "base64") {
    return { ok: true, binary: true, url: file.download_url ?? "" };
  }
  const buf = Buffer.from(String(file.content).replace(/\n/g, ""), "base64");
  // A NUL in the first few KB is the usual "this is not text" tell.
  if (buf.subarray(0, 8000).includes(0)) return { ok: true, binary: true, url: file.download_url ?? "" };
  const all = buf.toString("utf8").split("\n");
  const start = Math.max(1, Number(args.from) || 1);
  const to = Math.min(all.length, Number(args.to) || all.length);
  return { ok: true, lines: all.slice(start - 1, to), start, total: all.length };
}

/**
 * Replace lines [start, end] (inclusive, 1-based) with the suggested text.
 *
 * Its own function so it can be tested without writing a commit: this is the
 * step that decides whether a file comes out correct or mangled, and an
 * off-by-one here silently eats somebody's line.
 */
export function spliceLines(lines: string[], start: number, end: number, replacement: string): string {
  return [...lines.slice(0, start - 1), ...replacement.split("\n"), ...lines.slice(end)].join("\n");
}

/**
 * Apply a suggested change.
 *
 * GitHub has no "apply suggestion" API — the button on their site is web-only —
 * so the commit has to be written here: read the file at the head of the pull
 * request's branch, swap the suggested lines in, and commit the result with
 * `createCommitOnBranch`. That mutation is the right tool because it commits
 * through the API and the result is signed as a verified commit, which pushing
 * from a local checkout would not be.
 *
 * `expectedHeadOid` is the safety belt: if anyone pushed between the read and
 * the write, GitHub refuses rather than clobbering their work. And the person
 * who suggested the change is credited as a co-author, exactly as GitHub does.
 */
export async function applySuggestion(rootIn: unknown, numberIn: unknown, args: {
  path?: unknown; startLine?: unknown; line?: unknown; suggestion?: unknown; author?: unknown;
}): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(numberIn);
  const path = typeof args.path === "string" ? args.path : "";
  const end = Number(args.line);
  const start = Number.isInteger(Number(args.startLine)) && Number(args.startLine) > 0 ? Number(args.startLine) : end;
  const replacement = typeof args.suggestion === "string" ? args.suggestion : "";
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "invalid pull request number" };
  if (!path || !Number.isInteger(end) || end <= 0) return { ok: false, error: "invalid line" };
  if (start > end) return { ok: false, error: "invalid range" };

  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };

  // The branch this pull request is FROM, and the commit it is at. A suggestion
  // applies to the head branch, which on a fork is not this repository.
  const pr = await ghJson<any>(["api", `repos/${repo.nameWithOwner}/pulls/${n}`]);
  const headRepo: string | undefined = pr?.head?.repo?.full_name;
  const headRef: string | undefined = pr?.head?.ref;
  const headSha: string | undefined = pr?.head?.sha;
  if (!headRepo || !headRef || !headSha) return { ok: false, error: "could not read the pull request's branch" };
  if (pr?.maintainer_can_modify === false && headRepo !== repo.nameWithOwner) {
    return { ok: false, error: "this fork does not allow maintainers to push to it" };
  }

  // The file as it stands on that branch.
  const file = await ghJson<any>(["api", `repos/${headRepo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(headRef)}`]);
  if (!file?.content || file.encoding !== "base64") return { ok: false, error: `could not read ${path}` };
  const text = Buffer.from(String(file.content).replace(/\n/g, ""), "base64").toString("utf8");
  const lines = text.split("\n");
  if (end > lines.length) return { ok: false, error: "the file has changed since that suggestion was written" };

  const next = spliceLines(lines, start, end, replacement);
  if (next === text) return { ok: false, error: "that suggestion is already applied" };

  const who = typeof args.author === "string" ? args.author.trim() : "";
  const message = who
    ? `Apply suggestion from @${who}\n\nCo-authored-by: ${who} <${who}@users.noreply.github.com>`
    : "Apply suggestion";
  const mutation = `mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`;
  const input = {
    branch: { repositoryNameWithOwner: headRepo, branchName: headRef },
    expectedHeadOid: headSha,
    message: { headline: message.split("\n")[0], body: message.split("\n").slice(1).join("\n").trim() || undefined },
    fileChanges: { additions: [{ path, contents: Buffer.from(next, "utf8").toString("base64") }] },
  };
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "--input", "-"],
    undefined, JSON.stringify({ query: mutation, variables: { input } }));
  invalidate(repo, n);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").find((l) => l.trim()) || "the commit was refused";
    // The one failure worth naming: somebody pushed while you were reading.
    return { ok: false, error: /expected.*oid|not.*match/i.test(msg) ? "somebody pushed to that branch — reload and try again" : msg };
  }
  return { ok: true, detail: `applied to ${path}:${start === end ? start : `${start}-${end}`}` };
}

export async function setFileViewed(rootIn: unknown, prNodeId: unknown, path: unknown, viewed: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const id = String(prNodeId || "");
  const p = String(path || "");
  if (!id || !p) return { ok: false, error: "invalid file" };
  const mutation = viewed !== false && viewed !== "false"
    ? `mutation($id:ID!,$p:String!){markFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}`
    : `mutation($id:ID!,$p:String!){unmarkFileAsViewed(input:{pullRequestId:$id,path:$p}){clientMutationId}}`;
  const r = await gh(["api", "graphql", "-f", `query=${mutation}`, "-F", `id=${id}`, "-F", `p=${p}`]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not mark the file" };
  return { ok: true };
}

/** Assignees and milestone: the two sidebar fields that were read-only. */
export async function setAssignees(rootIn: unknown, number: unknown, add: unknown[], remove: unknown[]): Promise<PrActionResult> {
  const args = ["pr", "edit", String(Number(number))];
  for (const a of (add || [])) if (String(a).trim()) args.push("--add-assignee", String(a).trim());
  for (const a of (remove || [])) if (String(a).trim()) args.push("--remove-assignee", String(a).trim());
  if (args.length === 3) return { ok: false, error: "nothing to change" };
  return runPr(rootIn, Number(number), args);
}

export async function setMilestone(rootIn: unknown, number: unknown, title: unknown): Promise<PrActionResult> {
  const t = String(title ?? "").trim();
  // gh spells "no milestone" as an empty --milestone, so clearing is expressible.
  const args = ["pr", "edit", String(Number(number)), t ? "--milestone" : "--remove-milestone", ...(t ? [t] : [])];
  return runPr(rootIn, Number(number), args);
}

export async function editPr(rootIn: unknown, number: unknown, patch: { title?: unknown; body?: unknown; base?: unknown }): Promise<PrActionResult> {
  const args = ["pr", "edit", String(Number(number))];
  let stdin: string | undefined;
  if (typeof patch.title === "string" && patch.title.trim()) args.push("--title", patch.title.trim());
  if (typeof patch.body === "string") { args.push("--body-file", "-"); stdin = patch.body; }
  if (typeof patch.base === "string" && patch.base.trim()) args.push("--base", patch.base.trim());
  if (args.length === 3) return { ok: false, error: "nothing to change" };
  return runPr(rootIn, Number(number), args, stdin);
}

/**
 * Labels, which on some repos are not metadata but buttons.
 *
 * A "ready to review" label can start a CI review job; a style label can change
 * what that job does. Treated as a real action for that reason, not as a tag
 * edit.
 */
export async function setLabels(rootIn: unknown, number: unknown, add: unknown, remove: unknown): Promise<PrActionResult> {
  const args = ["pr", "edit", String(Number(number))];
  for (const l of Array.isArray(add) ? add : []) if (typeof l === "string" && l.trim()) args.push("--add-label", l.trim());
  for (const l of Array.isArray(remove) ? remove : []) if (typeof l === "string" && l.trim()) args.push("--remove-label", l.trim());
  if (args.length === 3) return { ok: false, error: "no labels given" };
  return runPr(rootIn, Number(number), args);
}

export async function setReviewers(rootIn: unknown, number: unknown, add: unknown, remove: unknown): Promise<PrActionResult> {
  const args = ["pr", "edit", String(Number(number))];
  for (const l of Array.isArray(add) ? add : []) if (typeof l === "string" && l.trim()) args.push("--add-reviewer", l.trim());
  for (const l of Array.isArray(remove) ? remove : []) if (typeof l === "string" && l.trim()) args.push("--remove-reviewer", l.trim());
  if (args.length === 3) return { ok: false, error: "no reviewers given" };
  return runPr(rootIn, Number(number), args);
}

export async function setDraft(rootIn: unknown, number: unknown, draft: unknown): Promise<PrActionResult> {
  const args = ["pr", "ready", String(Number(number))];
  if (draft === true || draft === "true") args.push("--undo");
  return runPr(rootIn, Number(number), args);
}

/** Merge the base into the PR branch — the button whose absence is why half a
 *  branch list carries hand-made "Merge origin/master into …" commits. */
export async function updateBranch(rootIn: unknown, number: unknown, syncLocal?: unknown): Promise<PrActionResult> {
  const r = await runPr(rootIn, Number(number), ["pr", "update-branch", String(Number(number))]);
  // The merge runs on GitHub's side, so there is never a half-merged local tree
  // to clean up — but when base and head conflict the API refuses, and gh's raw
  // error ("failed to update branch: …") is a dead end. Turn it into an
  // actionable one. (A future "resolve in terminal" flow can drop the user into
  // the merge in a worktree; for now, tell them what to do.)
  if (!r.ok && /conflict|mergeable/i.test(r.error || "")) {
    return { ok: false, error: "can't update automatically — this branch conflicts with its base. pull the base branch and resolve the merge locally, then push." };
  }
  // A locked or protected branch, or no write access: gh returns "not
  // authorized"/"locked"/403, and the raw text is another dead end. The button
  // is gated on BEHIND + viewerCanUpdate so this should rarely surface, but the
  // two can race — the branch locks between the read and the click — and a bare
  // "failed to update branch" is exactly the confusing error we are trying to
  // avoid here.
  if (!r.ok && /lock|protect|not authoriz|forbidden|permission|\b403\b/i.test(r.error || "")) {
    return { ok: false, error: "can't update this branch — it is locked or protected, or you do not have write access. update it on GitHub, or ask someone who can." };
  }
  if (!r.ok || !(syncLocal === true || syncLocal === "true")) return r;
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (!root) return r;
  return { ...r, detail: `updated on GitHub · ${await syncLocalHead(root, Number(number))}` };
}

/**
 * The second half of "Update branch": bring this machine's copy along.
 *
 * The merge itself happens on GitHub, which is why this button never had a
 * local half — and why the branch on your disk quietly became a commit stale
 * every time you pressed it. Everything here either fast-forwards or explains
 * itself; there is no path that merges, rebases, checks out or stashes.
 *
 * Two shapes of fast-forward, because they are genuinely different:
 *
 *   * not checked out anywhere — `fetch <remote> <branch>:<branch>` moves the
 *     ref with no working tree involved at all, and git itself refuses if it
 *     would not be a fast-forward. Nobody's editor sees anything move.
 *   * checked out and clean — a plain `merge --ff-only` in that worktree, which
 *     is what a pull would have done.
 *
 * Returns the sentence to show, never throws: the GitHub half already
 * succeeded by the time this runs, and no local outcome may be reported in a
 * way that reads as if it had not.
 */
async function syncLocalHead(root: string, number: number): Promise<string> {
  const pr = await prBranches(root, number);
  if (!pr) return "could not read the branch to sync it here";
  const st = await localHead(root, pr.head);
  if (st.sync === "absent") return "no local copy of this branch";
  if (st.sync === "busy") return `left your local copy alone — ${st.worktree} is mid-merge or mid-rebase`;
  if (st.sync === "diverged") return `left your local copy alone — it has ${st.ahead} commit${st.ahead === 1 ? "" : "s"} GitHub does not have`;
  if (st.sync === "dirty") return `left your local copy alone — uncommitted changes in ${st.worktree}`;

  return fastForwardLocal(root, st);
}

/**
 * Move a local branch up to what its remote now has, and say what happened.
 *
 * Split out from the button so it can be tested against real repositories:
 * everything above this line needs `gh`, and none of the decisions worth
 * getting right do.
 *
 * The two shapes are not the same operation. A branch nobody has checked out
 * moves by refspec — `fetch <remote> <branch>:<branch>` — which git will only
 * do as a fast-forward and which no working tree ever notices. A branch that
 * IS checked out gets the `merge --ff-only` a pull would have done, in its own
 * worktree. Neither can rewrite anything: without `+` in the refspec and with
 * `--ff-only` on the merge, git refuses rather than moving history sideways.
 */
export async function fastForwardLocal(root: string, st: PrLocalHead): Promise<string> {
  const up = await upstreamOf(root, st.branch);
  if (!up) return "left your local copy alone — it tracks no remote";
  const fetched = await gitAsync(root, ["fetch", up.remote, up.remoteBranch]);
  if (fetched.code !== 0) return `could not fetch ${up.remote} — pull it yourself`;
  const last = (r: { stderr: string; stdout: string }) =>
    (r.stderr || r.stdout || "").trim().split("\n").pop() || "git refused";
  if (!st.worktree) {
    const moved = await gitAsync(root, ["fetch", up.remote, `${up.remoteBranch}:${st.branch}`]);
    return moved.code === 0
      ? `your local ${st.branch} moved up too`
      : `your local ${st.branch} did not move: ${last(moved)}`;
  }
  const ff = await gitAsync(st.worktree, ["merge", "--ff-only", up.ref]);
  return ff.code === 0
    ? `your checkout of ${st.branch} moved up too`
    : `your checkout did not move: ${last(ff)}`;
}

/** Re-run the failed jobs on the PR's head — the usual answer to a red run,
 *  and today the usual reason to leave the app. */
/**
 * The log of one CI job, in the app.
 *
 * The panel used to say "the log itself lives on GitHub — this panel does not
 * download run logs", which meant every red check sent you to a browser. It is
 * one REST call. Capped, because a chatty job runs to megabytes and this is a
 * panel, not a log store: the TAIL is kept, since the failure is at the end.
 */
const LOG_MAX_BYTES = 400_000;
const logCache = new Map<string, { at: number; text: string }>();
const LOG_TTL_MS = 5 * 60_000;

export async function jobLog(rootIn: unknown, jobIdIn: unknown): Promise<{ ok: boolean; text?: string; truncated?: boolean; error?: string }> {
  const jobId = String(jobIdIn ?? "");
  if (!/^\d+$/.test(jobId)) return { ok: false, error: "invalid job" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const key = `${repo.key}#${jobId}`;
  const hit = logCache.get(key);
  if (hit && Date.now() - hit.at < LOG_TTL_MS) return { ok: true, text: hit.text };
  const r = await gh(["api", `repos/${repo.nameWithOwner}/actions/jobs/${jobId}/logs`]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not read the log" };
  const full = r.stdout;
  const truncated = full.length > LOG_MAX_BYTES;
  const text = truncated ? full.slice(full.length - LOG_MAX_BYTES) : full;
  logCache.set(key, { at: Date.now(), text });
  return { ok: true, text, truncated };
}

/**
 * The jobs behind this pull request's checks, so a check can be opened.
 *
 * A check run's `detailsUrl` carries the run id; the jobs under it are what
 * actually have logs and what a single re-run targets.
 */
export async function checkJobs(rootIn: unknown, number: unknown): Promise<{ ok: boolean; jobs?: PrCheckJob[]; error?: string }> {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const det = await prDetail(rootIn, n);
  if (!det.ok || !det.detail) return { ok: false, error: det.error };
  const runIds = new Set<string>();
  for (const c of det.detail.checksAll) {
    const m = /\/actions\/runs\/(\d+)/.exec(c.url || "");
    if (m) runIds.add(m[1]!);
  }
  const jobs: PrCheckJob[] = [];
  for (const id of [...runIds].slice(0, 6)) {
    const r = await ghJson<any>(["api", `repos/${repo.nameWithOwner}/actions/runs/${id}/jobs`, "--paginate"]);
    for (const j of r?.jobs ?? []) {
      jobs.push({
        id: String(j.id),
        runId: id,
        name: String(j.name ?? ""),
        status: String(j.status ?? ""),
        conclusion: j.conclusion ?? null,
        startedAt: j.started_at ?? null,
        completedAt: j.completed_at ?? null,
        url: j.html_url ?? "",
      });
    }
  }
  return { ok: true, jobs };
}

/** Re-run everything, only what failed, or one job. */
export async function rerunJobs(rootIn: unknown, what: unknown, id: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const target = String(id ?? "");
  if (!/^\d+$/.test(target)) return { ok: false, error: "invalid run or job" };
  const args = what === "job"
    ? ["api", "--method", "POST", `repos/${repo.nameWithOwner}/actions/jobs/${target}/rerun`]
    : what === "all"
      ? ["api", "--method", "POST", `repos/${repo.nameWithOwner}/actions/runs/${target}/rerun`]
      : ["api", "--method", "POST", `repos/${repo.nameWithOwner}/actions/runs/${target}/rerun-failed-jobs`];
  const r = await gh(args);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "could not start the re-run" };
  invalidate(repo);
  return { ok: true, detail: what === "job" ? "Re-running that job" : what === "all" ? "Re-running every job" : "Re-running the failed jobs" };
}

export async function rerunFailedChecks(rootIn: unknown, number: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(number);
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const detail = await prDetail(rootIn, n, true);
  if (!detail.ok || !detail.detail) return { ok: false, error: detail.error || "could not read the pull request" };
  const runIds = new Set<string>();
  for (const c of detail.detail.checksAll) {
    const m = (c.url || "").match(/\/actions\/runs\/(\d+)/);
    if (m && c.state === "failure") runIds.add(m[1]!);
  }
  if (!runIds.size) return { ok: false, error: "no failed workflow run to re-run" };
  const failures: string[] = [];
  for (const id of runIds) {
    const r = await gh(["run", "rerun", id, "--failed", "-R", repo.nameWithOwner]);
    if (r.code !== 0) failures.push((r.stderr || "").trim().split("\n")[0] || id);
  }
  invalidate(repo, n);
  if (failures.length) return { ok: false, error: `re-run failed: ${failures[0]}` };
  return { ok: true, detail: `re-ran ${runIds.size} workflow run${runIds.size === 1 ? "" : "s"}` };
}

// --- irreversible ----------------------------------------------------------

/**
 * The merge itself.
 *
 * `--match-head-commit` is not optional. Between the moment the panel drew the
 * diff and the moment you press the button, the author can push; without it you
 * would merge a commit you never saw. The caller passes the head it showed you,
 * and GitHub refuses if that is no longer the tip.
 */
/**
 * What "Merge when green" actually means when it fails.
 *
 * gh relays GitHub's GraphQL error verbatim: "Auto merge is not allowed for
 * this repository (enablePullRequestAutoMerge)". Every word of that is true
 * and none of it is actionable in the panel it lands in. The setting is not
 * anything about this pull request, it is a repository option that is off by
 * default, and the person reading the message is the person who can turn it
 * on. Say where it lives instead of quoting the mutation that failed.
 */
export function autoMergeHint(error: string): string | null {
  return /auto[- ]?merge is not allowed/i.test(error)
    ? "auto-merge is off for this repository: turn on Settings > General > Pull requests > Allow auto-merge, then arm it again"
    : null;
}

export async function mergePr(rootIn: unknown, number: unknown, method: unknown, opts: { deleteBranch?: unknown; auto?: unknown; headSha?: unknown; subject?: unknown; body?: unknown; disableAuto?: unknown }): Promise<PrActionResult> {
  // Cancelling an armed auto-merge is its own verb, not a merge with a flag —
  // and it was missing entirely, so a "merge when green" could be armed and
  // never called off from here.
  if (opts.disableAuto === true || opts.disableAuto === "true") {
    return runPr(rootIn, Number(number), ["pr", "merge", String(Number(number)), "--disable-auto"]);
  }
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : method === "squash" ? "--squash" : null;
  if (!flag) return { ok: false, error: "choose squash, merge or rebase" };
  const args = ["pr", "merge", String(Number(number)), flag];
  const auto = opts.auto === true || opts.auto === "true";
  if (auto) args.push("--auto");
  if (opts.deleteBranch === true || opts.deleteBranch === "true") args.push("--delete-branch");
  if (typeof opts.headSha === "string" && /^[0-9a-f]{7,40}$/i.test(opts.headSha)) args.push("--match-head-commit", opts.headSha);
  // The commit this writes onto the base branch is permanent and public; being
  // able to fix its subject before it lands is the whole point of the dialog.
  // Rebase writes no commit of its own, so gh rejects a message there.
  if (flag !== "--rebase") {
    if (typeof opts.subject === "string" && opts.subject.trim()) args.push("--subject", opts.subject.trim());
    if (typeof opts.body === "string" && opts.body.trim()) args.push("--body", opts.body);
  }
  const res = await runPr(rootIn, Number(number), args);
  if (!res.ok && auto) {
    const hint = autoMergeHint(res.error || "");
    if (hint) return { ...res, error: hint };
  }
  return res;
}

export async function closePr(rootIn: unknown, number: unknown, reopen = false): Promise<PrActionResult> {
  return runPr(rootIn, Number(number), ["pr", reopen ? "reopen" : "close", String(Number(number))]);
}

// ---------------------------------------------------------------------------
// review this pull request with Claude
// ---------------------------------------------------------------------------

/** Either a plan that can be run, or the reason there isn't one. A union
 *  rather than one bag of optionals, so a caller that has checked `ok` gets a
 *  cwd and a prompt that are strings — the shape it is about to execute. */
export type ReviewPromptPlan =
  | { ok: true; cwd: string; prompt: string; branch?: string; error?: undefined }
  | { ok: false; error: string; cwd?: undefined; prompt?: undefined; branch?: undefined };

/**
 * Hand back the prompt to review a pull request, and nothing else.
 *
 * Deliberately does not run Claude itself: the app already has a chat pipeline
 * (`chatStream` in chat.ts, with streaming, an allowlist and a keepalive) and a
 * second copy of that would rot. This returns a cwd and a prompt; the caller
 * feeds them to the pipeline that already exists.
 *
 * It also, deliberately, writes nothing at all. This used to fetch
 * `pull/N/head` and check it out into a throwaway worktree under
 * `.agentglass/pr-review/N`, for the context a bare diff cannot give: who else
 * calls the helper being changed, whether the tests reach the new path. The
 * context was worth having; the checkout was not the way to get it. It outlived
 * the review every time, so a repository accumulated a working tree and an
 * untracked directory per PR anybody had ever glanced at, and the prompt itself
 * ended by forbidding every write a working tree is for.
 *
 * The same review without the copy: `gh pr diff` carries the patch, the project
 * already open carries the surroundings, and `gh api .../contents?ref=<sha>`
 * fetches any file exactly as the PR leaves it when the diff is not enough.
 * That last one is also what makes a fork work without a remote for it.
 */
/**
 * The chat's opening line for a pull request. Two shapes, chosen by who owns the
 * PR and what its review said — pulled out of prepareReviewPrompt so this wording
 * (a contract with the agent) can be tested without a `gh` round-trip.
 *
 *  - Your PR, review asked for changes → address them: get on the branch, work
 *    through the threads, keep tests green, commit. Not read-only.
 *  - A PR whose review is waiting on YOU → understand it, then review the diff.
 *  - Anything else → understand it, read-only.
 */
export function reviewPromptText(pr: {
  number: number;
  repo: string;
  head: string;
  viewerDidAuthor: boolean;
  reviewDecision: string | null;
  viewerRequested: boolean;
}): string {
  // When it is YOURS and the review asked for changes, describing the PR is the
  // wrong job — the job is to address the review — so it says so and gets onto
  // the branch. Every other case is the read-only understand/review chat.
  const mustAddress = pr.viewerDidAuthor && pr.reviewDecision === "CHANGES_REQUESTED";
  const asked = pr.viewerRequested && !pr.viewerDidAuthor;

  if (mustAddress) {
    return [
      `Pull request #${pr.number} of ${pr.repo}.`,
      ``,
      `This is your pull request and its review asked for changes — address them, don't just describe them.`,
      ``,
      `  gh pr checkout ${pr.number}`,
      `  gh pr view ${pr.number}`,
      `  gh pr diff ${pr.number}`,
      ``,
      // `gh pr checkout` moves this working tree onto the PR branch, so the "not
      // this pull request" note is dropped on purpose: for the address flow you
      // *want* to be on it. The worktree caveat is because this checkout may be
      // holding other work.
      `\`gh pr checkout\` puts you on the branch — make a worktree for the branch first if this checkout is holding work you don't want moved. \`gh pr view\` carries the reviewers' comments and every open thread. Work through each requested change: edit on the branch, keep the tests green (add one where a fix needs it), and commit. Don't push or post anything to GitHub unless I ask. Pinned at ${pr.head}.`,
    ].join("\n");
  }

  const lines = [
    `Pull request #${pr.number} of ${pr.repo}.`,
    ``,
    `Read-only: change nothing, commit nothing, push nothing, and post nothing to GitHub. Answer here.`,
    ``,
    `  gh pr view ${pr.number}`,
    `  gh pr diff ${pr.number}`,
    ``,
    // Worth its line: without it the obvious move is to read the working tree,
    // which is the same project on a different commit — the surroundings, not
    // the change.
    `This checkout is the same project but not this pull request (it is at whatever you have checked out). Read the change from the commands above; use the working tree only for the surroundings.`,
    ``,
    `What is this pull request about?`,
  ];
  // Only when it is actually your review that is being waited on. Asking for a
  // verdict on a pull request nobody asked you to review is how a chat you
  // opened to understand something turns into one arguing with it. Pushed
  // conditionally and joined bare — a `.filter(l => l !== "")` would have taken
  // the blank separators above out with the empty trailing line, leaving the
  // whole read-only prompt cramped.
  if (asked) lines.push(`\nMy review has been requested on it, so go through the diff as well: what the changes do, and anything that looks wrong. Pinned at ${pr.head}.`);
  return lines.join("\n");
}

export async function prepareReviewPrompt(rootIn: unknown, numberIn: unknown): Promise<ReviewPromptPlan> {
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (!root) return { ok: false, error: "not a git repository" };
  // No `writeGuard`: nothing here writes, so a read-only scope can still review
  // a pull request. The scope check is still owed, because the chat is about to
  // be pointed at this directory.
  if (!inScope(root)) return { ok: false, error: "outside the open project — open the parent folder to work across repos" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };

  const detail = await prDetail(rootIn, number);
  if (!detail.ok || !detail.detail) return { ok: false, error: detail.error || "could not read the pull request" };
  const pr = detail.detail;

  // Commits arrive oldest first, so the last one is the head. Pinning the
  // review to a sha rather than a branch name means a push mid-review does not
  // quietly swap the code underneath it.
  const head = pr.commits[pr.commits.length - 1]?.oid || pr.headRefName;

  /*
   * The number, and what to do with it.
   *
   * This used to paste the whole pull request into the chat: title, base and
   * head, file and line counts, four thousand characters of description, every
   * open review thread, and a specification of the report format. It filled the
   * panel — a wall of text you had to scroll past to reach the answer, all of it
   * describing something the agent can read for itself in one command.
   *
   * So it says which pull request and gets out of the way. `gh pr view` carries
   * the title, the body and the threads; `gh pr diff` carries the change. The
   * two things worth stating are the ones the agent cannot find out on its own:
   * that this is read-only, and that the checkout it is sitting in is not this
   * pull request.
   */
  const prompt = reviewPromptText({
    number: pr.number,
    repo: repo.nameWithOwner,
    head,
    viewerDidAuthor: pr.viewerDidAuthor,
    reviewDecision: pr.reviewDecision,
    viewerRequested: pr.viewerRequested,
  });

  return { ok: true, cwd: root, prompt, branch: pr.headRefName };
}

// ---------------------------------------------------------------------------
// "open this branch on GitHub"
// ---------------------------------------------------------------------------

const branchUrlCache = new Map<string, { at: number; url: string }>();

/**
 * Where does this local branch live on the web?
 *
 * Two different answers, and which one you want depends on something the UI
 * already knows. A branch that still exists on the remote has a tree page, and
 * building that URL is string work — no network at all. A branch whose remote
 * is gone has no tree page (that is what gone means); the only useful
 * destination is the pull request, and finding it costs one `gh` call.
 *
 * So the cheap answer stays cheap and only the deleted-branch case pays, which
 * is also the case where the answer is worth waiting for.
 */
export async function branchUrl(rootIn: unknown, branchIn: unknown, goneIn?: unknown): Promise<{ ok: boolean; url?: string; kind?: "tree" | "pr"; error?: string }> {
  const branch = String(branchIn || "").trim();
  if (!branch || /[\s]/.test(branch)) return { ok: false, error: "invalid branch name" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const web = `https://${repo.host}/${repo.nameWithOwner}`;
  const gone = goneIn === true || goneIn === "true";

  if (!gone) return { ok: true, url: `${web}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`, kind: "tree" };

  const key = `${repo.key}\u0000${branch}`;
  const hit = branchUrlCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return { ok: true, url: hit.url, kind: "pr" };

  const cap = await ghCapability();
  if (!cap.available || !cap.authed) return { ok: false, error: cap.reason };
  const rows = await ghJson<any[]>([
    "pr", "list", "-R", repo.nameWithOwner, "--head", branch, "--state", "all", "--limit", "5", "--json", "number,url,state,updatedAt",
  ]);
  if (!rows?.length) return { ok: false, error: `no pull request was ever opened from ${branch}` };
  // Newest wins: a branch name gets reused, and the one you mean is the last.
  const best = [...rows].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  branchUrlCache.set(key, { at: Date.now(), url: best.url });
  return { ok: true, url: best.url, kind: "pr" };
}

/**
 * One commit's diff.
 *
 * Asked of GitHub rather than of the local checkout: the commit belongs to a
 * pull request, which may be from a fork or simply not fetched here, and
 * "review this commit" should not depend on whether you happen to have it.
 */
export async function commitDiff(rootIn: unknown, shaIn: unknown): Promise<{ ok: boolean; text?: string; error?: string }> {
  const sha = String(shaIn || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { ok: false, error: "invalid commit" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh(["api", `repos/${repo.nameWithOwner}/commits/${sha}`, "-H", "Accept: application/vnd.github.v3.diff"]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || "").trim().split("\n")[0] || "could not read that commit" };
  return { ok: true, text: r.stdout };
}

/**
 * A whole review in one shot: a verdict, a body, and the line comments that
 * were queued up while reading the diff.
 *
 * This is what GitHub calls a pending review, and it is a different endpoint
 * from `gh pr review` — that one posts a verdict with a body and nothing else.
 * Line comments have to ride along in the same request or they arrive as a
 * scatter of separate notifications, which is exactly the noise a reviewer is
 * trying not to create.
 *
 * `line` is the line in the file's NEW side. GitHub also accepts the older
 * `position` (an offset within the diff), which is fragile the moment the
 * branch moves; the line number survives a rebase.
 */
/**
 * One line comment, on its own, without opening a review.
 *
 * GitHub offers both — "Add single comment" and "Start a review" — and only the
 * second existed here, so a one-line remark meant queueing a draft, going to the
 * review tab and submitting a verdict you did not want to give.
 */
export async function addLineComment(rootIn: unknown, numberIn: unknown, c: {
  path?: unknown; line?: unknown; startLine?: unknown; side?: unknown; body?: unknown;
}): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(numberIn);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "invalid pull request number" };
  const path = typeof c.path === "string" ? c.path : "";
  const line = Number(c.line);
  const text = typeof c.body === "string" ? c.body.trim() : "";
  if (!path || !Number.isInteger(line) || line <= 0) return { ok: false, error: "invalid line" };
  if (!text) return { ok: false, error: "a comment cannot be empty" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
  const start = Number(c.startLine);
  const payload: Record<string, unknown> = { path, line, side, body: text };
  if (Number.isInteger(start) && start > 0 && start < line) { payload.start_line = start; payload.start_side = side; }
  // The single-comment endpoint needs the commit it applies to.
  const head = await ghJson<any>(["api", `repos/${repo.nameWithOwner}/pulls/${n}`]);
  const sha = head?.head?.sha;
  if (!sha) return { ok: false, error: "could not read the head commit" };
  payload.commit_id = sha;
  const r = await gh(
    ["api", "--method", "POST", `repos/${repo.nameWithOwner}/pulls/${n}/comments`, "--input", "-"],
    undefined, JSON.stringify(payload),
  );
  invalidate(repo, n);
  if (r.code !== 0) {
    return { ok: false, error: (r.stderr || r.stdout).trim().split("\n").find((l) => l.trim()) || "the comment was not accepted" };
  }
  return { ok: true, detail: `commented on ${path}:${payload.start_line ? `${payload.start_line}-${line}` : line}` };
}

export async function submitReviewWith(
  rootIn: unknown, numberIn: unknown, verb: unknown, body: unknown, commentsIn: unknown,
): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(numberIn);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "invalid pull request number" };
  const event = verb === "approve" ? "APPROVE" : verb === "request_changes" ? "REQUEST_CHANGES" : verb === "comment" ? "COMMENT" : null;
  if (!event) return { ok: false, error: "choose approve, request changes, or comment" };

  // A comment can cover a RANGE, which is how you say "this whole block is the
  // problem" instead of pinning it on one arbitrary line. GitHub takes
  // `start_line`/`start_side` alongside `line`/`side`; sending only `line` (all
  // this could do before) collapsed every multi-line remark to its last line.
  type OutComment = { path: string; line: number; side: string; body: string; start_line?: number; start_side?: string };
  const comments: OutComment[] = [];
  for (const c of Array.isArray(commentsIn) ? commentsIn : []) {
    const path = typeof c?.path === "string" ? c.path : "";
    const line = Number(c?.line);
    const text = typeof c?.body === "string" ? c.body.trim() : "";
    if (!path || !Number.isInteger(line) || line <= 0 || !text) continue;
    const side = c?.side === "LEFT" ? "LEFT" : "RIGHT";
    const out: OutComment = { path, line, side, body: text };
    const start = Number(c?.startLine);
    // GitHub rejects a start that is not strictly before the end, and a range
    // that spans both sides of the diff.
    if (Number.isInteger(start) && start > 0 && start < line) {
      out.start_line = start;
      out.start_side = c?.startSide === "LEFT" ? "LEFT" : side;
    }
    comments.push(out);
  }

  const text = String(body ?? "").trim();
  // GitHub refuses an empty COMMENT review, and a REQUEST_CHANGES with nothing
  // said is unkind to whoever receives it.
  if (event !== "APPROVE" && !text && !comments.length) {
    return { ok: false, error: "say something, or leave at least one line comment" };
  }

  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };

  // GitHub allows one pending review per pull request, so a leftover one — from
  // the web UI, or a submit that half-failed — makes every fresh review 422
  // "Unprocessable Entity", which is the wall this hits. Discard it first.
  // agentglass keeps its queued comments locally and re-posts them here, so a
  // pending review on GitHub holds nothing this submit needs; clearing it makes
  // the submitted review exactly the drafts you queued, nothing invisible riding
  // along. Only the author is shown their own PENDING review, so the one that
  // comes back is ours.
  const pend = await gh(
    ["api", "--paginate", `repos/${repo.nameWithOwner}/pulls/${n}/reviews`, "-q", '[.[] | select(.state=="PENDING")][0].id // empty'],
  );
  const pendingId = pend.code === 0 ? pend.stdout.trim() : "";
  if (pendingId) {
    await gh(["api", "--method", "DELETE", `repos/${repo.nameWithOwner}/pulls/${n}/reviews/${pendingId}`]);
  }

  const payload = JSON.stringify({ event, ...(text ? { body: text } : {}), ...(comments.length ? { comments } : {}) });
  const r = await gh(
    ["api", "--method", "POST", `repos/${repo.nameWithOwner}/pulls/${n}/reviews`, "--input", "-"],
    undefined, payload,
  );
  invalidate(repo, n);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").find((l) => l.trim()) || "the review was not accepted";
    return { ok: false, error: msg };
  }
  const count = comments.length;
  return { ok: true, detail: `review submitted${count ? ` with ${count} line comment${count === 1 ? "" : "s"}` : ""}` };
}
