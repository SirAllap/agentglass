// GitHub issues, and turning one into somewhere to work.
//
// The list and the detail are the easy half: `gh` already answers both, and the
// panel is the pull-request panel with a different query behind it. The half
// that needed deciding is what "start work on this" means here.
//
// Orca opens a container. This app has no such thing — it has worktrees, tmux
// and chats, which is more flexible and less automatic. So starting work is:
// cut a worktree named after the issue, and (optionally) put something in it.
// The mode is the caller's choice; every one of them is a real gesture somebody
// already does by hand, and the point is only that it takes one press.
//
// What is genuinely new is the OTHER end. A worktree per issue accumulates —
// that is the complaint this app's own author has made twice in a day — so an
// issue that has been started is remembered, shown as in progress, and can be
// put away again in one press: worktree removed, branch deleted, tmux window
// killed. Starting without a way to finish is how you end up with fourteen
// checkouts and no idea which is which.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { gh, ghGraphql } from "./prs.ts";
import { git, safeAbs } from "./git.ts";
import { addWorktree, removeWorktree } from "./gitwork.ts";
import { inScope } from "./config.ts";

export interface IssueRow {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: { name: string; color: string }[];
  assignees: string[];
  comments: number;
  updatedAt: string;
  url: string;
}

export interface IssueDetail extends IssueRow {
  body: string;
  createdAt: string;
  milestone: string | null;
  /** The work started from this issue, if any is still on disk. */
  work: IssueWork | null;
}

/** A worktree cut for an issue, and how it was started. */
export interface IssueWork {
  number: number;
  repo: string;
  branch: string;
  path: string;
  mode: StartMode;
  /** The tmux window name, when one was opened for it. */
  window?: string;
  startedAt: number;
}

export type StartMode = "worktree" | "shell" | "claude" | "plan" | "branch";

/**
 * A pull request that has something to do with an issue.
 *
 * `linked` separates the two things GitHub's timeline calls a reference: one
 * somebody attached to the issue (and which will close it) from a `#123` that
 * turned up in a body somewhere. See issuePullRequests.
 */
export interface IssuePr {
  number: number;
  title: string;
  state: string;
  url: string;
  draft: boolean;
  linked: boolean;
}

export interface IssuesReport { ok: boolean; issues: IssueRow[]; error?: string }

// ------------------------------------------------------------ the names ----

/**
 * The branch an issue gets.
 *
 * `issue-455-theme-sync-repaints`: the number first because that is what makes
 * it sortable and greppable, then enough of the title to recognise it in a
 * branch list six days later. Truncated on a word boundary rather than
 * mid-word — `issue-455-theme-sync-rep` reads like a typo.
 *
 * Everything git refuses is stripped rather than escaped: a branch name is not
 * a place to be clever, and `gh` will happily hand back a title containing a
 * slash, a colon or an emoji.
 */
export function branchNameFor(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = slug.split("-").filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (const w of words) {
    // 44 rather than 38: the shorter budget cut "tmux" off the end of
    // "theme sync repaints the user's own tmux", which is the word that made
    // the branch recognisable. A whole phrase reads; a truncated one is noise.
    if (len + w.length + 1 > 44 && out.length) break;
    out.push(w);
    len += w.length + 1;
  }
  const tail = out.join("-");
  return tail ? `issue-${number}-${tail}` : `issue-${number}`;
}

/**
 * Where the worktree goes: beside the repository, not inside it.
 *
 * Inside would put it in the repository's own ignore rules, its own file
 * watchers and its own `rg` results — every tool in this app would then see two
 * copies of the codebase. Beside is what the app's own worktrees already do
 * (`agentglass-ff`, `agentglass-dr`), so it matches what is already there.
 */
export function worktreePathFor(root: string, number: number, title: string): string {
  const parent = dirname(root);
  const name = basename(root).replace(/\.git$/, "");
  const slug = branchNameFor(number, title);
  return join(parent, `${name}-${slug}`);
}

// ------------------------------------------------------------- the state ----

const STATE_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
const STATE_FILE = join(STATE_DIR, "issue-work.json");

type StateFile = Record<string, IssueWork>;
const stateKey = (repo: string, number: number) => `${repo}#${number}`;

