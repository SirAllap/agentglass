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
import { gitAsync, safeAbs, repoRootOf } from "./git.ts";
import { inScope } from "./config.ts";
import type {
  PrRepoId, PrSummary, PrDetail, PrListResponse, PrActionResult, PrCheck, PrCheckRollup,
  PrCheckState, PrThread, PrReview, PrComment, PrCommit, PrFile, PrChecklistItem, PrMergeState, CiVerdict,
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
export async function repoIdFor(rootIn: unknown): Promise<PrRepoId | null> {
  const abs = safeAbs(rootIn);
  if (!abs) return null;
  const root = repoRootOf(abs);
  if (!root) return null;
  const hit = idCache.get(root);
  if (hit && Date.now() - hit.at < ID_TTL_MS) return hit.id;
  let id: PrRepoId | null = null;
  for (const remote of ["upstream", "origin"]) {
    const r = await gitAsync(root, ["remote", "get-url", remote]);
    if (r.code !== 0) continue;
    id = parseRemote(r.stdout.trim());
    if (id) break;
  }
  idCache.set(root, { at: Date.now(), id });
  return id;
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
  if (!pr.checks.allDone) { latch.delete(key); return; }
  const verdict = pr.checks.verdict;
  if (!verdict) return;
  if (latch.get(key) === verdict) return;
  latch.set(key, verdict);
  const v: CiVerdict = {
    repo: repo.nameWithOwner, number: pr.number, title: pr.title, verdict,
    failing: pr.checks.failing.map((c) => c.name), url: pr.url,
  };
  for (const fn of ciListeners) { try { fn(v); } catch { /* a listener must not break the poll */ } }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export type PrFilter = "mine" | "review" | "all";

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
const LIST_FIELDS_FAST = "number,title,author,state,isDraft,headRefName,baseRefName,url,updatedAt,reviewDecision,additions,deletions,changedFiles,labels";

type Entry = { at: number; prs: PrSummary[]; loading: boolean; checksPending: boolean; error?: string };
const listCache = new Map<string, Entry>();
const inflight = new Set<string>();
const LIST_TTL_MS = 90_000;

// `\u0000` written as an escape, never as the byte: a raw NUL makes the whole
// file read as binary to grep, which then skips it in silence. Same separator,
// same keys, still searchable.
const cacheKey = (repo: PrRepoId, filter: PrFilter) => `${repo.key}\u0000${filter}`;

function mapSummary(p: any, withChecks: boolean): PrSummary {
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
    checks: rollup,
    // Absent is not zero: a row without this must say "checks loading", never
    // "no checks", which is a claim about the repository rather than about us.
    checksLoaded: withChecks,
  };
}

async function fetchList(repo: PrRepoId, filter: PrFilter): Promise<PrSummary[] | null> {
  const args = ["pr", "list", "-R", repo.nameWithOwner, "--state", "open", "--limit", "50", "--json", LIST_FIELDS_FAST];
  // `gh pr list --search` rather than `gh search prs`: the latter is a global
  // search that would need its own repo filter anyway, and it rate-limits
  // separately from the REST path everything else here uses.
  if (filter === "review") args.push("--search", "review-requested:@me");
  if (filter === "mine") args.push("--author", "@me");
  const rows = await ghJson<any[]>(args);
  // null (gh failed / unparsable) and [] (gh answered, no matching PRs) are
  // different facts and the caller has to tell them apart: keep null distinct so
  // a network blip holds the last good list while a genuine empty is allowed to
  // empty the panel. Collapsing both to [] is what made a merged PR linger.
  if (rows === null) return null;
  // Newest-first, so the panel reads recent → old and the per-PR check probe in
  // refreshChecks (which walks this order) fills the rows you actually watch
  // first. `gh pr list` has no reliable `--sort`, and updatedAt is an ISO string
  // that sorts lexically, so order it here — same idiom as branchMergeState below.
  return rows
    .map((r) => mapSummary(r, false))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/**
 * Check states, one pull request at a time.
 *
 * Asking for fifty rollups in one query does not work: GitHub answers
 * `HTTP 504 — we couldn't respond to your request in time`. Measured on a real
 * repo — 15 rollups in a batch take 3.2s, 50 in a batch time out on GitHub's
 * side however long we are willing to wait. So they are fetched per pull
 * request, ~0.8s each, newest first, and each one updates its own row as it
 * lands. The list fills in visibly instead of arriving all at once or not at
 * all.
 *
 * Keyed by `updatedAt`, so a poll that finds nothing changed costs nothing.
 */
/** Matched to the list's own limit on purpose. A lower cap leaves the rows past
 *  it saying "checks…" for ever, which is a lie the UI has no way to correct.
 *  Fifty probes is ~40s of background network — no CPU, nothing blocked — and
 *  the per-PR cache keyed by `updatedAt` makes every later visit free. */
const CHECK_PROBE_MAX = 50;
const checkCache = new Map<string, { updatedAt: string; rollup: PrCheckRollup; all: PrCheck[] }>();
const checkRunning = new Set<string>();

function refreshChecks(repo: PrRepoId, filter: PrFilter, rows: PrSummary[], notify: boolean): void {
  const key = cacheKey(repo, filter);
  if (checkRunning.has(key)) return;
  checkRunning.add(key);

  void (async () => {
    try {
      let i = 0;
      for (const pr of rows.slice(0, CHECK_PROBE_MAX)) {
        const ck = `${repo.key}\u0000${pr.number}`;
        const hit = checkCache.get(ck);
        let rollup: PrCheckRollup, all: PrCheck[];
        if (hit && hit.updatedAt === pr.updatedAt) {
          ({ rollup, all } = hit);
        } else {
          const one = await ghJson<any>(["pr", "view", String(pr.number), "-R", repo.nameWithOwner, "--json", "statusCheckRollup"]);
          if (!one) { i++; continue; }
          ({ rollup, all } = rollupChecks(one.statusCheckRollup));
          checkCache.set(ck, { updatedAt: pr.updatedAt, rollup, all });
        }
        i++;

        // Update this row in place. Re-read the entry each time: a newer list
        // may have replaced it while this walk was running, and overwriting it
        // wholesale would undo that.
        const cur = listCache.get(key);
        if (!cur) return;
        const next = cur.prs.map((p) => (p.number === pr.number ? { ...p, checks: rollup, checksLoaded: true } : p));
        listCache.set(key, { ...cur, prs: next, checksPending: i < Math.min(rows.length, CHECK_PROBE_MAX) });
        // Render the check state for every filter, but only push a notification
        // for the ones the user has a stake in — never for the passively-warmed
        // `all` list on a busy repo.
        if (notify) noteCi(repo, { ...pr, checks: rollup });
      }
      const cur = listCache.get(key);
      if (cur) listCache.set(key, { ...cur, checksPending: false });
    } catch {
      const cur = listCache.get(key);
      if (cur) listCache.set(key, { ...cur, checksPending: false });
    } finally {
      checkRunning.delete(key);
    }
  })();
}

/** Refresh behind the response. Never awaited by a request handler. */
function refreshList(repo: PrRepoId, filter: PrFilter): void {
  const key = cacheKey(repo, filter);
  if (inflight.has(key)) return;
  inflight.add(key);
  const prev = listCache.get(key);
  const keep = (over: Partial<Entry>): Entry => ({
    at: prev?.at ?? 0, prs: prev?.prs ?? [], loading: true, checksPending: true, error: prev?.error, ...over,
  });
  listCache.set(key, keep({}));

  void (async () => {
    try {
      const cap = await ghCapability();
      if (!cap.available || !cap.authed) {
        listCache.set(key, keep({ at: Date.now(), loading: false, checksPending: false, error: cap.reason }));
        return;
      }

      // One cheap query for the rows themselves — titles, authors, review
      // decisions. Enough to choose a pull request, and it is what the panel
      // is blocked on.
      const rows = await fetchList(repo, filter);
      if (rows === null) {
        // gh itself failed (a network blip, a rate-limit) — far more likely than
        // a repository that lost every pull request, so keep whatever we had. But
        // DO advance `at`: leaving it stale re-runs gh on every single poll and
        // lets the "updated N ago" age climb without bound. A genuinely empty
        // answer is NOT this branch — `rows` is [] there, not null — so a PR that
        // merged or closed outside actually clears instead of lingering for ever.
        listCache.set(key, keep({ at: Date.now(), loading: false, checksPending: false }));
        return;
      }
      // Carry over any check states already known, so switching back to a tab
      // does not blank the states it had.
      const merged = rows.map((r) => {
        const hit = checkCache.get(`${repo.key}\u0000${r.number}`);
        return hit && hit.updatedAt === r.updatedAt ? { ...r, checks: hit.rollup, checksLoaded: true } : r;
      });
      listCache.set(key, { at: Date.now(), prs: merged, loading: false, checksPending: merged.some((p) => !p.checksLoaded) });
      refreshChecks(repo, filter, merged, ciNotifiesFor(filter));
    } catch (e) {
      listCache.set(key, keep({ loading: false, checksPending: false, error: String(e) }));
    } finally {
      inflight.delete(key);
    }
  })();
}

/**
 * The panel's read. Answers from cache and triggers a refresh if the copy is
 * old — so the poll never waits on the network, and the age is shown rather
 * than hidden behind a spinner that lies.
 */
export async function listPrs(rootIn: unknown, filterIn: unknown, force = false): Promise<PrListResponse> {
  const filter: PrFilter = filterIn === "review" || filterIn === "all" ? filterIn : "mine";
  const repo = await repoIdFor(rootIn);
  if (!repo) {
    const cap = await ghCapability();
    return {
      ok: true, repo: null, prs: [], fetchedAt: 0, stale: false, loading: false,
      needsAuth: !cap.available || !cap.authed,
      error: !cap.available || !cap.authed ? cap.reason : "no GitHub remote on this repository",
    };
  }
  const key = cacheKey(repo, filter);
  const hit = listCache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (force || !hit || age > LIST_TTL_MS) refreshList(repo, filter);
  const cur = listCache.get(key);

  // "you are here" — the checkout's branch, matched against the PR heads. This
  // is the branch/PR link, and it falls out of the dedupe rather than costing
  // a call of its own.
  let head = "";
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (root) {
    const r = await gitAsync(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (r.code === 0) head = r.stdout.trim();
  }
  const prs = (cur?.prs ?? []).map((p) => (p.headRefName && p.headRefName === head ? { ...p, isCurrentBranch: true } : p));

  const cap = await ghCapability();
  return {
    ok: true,
    repo,
    prs,
    fetchedAt: cur?.at ?? 0,
    stale: !cur?.at || Date.now() - (cur?.at ?? 0) > LIST_TTL_MS,
    loading: !!cur?.loading,
    checksPending: !!cur?.checksPending,
    error: cur?.error,
    needsAuth: !cap.available || !cap.authed,
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

const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    number title url state isDraft createdAt updatedAt
    additions deletions changedFiles
    baseRefName headRefName body
    mergeable mergeStateStatus reviewDecision viewerDidAuthor
    author{login}
    labels(first:20){nodes{name color}}
    assignees(first:10){nodes{login}}
    reviewRequests(first:10){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
    reviews(first:50){nodes{author{login} state body submittedAt url}}
    comments(first:50){nodes{databaseId author{login} body createdAt url}}
    commits(first:100){nodes{commit{oid messageHeadline parents{totalCount} author{user{login} name}}}}
    files(first:100){nodes{path additions deletions changeType}}
    reviewThreads(first:50){nodes{
      id isResolved isOutdated path line
      comments(first:20){nodes{id databaseId author{login} body createdAt url diffHunk originalLine}}
    }}
    timelineItems(last:30, itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{... on HeadRefForcePushedEvent{createdAt}}}
    statusCheckRollup:commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
      __typename
      ... on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
      ... on StatusContext{context state targetUrl}
    }}}}}}
  } } }`;

const detailCache = new Map<string, { at: number; detail: PrDetail }>();
const DETAIL_TTL_MS = 45_000;

function mergeStateOf(s: string | undefined, isDraft: boolean): PrMergeState {
  if (isDraft) return "DRAFT";
  const v = (s || "").toUpperCase();
  const known: PrMergeState[] = ["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "HAS_HOOKS"];
  return (known as string[]).includes(v) ? (v as PrMergeState) : "UNKNOWN";
}

export async function prDetail(rootIn: unknown, numberIn: unknown, force = false): Promise<{ ok: boolean; detail?: PrDetail; error?: string }> {
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const key = `${repo.key}#${number}`;
  const hit = detailCache.get(key);
  if (!force && hit && Date.now() - hit.at < DETAIL_TTL_MS) return { ok: true, detail: hit.detail };

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
  }));

  const comments: PrComment[] = (p.comments?.nodes || []).map((c: any) => {
    const author = c.author?.login || "";
    const bot = isBotLogin(author);
    return {
      id: c.databaseId,
      author,
      isBot: bot,
      body: c.body || "",
      createdAt: c.createdAt || "",
      url: c.url || "",
      digest: bot ? digestBotComment(c.body || "") : null,
    };
  });

  const threads: PrThread[] = (p.reviewThreads?.nodes || []).map((t: any) => ({
    id: t.id,
    path: t.path || "",
    line: t.line ?? null,
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
    })),
  }));

  const commits: PrCommit[] = (p.commits?.nodes || []).map((n: any) => {
    const c = n.commit || {};
    return {
      oid: c.oid || "",
      short: (c.oid || "").slice(0, 8),
      message: c.messageHeadline || "",
      author: c.author?.user?.login || c.author?.name || "",
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
    status: f.changeType || "",
    comments: openByPath.get(f.path) ?? 0,
  }));

  // A force-push after a submitted review makes that review stale — the
  // approval you are looking at was for code that no longer exists.
  const pushes: string[] = (p.timelineItems?.nodes || []).map((n: any) => n?.createdAt).filter(Boolean);
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
    checks: rollup,
    checksAll: all,
    body: p.body || "",
    mergeable: p.mergeable || "UNKNOWN",
    mergeState: mergeStateOf(p.mergeStateStatus, !!p.isDraft),
    checklist: parseChecklist(p.body || ""),
    reviewers: (p.reviewRequests?.nodes || []).map((n: any) => n.requestedReviewer?.login || n.requestedReviewer?.name).filter(Boolean),
    assignees: (p.assignees?.nodes || []).map((n: any) => n.login),
    reviews, comments, threads, commits, files,
    forcePushedSinceReview,
    // Who you are on this pull request. Offering "approve" on your own work is
    // a control GitHub does not give you either, and a review button on every
    // row makes the ones that are actually waiting on you invisible.
    viewerDidAuthor: !!p.viewerDidAuthor,
    viewerRequested: (p.reviewRequests?.nodes || [])
      .some((n: any) => (n.requestedReviewer?.login || "") === viewerLogin && !!viewerLogin),
  };

  detailCache.set(key, { at: Date.now(), detail });
  return { ok: true, detail };
}