function readState(): StateFile {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile; } catch { return {}; }
}

function writeState(s: StateFile): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
  } catch { /* remembering is a nicety; failing to start over it is not */ }
}

/**
 * What is still on disk.
 *
 * The file is a record of intent; the filesystem is the truth. A worktree
 * removed by hand — which is exactly what somebody who has been burned by
 * leftovers will do — must not leave the panel claiming work is in progress,
 * so every read drops entries whose directory is gone.
 */
export function currentWork(repo?: string): IssueWork[] {
  const s = readState();
  const live: StateFile = {};
  let dropped = false;
  for (const [k, w] of Object.entries(s)) {
    if (existsSync(w.path)) live[k] = w; else dropped = true;
  }
  if (dropped) writeState(live);
  return Object.values(live).filter((w) => !repo || w.repo === repo);
}

// -------------------------------------------------------------- the reads ----

const LIST_FIELDS = "number,title,state,author,labels,assignees,comments,updatedAt,url";

function normalise(raw: any, repo: string, work: IssueWork[]): IssueRow {
  return {
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    state: String(raw.state ?? "OPEN").toUpperCase(),
    author: String(raw.author?.login ?? ""),
    labels: (raw.labels ?? []).map((l: any) => ({ name: String(l.name ?? ""), color: String(l.color ?? "") })),
    assignees: (raw.assignees ?? []).map((a: any) => String(a.login ?? "")),
    comments: typeof raw.comments === "number" ? raw.comments : (raw.comments?.length ?? 0),
    updatedAt: String(raw.updatedAt ?? ""),
    url: String(raw.url ?? ""),
  };
  void repo; void work;
}

/** The repository `gh` would act on from this directory. */
async function repoOf(root: string): Promise<string | null> {
  const r = await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], root);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export async function listIssues(rootIn: unknown, opts: { state?: string; assignee?: string; search?: string; limit?: number } = {}): Promise<IssuesReport> {
  const root = safeAbs(rootIn);
  if (!root) return { ok: false, issues: [], error: "no directory given" };
  if (!inScope(root)) return { ok: false, issues: [], error: "outside the open project" };

  const args = ["issue", "list", "--json", LIST_FIELDS, "--limit", String(Math.min(200, opts.limit ?? 60))];
  // `--state all` rather than two calls: the panel's Open/Closed toggle is a
  // filter over one answer, so switching it costs nothing.
  args.push("--state", opts.state === "closed" ? "closed" : opts.state === "all" ? "all" : "open");
  if (opts.assignee) args.push("--assignee", opts.assignee);
  if (opts.search) args.push("--search", opts.search);

  const r = await gh(args, root);
  if (r.code !== 0) return { ok: false, issues: [], error: r.stderr.trim() || "gh failed" };
  try {
    const repo = (await repoOf(root)) ?? "";
    const work = currentWork(repo);
    const rows = (JSON.parse(r.stdout) as any[]).map((x) => normalise(x, repo, work));
    return { ok: true, issues: rows };
  } catch (e) {
    return { ok: false, issues: [], error: String(e) };
  }
}