/** The unified diff, straight into the diff renderer the app already has. */
export async function prDiff(rootIn: unknown, numberIn: unknown): Promise<{ ok: boolean; text?: string; error?: string }> {
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh(["pr", "diff", String(number), "-R", repo.nameWithOwner]);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "gh pr diff failed" };
  return { ok: true, text: r.stdout };
}

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

let tokenCache: { at: number; token: string } | null = null;

/** The token `gh` already holds. Never sent anywhere but the allowlisted host. */
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
  // receiving a GitHub token.
  if (token && u.hostname.toLowerCase().endsWith("github.com")) headers.authorization = `token ${token}`;
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
  return { ok: true, detail: r.stdout.trim() || undefined };
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

/** 👍 on a review comment — how most teams acknowledge without adding noise. */
export async function react(rootIn: unknown, commentId: unknown, content: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const cid = Number(commentId);
  const allowed = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
  const c = String(content || "+1");
  if (!Number.isInteger(cid)) return { ok: false, error: "invalid comment" };
  if (!allowed.includes(c)) return { ok: false, error: "invalid reaction" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };
  const r = await gh(["api", "--method", "POST", `repos/${repo.nameWithOwner}/pulls/comments/${cid}/reactions`, "-f", `content=${c}`]);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] || "reaction failed" };
  return { ok: true };
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
export async function updateBranch(rootIn: unknown, number: unknown): Promise<PrActionResult> {
  const r = await runPr(rootIn, Number(number), ["pr", "update-branch", String(Number(number))]);
  // The merge runs on GitHub's side, so there is never a half-merged local tree
  // to clean up — but when base and head conflict the API refuses, and gh's raw
  // error ("failed to update branch: …") is a dead end. Turn it into an
  // actionable one. (A future "resolve in terminal" flow can drop the user into
  // the merge in a worktree; for now, tell them what to do.)
  if (!r.ok && /conflict|mergeable/i.test(r.error || "")) {
    return { ok: false, error: "can't update automatically — this branch conflicts with its base. pull the base branch and resolve the merge locally, then push." };
  }
  return r;
}