export async function issueDetail(rootIn: unknown, numberIn: unknown): Promise<{ ok: boolean; issue?: IssueDetail; error?: string }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  if (!root || !Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid request" };
  if (!inScope(root)) return { ok: false, error: "outside the open project" };

  const r = await gh(["issue", "view", String(number), "--json", `${LIST_FIELDS},body,createdAt,milestone`], root);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "gh failed" };
  try {
    const raw = JSON.parse(r.stdout);
    const repo = (await repoOf(root)) ?? "";
    const work = currentWork(repo).find((w) => w.number === number) ?? null;
    return {
      ok: true,
      issue: {
        ...normalise(raw, repo, []),
        body: String(raw.body ?? ""),
        createdAt: String(raw.createdAt ?? ""),
        milestone: raw.milestone?.title ?? null,
        work,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// the pull requests an issue produced
// ---------------------------------------------------------------------------

/*
 * The other direction of the link the pull-request panel already draws.
 *
 * A pull request says which issues it closes — `closingIssuesReferences`, read
 * in prs.ts and shown as "Merging this closes: #123". Standing on the ISSUE
 * there was nothing, which is the half you are on when you want to know
 * whether somebody is already doing this.
 *
 * Worth contrasting with the ClickUp version of the same feature, which had to
 * GUESS: ClickUp's API exposes no link to a pull request, so cardPullRequests
 * searches GitHub for the card id and hopes the team names its branches after
 * it. Here the link is a real edge in GitHub's own graph, so nothing is
 * guessed and nothing depends on a naming convention.
 *
 * Two kinds of edge arrive, and they are NOT the same claim:
 *
 *   CONNECTED_EVENT        somebody linked this pull request to this issue —
 *                          a deliberate act, and the one that closes it
 *   CROSS_REFERENCED_EVENT a pull request mentioned `#123` somewhere. Often
 *                          "related to", sometimes just a changelog line.
 *
 * Reported apart rather than merged, for the reason `stated` exists on a
 * ClickUp card: a mention shown as "this closes your issue" is a promise
 * nobody made.
 *
 * DISCONNECTED_EVENT is asked for so that unlinking is honoured. The timeline
 * is a log, not a state — a link that was made and then removed still has its
 * CONNECTED_EVENT sitting in it forever, so without this an issue keeps
 * advertising a pull request somebody deliberately detached from it.
 */
const ISSUE_PRS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      timelineItems(first:100, itemTypes:[CONNECTED_EVENT, DISCONNECTED_EVENT, CROSS_REFERENCED_EVENT]){
        nodes{
          __typename
          ... on ConnectedEvent{ subject{ ... on PullRequest{ number title state url isDraft } } }
          ... on DisconnectedEvent{ subject{ ... on PullRequest{ number } } }
          ... on CrossReferencedEvent{ source{ ... on PullRequest{ number title state url isDraft } } }
        }
      }
    }
  }
}`;

interface RawPr { number?: number; title?: string; state?: string; url?: string; isDraft?: boolean }

interface IssuePrsAnswer {
  data?: {
    repository?: {
      issue?: {
        timelineItems?: {
          nodes?: ({ __typename?: string; subject?: RawPr; source?: RawPr } | null)[];
        };
      };
    };
  };
}

export async function issuePullRequests(
  rootIn: unknown, numberIn: unknown,
): Promise<{ ok: boolean; prs: IssuePr[]; error?: string }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  if (!root || !Number.isInteger(number) || number <= 0) return { ok: false, prs: [], error: "invalid request" };
  if (!inScope(root)) return { ok: false, prs: [], error: "outside the open project" };

  const repo = await repoOf(root);
  const [owner, name] = (repo ?? "").split("/");
  if (!owner || !name) return { ok: false, prs: [], error: "no GitHub repository here" };

  const r = await ghGraphql<IssuePrsAnswer>(ISSUE_PRS_QUERY, { owner, name, number });
  // Null is the transport failing, which is not an issue with no pull
  // requests. The caller has to be able to tell those apart — see the panel,
  // where one renders nothing and the other says so.
  if (!r?.data?.repository?.issue) return { ok: false, prs: [], error: "could not ask GitHub" };
  return { ok: true, prs: prsFromTimeline(r.data.repository.issue.timelineItems?.nodes ?? []) };
}

/**
 * The timeline reduced to a list of pull requests, separated from the fetching.
 *
 * Split out because the reduction is the part with rules in it and the fetch is
 * the part that needs a network: what has to be got right here is which events
 * outrank which, and none of that has anything to do with HTTP.
 *
 * A timeline is a LOG. Every rule below is a consequence of that one fact —
 * the same pull request can appear several times, in any order, saying
 * different things each time, and only the sum of them is the truth.
 */
export function prsFromTimeline(
  nodes: ({ __typename?: string; subject?: RawPr; source?: RawPr } | null | undefined)[],
): IssuePr[] {
  const out = new Map<number, IssuePr>();
  const detached = new Set<number>();
  for (const node of nodes) {
    if (!node) continue;
    const raw = node.subject ?? node.source;
    const n = Number(raw?.number);
    // A timeline node for an ISSUE rather than a pull request. Cross-references
    // between issues are ordinary and arrive here as an inline fragment that
    // matched nothing, so there is no number to read.
    if (!Number.isInteger(n) || n <= 0) continue;
    if (node.__typename === "DisconnectedEvent") { detached.add(n); continue; }
    const linked = node.__typename === "ConnectedEvent";
    // Re-linking after a detach is a LATER event than the detach, so the last
    // word wins rather than the first.
    if (linked) detached.delete(n);
    // Nothing to show and nowhere to send a click. A disconnect above is still
    // honoured, because it says something even when the node carries no detail.
    if (!raw?.url) continue;
    const had = out.get(n);
    out.set(n, {
      number: n,
      title: String(raw.title ?? ""),
      state: String(raw.state ?? "").toUpperCase(),
      url: String(raw.url),
      draft: raw.isDraft === true,
      // Once linked, always linked. A pull request that closes an issue and
      // also mentions it in a comment produces both events, and whichever
      // happens to come last must not decide the claim.
      linked: linked || had?.linked === true,
    });
  }

  // Linked first, then newest — the one somebody is looking for is the one
  // that is actually going to close this.
  return [...out.values()]
    .filter((p) => !detached.has(p.number))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.number - a.number);
}

// ------------------------------------------------------------ the writes ----

export interface StartResult {
  ok: boolean;
  error?: string;
  work?: IssueWork;
  /** What to run in the window, when the mode wants one. The server builds it;
   *  the client never sends a command to execute. */
  prompt?: string;
  cwd?: string;
}

/**
 * The prompt an agent is started with.
 *
 * A URL and an instruction, not a paste of the issue: the agent has `gh` and
 * can read the thing itself, and a body pasted into a prompt is a body that is
 * already out of date. "Plan before touching anything" because the first turn
 * on an unfamiliar issue should be reading, and because a plan is cheap to
 * throw away and a branch full of wrong edits is not.
 */
function promptFor(repo: string, number: number, mode: StartMode): string {
  const url = `https://github.com/${repo}/issues/${number}`;
  if (mode === "plan") {
    return `Read ${url}. READ ONLY — do not edit, create or run anything that writes. `
      + `Tell me what would have to change, in what order, and what you are unsure about.`;
  }
  return `Read ${url} and work on it in this worktree. `
    + `Start by telling me the plan and what you are unsure about; do not start editing until I say go.`;
}

/**
 * Start work on an issue.
 *
 * Every mode except `branch` cuts a worktree beside the repository. Nothing
 * here talks to tmux: opening a window belongs to the terminal socket, which
 * already knows how (it is how a pull-request review opens one), and giving a
 * second component the ability to spawn windows is how two of them end up
 * disagreeing about which session is yours.
 */
export async function startIssue(rootIn: unknown, numberIn: unknown, modeIn: unknown): Promise<StartResult> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  const mode = (["worktree", "shell", "claude", "plan", "branch"] as const).find((m) => m === modeIn) ?? "claude";
  if (!root || !Number.isInteger(number) || number <= 0) return { ok: false, error: "invalid request" };
  if (!inScope(root)) return { ok: false, error: "outside the open project" };

  const d = await issueDetail(root, number);
  if (!d.ok || !d.issue) return { ok: false, error: d.error ?? "could not read that issue" };
  const repo = (await repoOf(root)) ?? "";
  const branch = branchNameFor(number, d.issue.title);

  // Already going: hand back what exists rather than cutting a second one.
  const existing = currentWork(repo).find((w) => w.number === number);
  if (existing) return { ok: true, work: existing, cwd: existing.path, prompt: promptFor(repo, number, mode) };

  if (mode === "branch") {
    // No worktree at all — the five-minute-fix path. Refused on a dirty tree:
    // switching branches under uncommitted work is how you lose it.
    const st = git(root, ["status", "--porcelain"]);
    if (st.stdout.trim()) return { ok: false, error: "this checkout has uncommitted changes — commit, stash, or start a worktree instead" };
    const sw = git(root, ["switch", "-c", branch]);
    if (sw.code !== 0) return { ok: false, error: sw.stderr.trim() || "could not create the branch" };
    const work: IssueWork = { number, repo, branch, path: root, mode, startedAt: Date.now() };
    const s = readState(); s[stateKey(repo, number)] = work; writeState(s);
    return { ok: true, work, cwd: root, prompt: promptFor(repo, number, mode) };
  }

  const path = worktreePathFor(root, number, d.issue.title);
  if (existsSync(path)) return { ok: false, error: `${path} already exists` };
  const r = addWorktree(root, path, branch, true);
  if (!r.ok) return { ok: false, error: r.error ?? "could not create the worktree" };

  const work: IssueWork = { number, repo, branch, path, mode, startedAt: Date.now() };
  const s = readState(); s[stateKey(repo, number)] = work; writeState(s);
  return { ok: true, work, cwd: path, prompt: promptFor(repo, number, mode) };
}