/** Re-run the failed jobs on the PR's head — the usual answer to a red run,
 *  and today the usual reason to leave the app. */
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
export async function mergePr(rootIn: unknown, number: unknown, method: unknown, opts: { deleteBranch?: unknown; auto?: unknown; headSha?: unknown }): Promise<PrActionResult> {
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : method === "squash" ? "--squash" : null;
  if (!flag) return { ok: false, error: "choose squash, merge or rebase" };
  const args = ["pr", "merge", String(Number(number)), flag];
  if (opts.auto === true || opts.auto === "true") args.push("--auto");
  if (opts.deleteBranch === true || opts.deleteBranch === "true") args.push("--delete-branch");
  if (typeof opts.headSha === "string" && /^[0-9a-f]{7,40}$/i.test(opts.headSha)) args.push("--match-head-commit", opts.headSha);
  return runPr(rootIn, Number(number), args);
}

export async function closePr(rootIn: unknown, number: unknown, reopen = false): Promise<PrActionResult> {
  return runPr(rootIn, Number(number), ["pr", reopen ? "reopen" : "close", String(Number(number))]);
}

// ---------------------------------------------------------------------------
// local review
// ---------------------------------------------------------------------------

/**
 * Where throwaway PR checkouts live. Under the repo's own git dir rather than
 * /tmp, so they share the object store — checking out a 12-file PR against a
 * large repo copies nothing.
 */
const REVIEW_WT_DIR = ".agentglass/pr-review";

export interface LocalReviewPlan { ok: boolean; cwd?: string; prompt?: string; branch?: string; error?: string }

/**
 * Put a PR's head on disk and hand back the prompt to review it.
 *
 * Deliberately does not run Claude itself: the app already has a chat pipeline
 * — `chatStream` in chat.ts, with streaming, an allowlist and a keepalive — and
 * a second copy of that would rot. This returns a cwd and a prompt; the caller
 * feeds them to the pipeline that already exists.
 *
 * The point of a worktree rather than the diff alone is context. A review that
 * can only see `-` and `+` lines cannot follow a call site, check whether the
 * helper being changed has another caller, or run the tests. That is the whole
 * difference from the review the CI bot already posts.
 *
 * `pull/N/head` rather than the branch name: the branch may be on a fork you
 * have no remote for, and this ref exists for every PR regardless.
 */
export async function prepareLocalReview(rootIn: unknown, numberIn: unknown): Promise<LocalReviewPlan> {
  const g = writeGuard(rootIn);
  // A worktree is a local write, so it takes the same gate — but the failure
  // message should say that, not talk about pull requests.
  if (g) return { ok: false, error: g.error };
  const number = Number(numberIn);
  if (!Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid pull request number" };
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (!root) return { ok: false, error: "not a git repository" };
  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };

  const detail = await prDetail(rootIn, number);
  if (!detail.ok || !detail.detail) return { ok: false, error: detail.error || "could not read the pull request" };
  const pr = detail.detail;

  const ref = `refs/agentglass/pr-${number}`;
  const fetched = await gitAsync(root, ["fetch", "--no-tags", "--force", "origin", `pull/${number}/head:${ref}`]);
  if (fetched.code !== 0) return { ok: false, error: `could not fetch the pull request: ${fetched.stderr.trim().split("\n")[0]}` };

  const dir = `${root}/${REVIEW_WT_DIR}/${number}`;
  // Re-preparing the same PR is normal — you review, they push, you review
  // again. Drop the old checkout rather than failing on "already exists".
  await gitAsync(root, ["worktree", "remove", "--force", dir]);
  const added = await gitAsync(root, ["worktree", "add", "--detach", dir, ref]);
  if (added.code !== 0) return { ok: false, error: `could not create the review worktree: ${added.stderr.trim().split("\n")[0]}` };

  const openThreads = pr.threads.filter((t) => !t.isResolved);
  const prompt = [
    `Review pull request #${pr.number} of ${repo.nameWithOwner}: "${pr.title}".`,
    ``,
    `This working directory is the PR's head commit, checked out in full — read whatever you need around the diff.`,
    `Base branch: ${pr.baseRefName}. Head: ${pr.headRefName}. ${pr.changedFiles} files, +${pr.additions} −${pr.deletions}.`,
    ``,
    `Start with:  git diff ${pr.baseRefName}...HEAD`,
    ``,
    `## What the author says`,
    pr.body.slice(0, 4000) || "(no description)",
    ``,
    openThreads.length ? `## Review comments still open\n${openThreads.map((t) => `- ${t.path}${t.line ? `:${t.line}` : ""} — ${t.comments[0]?.body.slice(0, 200) ?? ""}`).join("\n")}` : "",
    ``,
    `## What I want`,
    `Find real defects: incorrect logic, unhandled cases, race conditions, missing test coverage for the behaviour being changed.`,
    `Use the full checkout — check whether changed helpers have other callers, and whether the tests actually exercise the new path.`,
    `Report each finding as: file:line, one sentence on the defect, and a concrete failure case. Say plainly if you find nothing serious.`,
    `Do not post anything to GitHub, do not push, and do not change any files. This is a read-only review.`,
  ].filter((l) => l !== "").join("\n");

  return { ok: true, cwd: dir, prompt, branch: pr.headRefName };
}