/**
 * Put it away.
 *
 * The whole reason the state file exists. Refuses while there is uncommitted
 * work unless told twice — losing an afternoon to a tidy-up button is a worse
 * outcome than a worktree living one day too long.
 */
export async function finishIssue(rootIn: unknown, numberIn: unknown, force = false): Promise<{ ok: boolean; error?: string; detail?: string; dirty?: string[] }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  if (!root || !Number.isInteger(number)) return { ok: false, error: "invalid request" };
  const repo = (await repoOf(root)) ?? "";
  const work = currentWork(repo).find((w) => w.number === number);
  if (!work) return { ok: false, error: "nothing is in progress for that issue" };

  if (work.mode === "branch") {
    return { ok: false, error: "this one is a branch in the main checkout, not a worktree — switch away and delete it yourself" };
  }

  const st = git(work.path, ["status", "--porcelain"]);
  const dirty = st.stdout.split("\n").map((l) => l.slice(3)).filter(Boolean);
  if (dirty.length && !force) {
    return { ok: false, error: `${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"} in that worktree`, dirty: dirty.slice(0, 12) };
  }

  const rm = removeWorktree(root, work.path, force);
  if (!rm.ok) return { ok: false, error: rm.error ?? "could not remove the worktree" };
  // The branch only goes if it is merged, unless forced. `-d` refuses an
  // unmerged branch, which is exactly the check wanted here.
  const del = git(root, ["branch", force ? "-D" : "-d", work.branch]);

  const s = readState();
  delete s[stateKey(repo, number)];
  writeState(s);

  return {
    ok: true,
    detail: del.code === 0
      ? `Removed the worktree and deleted ${work.branch}`
      : `Removed the worktree — ${work.branch} is not merged, so it was kept`,
  };
}

/** Take the issue: assign it to the caller and say so, which is the half of
 *  "I am on this" that happens outside the code. */
export async function claimIssue(rootIn: unknown, numberIn: unknown, comment?: unknown): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  if (!root || !Number.isInteger(number)) return { ok: false, error: "invalid request" };
  if (!inScope(root)) return { ok: false, error: "outside the open project" };
  const a = await gh(["issue", "edit", String(number), "--add-assignee", "@me"], root);
  if (a.code !== 0) return { ok: false, error: a.stderr.trim() || "could not assign it" };
  const text = typeof comment === "string" ? comment.trim() : "";
  if (text) {
    const c = await gh(["issue", "comment", String(number), "--body", text], root);
    if (c.code !== 0) return { ok: true, detail: "Assigned, but the comment failed" };
  }
  return { ok: true, detail: text ? "Assigned and commented" : "Assigned to you" };
}

export async function commentIssue(rootIn: unknown, numberIn: unknown, body: unknown): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  const text = typeof body === "string" ? body.trim() : "";
  if (!root || !Number.isInteger(number) || !text) return { ok: false, error: "invalid request" };
  if (!inScope(root)) return { ok: false, error: "outside the open project" };
  const r = await gh(["issue", "comment", String(number), "--body", text], root);
  return r.code === 0 ? { ok: true, detail: "Comment posted" } : { ok: false, error: r.stderr.trim() || "could not comment" };
}

export async function setIssueState(rootIn: unknown, numberIn: unknown, close: boolean): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const root = safeAbs(rootIn);
  const number = Number(numberIn);
  if (!root || !Number.isInteger(number)) return { ok: false, error: "invalid request" };
  if (!inScope(root)) return { ok: false, error: "outside the open project" };
  const r = await gh(["issue", close ? "close" : "reopen", String(number)], root);
  return r.code === 0
    ? { ok: true, detail: close ? "Closed" : "Reopened" }
    : { ok: false, error: r.stderr.trim() || "could not change the state" };
}