/** Tear down a review checkout. Cheap, and leaving them around turns the
 *  branches panel into a list of ghosts. */
export async function discardLocalReview(rootIn: unknown, numberIn: unknown): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const number = Number(numberIn);
  const abs = safeAbs(rootIn);
  const root = abs ? repoRootOf(abs) : null;
  if (!root || !Number.isInteger(number)) return { ok: false, error: "invalid request" };
  const dir = `${root}/${REVIEW_WT_DIR}/${number}`;
  const r = await gitAsync(root, ["worktree", "remove", "--force", dir]);
  await gitAsync(root, ["update-ref", "-d", `refs/agentglass/pr-${number}`]);
  if (r.code !== 0 && !/is not a working tree|No such file/i.test(r.stderr)) {
    return { ok: false, error: r.stderr.trim().split("\n")[0] || "could not remove the review worktree" };
  }
  return { ok: true };
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
export async function submitReviewWith(
  rootIn: unknown, numberIn: unknown, verb: unknown, body: unknown, commentsIn: unknown,
): Promise<PrActionResult> {
  const g = writeGuard(rootIn); if (g) return g;
  const n = Number(numberIn);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "invalid pull request number" };
  const event = verb === "approve" ? "APPROVE" : verb === "request_changes" ? "REQUEST_CHANGES" : verb === "comment" ? "COMMENT" : null;
  if (!event) return { ok: false, error: "choose approve, request changes, or comment" };

  const comments: { path: string; line: number; side: string; body: string }[] = [];
  for (const c of Array.isArray(commentsIn) ? commentsIn : []) {
    const path = typeof c?.path === "string" ? c.path : "";
    const line = Number(c?.line);
    const text = typeof c?.body === "string" ? c.body.trim() : "";
    if (!path || !Number.isInteger(line) || line <= 0 || !text) continue;
    comments.push({ path, line, side: c?.side === "LEFT" ? "LEFT" : "RIGHT", body: text });
  }

  const text = String(body ?? "").trim();
  // GitHub refuses an empty COMMENT review, and a REQUEST_CHANGES with nothing
  // said is unkind to whoever receives it.
  if (event !== "APPROVE" && !text && !comments.length) {
    return { ok: false, error: "say something, or leave at least one line comment" };
  }

  const repo = await repoIdFor(rootIn);
  if (!repo) return { ok: false, error: "no GitHub remote on this repository" };

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
