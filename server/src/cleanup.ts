// After a pull request ends: the local leftovers it leaves behind, as a plan
// first and a run second.
//
// A merged branch leaves a checkout, a branch, stashes, containers, images,
// scratch databases, evidence folders and notes. Doing it by hand is how the
// wrong container gets stopped, so this builds a DRY-RUN plan from live state
// and executes only the plan whose id the caller sends back. The id is a hash
// of what the plan would do and the worktree's HEAD: if anything moved between
// the dry run and the run, the ids differ and nothing runs.
//
// Everything repo-specific (container names to keep, image tag shape, database
// prefix and command, evidence and notes folders, where briefs and the worklog
// live) is a per-project setting with an EMPTY default: a step with nothing
// configured is skipped, never guessed. Slug-based steps match a name that
// CONTAINS the card id (not followed by another digit, so ORBIT-104 never
// matches ORBIT-1042) and delete by exact name, never by wildcard.
//
// Every external program goes through the injected `Runner` and `gh`, so a test
// fakes docker/gh/tmux and runs real git in temp directories.
//
// WHAT IT CANNOT DO, on purpose: kill a session (only a tab of idle shells in
// the checkout is closed; anything running is a block), touch anything remote
// or on a tracker, or run `docker compose down`. Ceilings: the
// card slug is read from the branch's own prefix only (`feat/orbit-1042` has
// none); the psql command is split on spaces, no quoting; ignored files in the
// checkout (node_modules, .env) go with it.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { anyInside, parseDockerSize, spawnRunner, type DiskCtx, type Runner } from "./diskclean.ts";
import { cleanupCardLines } from "../../shared/cleanupCard.ts";
import { parseWorktreeList } from "./gitwork.ts";
import { gh as ghDefault } from "./prs.ts";

// ------------------------------------------------------------- settings ----

export interface CleanupConfig {
  /** Container names that are never stopped or removed, whatever their name says. */
  sharedContainerNames: string[];
  /** An exact image ref with `{slug}` in it, tried besides the images whose tag contains the slug. */
  dockerImageTagTemplate: string;
  /** Test databases start with this; empty skips the step. */
  testDbPrefix: string;
  /** The psql command (words split on spaces) that lists and drops them; empty skips the step. */
  testDbCommand: string;
  /** Where stash patches are saved before a stash is dropped; empty: the state directory. */
  stashArchiveDir: string;
  /** Templates ending in a folder name with `{slug}`; the folder above is listed for names that contain the slug. */
  evidenceDirs: string[];
  notesDirs: string[];
  /** A note is transient only when its name holds the slug AND one of these (`-ci-`). */
  transientMarkers: string[];
  briefsDir: string;
  worklogDir: string;
  /** The kinds of leftover the plan may hold; one not listed is omitted (not a block). Its own setting, `cleanup.include`. */
  include: CleanupGroup[];
  /**
   * Folders that hold evidence for many cards (`~/Documents/projects/orbit`). A folder directly inside one whose name
   * starts with the card id or the PR branch is the card's evidence. Empty finds nothing. Its own setting, `cleanup.evidenceRoots`.
   */
  evidenceRoots: string[];
  /**
   * Leftovers of a card whose name does not START with the card id (`~/code/orbit-pol-master-{number}*`: a baseline checkout named
   * by the card's digits). The last segment is a name or a glob with `{card}` (ORBIT-1042) and/or `{number}` (1042); the folder
   * above it is literal. Empty finds nothing. Its own setting, `cleanup.otherFolders`.
   */
  otherFolders: string[];
}

/** What a person ticks. test databases ride with docker, briefs with notes, the fetch with the branch. */
export const CLEANUP_GROUPS = ["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch", "agent-history"] as const;
export type CleanupGroup = (typeof CLEANUP_GROUPS)[number];
/** On unless the person ticks it: the transcripts are what the person resumes from. */
export const DEFAULT_CLEANUP_INCLUDE: CleanupGroup[] = CLEANUP_GROUPS.filter((g) => g !== "agent-history");
/** `cleanup.include` as the door validates it. */
export function parseCleanupInclude(raw: unknown): { value: CleanupGroup[] } | { error: string } {
  if (!Array.isArray(raw) || raw.some((x) => !(CLEANUP_GROUPS as readonly unknown[]).includes(x))) return { error: `a list of ${CLEANUP_GROUPS.join(", ")}` };
  return { value: CLEANUP_GROUPS.filter((g) => raw.includes(g)) };
}
const GROUP_OF: Partial<Record<CleanupKind, CleanupGroup>> = {
  "docker-container": "docker", "docker-volume": "docker", "docker-image": "docker", "test-db": "docker", worktree: "worktree", branch: "branch", "fetch-prune": "branch",
  stash: "stashes", evidence: "evidence", note: "notes", brief: "notes", tab: "tab",
  "agent-scratch": "agent-scratch", "agent-history": "agent-history", "other-folder": "worktree",
};

export const EMPTY_CLEANUP_CONFIG: CleanupConfig = {
  sharedContainerNames: [], dockerImageTagTemplate: "", testDbPrefix: "", testDbCommand: "", stashArchiveDir: "",
  evidenceDirs: [], notesDirs: [], transientMarkers: [], briefsDir: "", worklogDir: "", include: DEFAULT_CLEANUP_INCLUDE, evidenceRoots: [], otherFolders: [],
};

const PATHY = ["stashArchiveDir", "briefsDir", "worklogDir"] as const;
const LISTS = ["sharedContainerNames", "evidenceDirs", "notesDirs", "transientMarkers"] as const;
const absOrHome = (p: string) => isAbsolute(p) || p.startsWith("~/");

/** A config as the settings door stores it, or why not. Unknown keys are refused so a typo cannot read as "unset". */
export type CleanupConfigBody = Omit<CleanupConfig, "include" | "evidenceRoots" | "otherFolders">;
/** `cleanup.evidenceRoots` as the door validates it: absolute (or ~/) folders, never the filesystem root or a home directory itself. */
export function parseCleanupEvidenceRoots(raw: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > 50 || raw.some((x) => typeof x !== "string" || !x.trim() || x.length > 500 || x.includes("\0"))) return { error: "a list of up to 50 folders" };
  const out = [...new Set((raw as string[]).map((x) => x.trim().replace(/\/+$/, "")))];
  for (const p of out) {
    if (!absOrHome(p) || p === "" || p === "~" || p.split("/").includes("..")) return { error: `${p || "/"} is not an absolute folder (or ~/...) without ..` };
    if (p.split("/").filter(Boolean).length < 2) return { error: `${p} is too broad to be an evidence folder` };
  }
  return { value: out };
}
/** The own settings of `CleanupConfig`: they are not part of the `cleanup.config` body. */
const OWN_SETTING = ["include", "evidenceRoots", "otherFolders"];
/**
 * `cleanup.otherFolders` as the door validates it: `<absolute or ~/ folder>/<name or glob>`, the folder literal and at least two
 * deep (never a home or a top folder), the name holding `{card}` or `{number}` so a pattern can never be one fixed folder for
 * every card.
 */
export function parseCleanupOtherFolders(raw: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > 50 || raw.some((x) => typeof x !== "string" || !x.trim() || x.length > 500 || x.includes("\0"))) return { error: "a list of up to 50 patterns" };
  const out = [...new Set((raw as string[]).map((x) => x.trim().replace(/\/+$/, "")))];
  for (const p of out) {
    if (!absOrHome(p) || p.split("/").includes("..")) return { error: `${p} is not an absolute path (or ~/...) without ..` };
    const parent = dirname(p), leaf = basename(p);
    if (/[*?[\]{}]/.test(parent)) return { error: `${p}: the folder above the last name must be written out (no wildcards, no {card} or {number})` };
    if (parent.split("/").filter(Boolean).length < 2) return { error: `${p}: the parent folder is too broad (a home or top folder)` };
    if (!/\{(card|number)\}/.test(leaf)) return { error: `${p}: the last name must hold {card} or {number}` };
    if (/[{}]/.test(leaf.replace(/\{(card|number)\}/g, ""))) return { error: `${p}: only {card} and {number} may be written in braces` };
  }
  return { value: out };
}
export function parseCleanupConfig(raw: unknown): { value: CleanupConfigBody } | { error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "an object of cleanup settings" };
  const o = raw as Record<string, unknown>;
  const { include: _kinds, evidenceRoots: _roots, otherFolders: _other, ...empty } = EMPTY_CLEANUP_CONFIG;
  const out: CleanupConfigBody = { ...empty, sharedContainerNames: [], evidenceDirs: [], notesDirs: [], transientMarkers: [] };
  for (const k of Object.keys(o)) if (!(k in EMPTY_CLEANUP_CONFIG) || OWN_SETTING.includes(k)) return { error: `unknown cleanup setting "${k}"${OWN_SETTING.includes(k) ? ` (it is the setting cleanup.${k})` : ""}` };
  for (const k of Object.keys(empty) as (keyof CleanupConfigBody)[]) {
    const v = o[k];
    if (v === undefined) continue;
    if ((LISTS as readonly string[]).includes(k)) {
      if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string" || !x || x.length > 500 || x.includes("\0"))) return { error: `${k}: a list of up to 50 non-empty strings` };
      (out[k] as string[]) = v as string[];
    } else {
      if (typeof v !== "string" || v.length > 500 || v.includes("\0")) return { error: `${k}: a string` };
      (out[k] as string) = v.trim();
    }
  }
  for (const k of PATHY) if (out[k] && !absOrHome(out[k])) return { error: `${k}: an absolute path (or ~/...)` };
  for (const k of ["evidenceDirs", "notesDirs"] as const) for (const p of out[k]) if (!absOrHome(p)) return { error: `${k}: ${p} is not an absolute path (or ~/...)` };
  for (const t of out.evidenceDirs) {
    const leaf = basename(t), parent = dirname(t);
    if (!leaf.includes("{slug}") || parent.includes("{slug}")) return { error: `evidenceDirs: ${t} must have {slug} in its last folder name only` };
  }
  for (const n of out.sharedContainerNames) if (!/^[\w.-]+$/.test(n)) return { error: `sharedContainerNames: ${n} is not a container name` };
  if (out.testDbPrefix && !/^[A-Za-z0-9_]+$/.test(out.testDbPrefix)) return { error: "testDbPrefix: letters, digits and _ only" };
  if (out.dockerImageTagTemplate && !out.dockerImageTagTemplate.includes("{slug}")) return { error: "dockerImageTagTemplate: must contain {slug}" };
  if (out.transientMarkers.some((m) => m.includes("/"))) return { error: "transientMarkers: no slashes" };
  return { value: out };
}

// ---------------------------------------------------------------- types ----

export type CleanupKind =
  | "tab" | "docker-container" | "docker-volume" | "docker-image" | "test-db" | "worktree" | "branch" | "fetch-prune"
  | "stash" | "evidence" | "note" | "brief" | "own-state" | "worklog" | "agent-scratch" | "agent-history" | "other-folder";

export interface CleanupItem { id: string; kind: CleanupKind; target: string; detail: string; bytes?: number }
export type BlockKind =
  | "pr-open" | "dirty" | "unpushed" | "open-pr-on-branch" | "stacked-pr" | "live-session" | "main-checkout" | "default-branch" | "unreadable";
export interface CleanupBlock { kind: BlockKind; why: string; files?: string[] }

export interface CleanupPlan {
  id: string;
  repo: string;
  pr: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  /** When GitHub merged it (ms); null when not merged or unknown. Not part of the plan id. */
  mergedAt: number | null;
  /** Closed without a merge: a run needs `confirmNotMerged`. */
  notMerged: boolean;
  branch: string;
  worktree: string | null;
  slug: string | null;
  head: string;
  /** The kinds this plan was made for (the setting at plan time). */
  include: CleanupGroup[];
  items: CleanupItem[];
  blocks: CleanupBlock[];
  notes: string[];
}

export interface CleanupItemResult { id: string; kind: CleanupKind; target: string; status: "done" | "failed" | "warn" | "skipped"; detail: string; bytes?: number }
export interface CleanupReport {
  ok: boolean; planId: string; items: CleanupItemResult[]; freedBytes: number; failed: number; summary: string;
  /**
   * A fresh plan read the moment the run ended: what is STILL there (ticked kinds only; the app's own bookkeeping row is not
   * a leftover). Empty = cleaned up. Null when the re-read itself failed, which says nothing about the leftovers.
   */
  remaining: { items: CleanupItem[]; bytes: number; blocks: CleanupBlock[] } | null;
}

export class CleanupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface CleanupCtx {
  home: string;
  now: number;
  run: Runner;
  gh: (args: string[], cwd?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** The user id the agent's scratch folder is under (`~/.cache/claude-tmp/<uid>`); the process's own when absent. */
  uid?: number;
  /** agentglass's own state dir: the default home of the stash archive. */
  stateDir: string;
  procDir?: DiskCtx["procDir"];
  tmuxSockets?: DiskCtx["tmuxSockets"];
  /** Forget what agentglass keeps about the pull request and its checkout; returns the rows removed. */
  forgetOwnState?: (a: { repo: string; pr: number; worktree: string | null }) => number;
}

export function defaultCleanupCtx(over: Partial<CleanupCtx> = {}): CleanupCtx {
  const state = process.env.AGENTGLASS_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return { home: homedir(), now: Date.now(), run: spawnRunner, gh: (a, cwd) => ghDefault(a, cwd), stateDir: state, ...over };
}

// -------------------------------------------------------------- helpers ----

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The card id before the first non-alphanumeric dash-digit run: ORBIT-1042-fix-x -> ORBIT-1042. Too short or digit-less is no slug. */
export function slugOf(branch: string): string | null {
  const m = /^([A-Za-z]+-\d+)/.exec(branch);
  return m && m[1]!.length >= 4 && /\d/.test(m[1]!) ? m[1]! : null;
}
/** Contains the slug, not glued to another letter or digit on either side. */
export function matchesSlug(name: string, slug: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(slug)}(?!\\d)`, "i").test(name);
}
const expand = (p: string, home: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const git = (c: CleanupCtx, dir: string, args: string[]) => c.run("git", ["-C", dir, ...args], { timeoutMs: 60_000 });
const inside = (parent: string, p: string) => p !== parent && p.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/** The one door for removing a path built from a name: the name is a single non-empty segment and the parent is absolute. */
export function removeUnder(parent: string, name: string): string {
  if (!isAbsolute(parent) || parent === "/" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`refusing to remove "${name}" under "${parent}"`);
  }
  const target = join(parent, name);
  if (dirname(target) !== resolve(parent)) throw new Error(`refusing to remove "${target}": not directly under ${parent}`);
  rmSync(target, { recursive: true, force: true });
  return target;
}

/** The entries of `dir` whose name satisfies `ok`, never following a link. */
function listEntries(dir: string, home: string, ok: (name: string) => boolean): string[] {
  if (!isAbsolute(dir) || dir === "/" || dir === home || dir === dirname(home)) return [];
  try { return readdirSync(dir).filter((n) => !n.startsWith(".") && ok(n)).sort(); } catch { return []; }
}

async function sizeOf(c: CleanupCtx, paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!paths.length) return out;
  const r = await c.run("du", ["-sb", ...paths], { timeoutMs: 60_000 });
  for (const l of r.stdout.split("\n")) { const m = /^(\d+)\t(.+)$/.exec(l); if (m) out.set(m[2]!, Number(m[1])); }
  return out;
}

const item = (kind: CleanupKind, target: string, detail: string, bytes?: number): CleanupItem =>
  ({ id: `${kind}:${target}`, kind, target, detail, ...(bytes ? { bytes } : {}) });

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ----------------------------------------------------------------- plan ----

interface PrFacts { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt: number | null; mergeOid: string; headRefName: string; headRefOid: string; baseRefName: string; title: string; url: string }

async function prFacts(c: CleanupCtx, repo: string, pr: number): Promise<PrFacts> {
  const r = await c.gh(["pr", "view", String(pr), "--json", "state,mergedAt,mergeCommit,headRefName,headRefOid,baseRefName,title,url"], repo);
  if (r.code !== 0) throw new CleanupError(`gh could not read pull request #${pr}: ${r.stderr.trim().split("\n")[0] || "no answer"}`, 502);
  try {
    const j = JSON.parse(r.stdout);
    const state = j.state === "MERGED" || j.mergedAt ? "MERGED" : j.state === "CLOSED" ? "CLOSED" : "OPEN";
    return { state, mergedAt: Date.parse(String(j.mergedAt ?? "")) || null, mergeOid: String(j.mergeCommit?.oid ?? ""), headRefName: String(j.headRefName ?? ""), headRefOid: String(j.headRefOid ?? ""), baseRefName: String(j.baseRefName ?? ""), title: String(j.title ?? ""), url: String(j.url ?? "") };
  } catch { throw new CleanupError(`gh answered pull request #${pr} in a shape this build cannot read`, 502); }
}

const isAncestor = async (c: CleanupCtx, dir: string, a: string, b: string) => (await git(c, dir, ["merge-base", "--is-ancestor", a, b])).code === 0;

/** The blocks that need git and gh; the cheap ones (main checkout, default branch) are in planCleanup. */
async function safetyBlocks(c: CleanupCtx, main: string, wt: string | null, head: string, branch: string, pr: number, p: PrFacts): Promise<CleanupBlock[]> {
  const blocks: CleanupBlock[] = [];
  if (wt) {
    const st = await git(c, wt, ["status", "--porcelain"]);
    if (st.code !== 0) blocks.push({ kind: "unreadable", why: `git could not read the checkout ${wt}` });
    else if (st.stdout.trim()) {
      // not lines(): the status code's leading space is part of the column layout
      const files = st.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
      blocks.push({ kind: "dirty", why: `${files.length} file${files.length === 1 ? "" : "s"} with changes that are not committed`, files: files.slice(0, 20) });
    }
  }
  if (head) {
    const covers = [p.mergeOid, p.headRefOid, `refs/remotes/origin/${branch}`].filter(Boolean);
    let trusted = head === p.headRefOid;
    for (const ref of covers) if (!trusted && (await isAncestor(c, main, head, ref))) trusted = true;
    if (!trusted) {
      const known: string[] = [];
      for (const ref of covers) if ((await git(c, main, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) known.push(ref);
      const log = await git(c, main, ["log", "--format=%h %s", "-n", "10", head, "--not", ...known]);
      blocks.push({ kind: "unpushed", why: `commits on ${branch} that are not in pull request #${pr} or on origin (if the merge commit is not fetched yet, fetch first)`, files: lines(log.stdout) });
    }
  }
  const open = await c.gh(["pr", "list", "--state", "open", "--json", "number,headRefName,baseRefName", "--limit", "200"], main);
  if (open.code !== 0) blocks.push({ kind: "unreadable", why: "gh could not list the open pull requests, so it is not known whether another one uses this branch" });
  else {
    let rows: { number: number; headRefName: string; baseRefName: string }[] = [];
    try { rows = JSON.parse(open.stdout); } catch { blocks.push({ kind: "unreadable", why: "gh answered the open pull request list in a shape this build cannot read" }); }
    const own = rows.filter((r) => r.number !== pr);
    const onHead = own.filter((r) => r.headRefName === branch), onBase = own.filter((r) => r.baseRefName === branch);
    if (onHead.length) blocks.push({ kind: "open-pr-on-branch", why: `open pull request ${onHead.map((r) => `#${r.number}`).join(", ")} has ${branch} as its head` });
    if (onBase.length) blocks.push({ kind: "stacked-pr", why: `open pull request ${onBase.map((r) => `#${r.number}`).join(", ")} is stacked on ${branch}` });
  }
  return blocks;
}

interface Pane { sock: number; session: string; windowId: string; window: string; cwd: string; cmd: string; pid: string }
const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "nu"]);
const WINDOW_ID = /^@\d+$/;

async function panesOf(c: CleanupCtx): Promise<Pane[]> {
  const out: Pane[] = [];
  const socks: string[][] = [[], ...(c.tmuxSockets?.() ?? [])];
  for (const [sock, s] of socks.entries()) {
    const r = await c.run("tmux", [...s, "list-panes", "-a", "-F", "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}"], { timeoutMs: 5_000 });
    if (r.code !== 0) continue;
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const [session = "", windowId = "", window = "", cwd = "", cmd = "", pid = ""] = l.split("\t");
      if (WINDOW_ID.test(windowId)) out.push({ sock, session, windowId, window, cwd, cmd, pid });
    }
  }
  return out;
}

/**
 * What is running in the card's tabs and checkout. A tab named after the card
 * whose every pane is an idle shell standing in the checkout is a `tab` item to
 * close; anything else there (a program, a pane elsewhere, a tab the plan was
 * told not to close, a process whose cwd is inside) is a live-session block.
 * Ceiling: "idle" is the pane's foreground command being a shell; a shell
 * that holds background jobs still counts through its children's cwd.
 */
async function liveSessions(c: CleanupCtx, wt: string | null, slug: string | null, tabOk: boolean): Promise<{ blocks: CleanupBlock[]; tabs: CleanupItem[] }> {
  const panes = await panesOf(c);
  const live: string[] = [], tabs: CleanupItem[] = [];
  const closing = new Set<Pane>(), skipPids = new Set<string>();
  const windows = new Map<string, Pane[]>();
  if (slug) for (const p of panes) if (matchesSlug(p.window, slug)) windows.set(`${p.sock}|${p.windowId}`, [...(windows.get(`${p.sock}|${p.windowId}`) ?? []), p]);
  for (const g of windows.values()) {
    const first = g[0]!, name = `${first.session}:${first.window}`;
    if (tabOk && wt && g.every((p) => SHELLS.has(p.cmd) && anyInside([p.cwd], wt))) {
      for (const p of g) { closing.add(p); skipPids.add(p.pid); }
      tabs.push(item("tab", `${name} (${first.windowId}${first.sock ? `, socket ${first.sock}` : ""})`, `close the tab: ${g.length} idle shell${g.length === 1 ? "" : "s"} in the checkout`));
    } else live.push(`tmux window ${name}`);
  }
  if (wt) {
    for (const p of panes) if (!closing.has(p) && anyInside([p.cwd], wt)) live.push(`a terminal pane in ${p.cwd}`);
    // /proc, like diskclean: a program whose cwd is inside the checkout keeps it busy
    let pids: string[] = [];
    try { pids = readdirSync(c.procDir ?? "/proc").filter((n) => /^\d+$/.test(n) && !skipPids.has(n)); } catch { /* no /proc here */ }
    for (const pid of pids) {
      try { const d = readlinkSync(join(c.procDir ?? "/proc", pid, "cwd")); if (anyInside([d], wt)) live.push(`a process (pid ${pid}) in ${d}`); } catch { /* gone, or not ours to read */ }
    }
  }
  const uniq = [...new Set(live)].slice(0, 10);
  return { blocks: uniq.length ? [{ kind: "live-session", why: "something is running in this card's checkout or tab; close it first", files: uniq }] : [], tabs };
}

async function dockerItems(c: CleanupCtx, cfg: CleanupConfig, slug: string, wt: string | null, notes: string[]): Promise<CleanupItem[]> {
  const ps = await c.run("docker", ["ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Image}}\t{{.Labels}}"], { timeoutMs: 20_000 });
  if (ps.code !== 0) { notes.push(`docker did not answer (${ps.stderr.trim().split("\n")[0] || "not installed"}): container, volume and image steps skipped`); return []; }
  const shared = new Set(cfg.sharedContainerNames);
  const cons = lines(ps.stdout).map((l) => {
    const [n, s, i, lab] = l.split("\t");
    return { name: (n ?? "").split(",")[0]!, running: s === "running", image: i ?? "", workdir: /(?:^|,)com\.docker\.compose\.project\.working_dir=([^,]+)/.exec(lab ?? "")?.[1] ?? "" };
  });
  const out: CleanupItem[] = [];
  const mine = new Set<string>();
  // Measured: names carry no card id, the image tag does. Compose labels are never a selector: the project is the same
  // for every checkout and the shared stack carries whichever working_dir last started it.
  for (const k of cons) {
    if (!matchesSlug(k.name, slug) && !matchesSlug(k.image, slug)) {
      if (wt && k.workdir === wt) notes.push(`container ${k.name} is attached to this checkout by a compose label, not removed`);
      continue;
    }
    if (shared.has(k.name)) { notes.push(`kept container ${k.name}: it is in sharedContainerNames`); continue; }
    mine.add(k.name);
    out.push(item("docker-container", k.name, `${k.running ? "running: stop, then remove" : "stopped: remove"} (${matchesSlug(k.image, slug) ? `image ${k.image}` : "name"} holds ${slug})`));
  }
  const vols = await c.run("docker", ["volume", "ls", "--format", "{{.Name}}"], { timeoutMs: 20_000 });
  for (const v of vols.code === 0 ? lines(vols.stdout) : []) if (matchesSlug(v, slug) && !shared.has(v)) out.push(item("docker-volume", v, "remove (Docker refuses while a container still uses it)"));

  const img = await c.run("docker", ["images", "--format", "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}"], { timeoutMs: 20_000 });
  const tmpl = cfg.dockerImageTagTemplate ? cfg.dockerImageTagTemplate.replaceAll("{slug}", slug).toLowerCase() : "";
  // Running containers that STAY: the ones this plan removes free their image.
  const staying = cons.filter((k) => k.running && !mine.has(k.name)).map((k) => k.image);
  for (const l of img.code === 0 ? lines(img.stdout) : []) {
    const [repo = "", tag = "", id = "", size = ""] = l.split("\t");
    if (!repo || repo === "<none>" || !tag || tag === "<none>") continue;
    const ref = `${repo}:${tag}`;
    if (!matchesSlug(ref, slug) && ref.toLowerCase() !== tmpl) continue;
    if (staying.some((s) => s === ref || s === id || (s.length >= 12 && id.startsWith(s)))) { notes.push(`kept image ${ref}: a running container still uses it`); continue; }
    out.push(item("docker-image", ref, "remove the image tag", parseDockerSize(size)));
  }
  return out;
}

/** `psql`-style: the command's words, then `-At -c <sql>`. Names are checked against a safe charset before they reach SQL. */
const SAFE_DB = /^[A-Za-z0-9_$-]+$/;
async function testDbItems(c: CleanupCtx, cfg: CleanupConfig, slug: string, notes: string[]): Promise<CleanupItem[]> {
  if (!cfg.testDbPrefix || !cfg.testDbCommand.trim()) return [];
  const [cmd, ...pre] = cfg.testDbCommand.trim().split(/\s+/);
  const r = await c.run(cmd!, [...pre, "-At", "-c", "SELECT datname FROM pg_database"], { timeoutMs: 20_000 });
  if (r.code !== 0) { notes.push(`the test database command failed (${r.stderr.trim().split("\n")[0] || r.code}): database step skipped`); return []; }
  return lines(r.stdout).filter((d) => d.startsWith(cfg.testDbPrefix) && matchesSlug(d, slug) && SAFE_DB.test(d)).map((d) => item("test-db", d, "DROP DATABASE"));
}

async function stashItems(c: CleanupCtx, main: string, branch: string): Promise<CleanupItem[]> {
  const r = await git(c, main, ["stash", "list", "--format=%H%x09%gs"]);
  if (r.code !== 0) return [];
  const own = new RegExp(`(?<![\\w/.-])${escapeRe(branch)}(?![\\w/.-])`);
  return lines(r.stdout).flatMap((l) => {
    const [sha = "", msg = ""] = l.split("\t");
    return sha && own.test(msg) ? [item("stash", sha, `${msg}: saved as a patch, then dropped`)] : [];
  });
}

/** The branch as a folder-name prefix: `Fix/Cleanup Gaps` -> `fix-cleanup-gaps`. Too short a branch is no prefix (`fix` would match every folder that starts with it). */
export function branchSlug(branch: string): string | null {
  const s = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length >= 8 ? s : null;
}
/** A folder under an evidence root is this card's when its name starts with the card id (not glued to another digit) or the branch slug (ending at a non-alphanumeric). Case-insensitive. */
export function evidenceNameMatches(name: string, slug: string | null, branch: string): boolean {
  const n = name.toLowerCase();
  const startsAt = (pre: string, digitsOnly: boolean) => n.startsWith(pre) && !new RegExp(digitsOnly ? "\\d" : "[a-z0-9]").test(n.charAt(pre.length));
  const b = branchSlug(branch);
  return (!!slug && startsAt(slug.toLowerCase(), true)) || (!!b && startsAt(b, false));
}
/** A card-named folder next to the worktree that git does not know: a container's baseline directory, made as root. Never one with a file in it, never a worktree (`.git`). */
function isEmptyShell(dir: string): boolean {
  if (existsSync(join(dir, ".git"))) return false;
  const empty = (d: string): boolean => readdirSync(d, { withFileTypes: true }).every((e) => e.isDirectory() && empty(join(d, e.name)));
  try { return empty(dir); } catch { return false; }
}
const evidenceRootsOf = (cfg: CleanupConfig, home: string): string[] => cfg.evidenceRoots.map((r) => resolve(expand(r, home)));

/**
 * The last segment of an `otherFolders` pattern as a matcher for one card. `{card}` is the card id not followed by another digit
 * (ORBIT-1042 is not ORBIT-10420); `{number}` is its digits, delimited by non-digits on both sides (1042 is not 10420 or 21042);
 * `*` and `?` stay inside one name. Case-insensitive.
 */
export function otherFolderRe(leaf: string, slug: string): RegExp {
  const digits = /\d+$/.exec(slug)?.[0] ?? slug;
  const body = leaf.split(/(\{card\}|\{number\}|\*|\?)/).map((t) => (
    t === "{card}" ? `${escapeRe(slug)}(?!\\d)` : t === "{number}" ? `(?<!\\d)${escapeRe(digits)}(?!\\d)` : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : escapeRe(t)
  )).join("");
  return new RegExp(`^${body}$`, "i");
}
/**
 * Why a folder an `otherFolders` pattern found must never be removed, or null. The main checkout, a folder that holds it or sits
 * inside it, the home directory and everything above it, and a folder directly in the home directory (the same rule the notes
 * folders follow: a pattern must name a parent that is not home). Ceiling: a baseline checkout made straight in home is not offered.
 */
export function otherFolderRefusal(path: string, main: string, home: string): string | null {
  if (path === main || inside(path, main) || inside(main, path)) return "it is the main checkout, or holds it, or sits inside it";
  if (path === home || inside(path, home)) return "it is the home directory or a folder above it";
  if (dirname(path) === home || path === "/") return "it is directly in the home directory: name a parent folder in the pattern";
  return null;
}
/** A match is a worktree of this repository, a git checkout of anything else (refused: a repository root), or a plain folder. */
const folderKindOf = (path: string, worktrees: readonly string[]): "worktree" | "repo" | "folder" =>
  worktrees.includes(path) ? "worktree" : existsSync(join(path, ".git")) ? "repo" : "folder";

/**
 * The folders this card's `otherFolders` patterns name. A refused match or pattern is a note, never an item; a worktree keeps the
 * dirty and live-session blocks of the card's own; a plain folder is checked for a live session too. Ceiling: patterns only look
 * one level down from a literal parent folder, and a symbolic link is never followed or removed.
 */
async function otherFolderItems(c: CleanupCtx, cfg: CleanupConfig, o: { main: string; slug: string | null; worktrees: string[]; known: Set<string>; notes: string[] }): Promise<{ items: CleanupItem[]; blocks: CleanupBlock[] }> {
  const { main, slug, worktrees, known, notes } = o;
  const out = { items: [] as CleanupItem[], blocks: [] as CleanupBlock[] };
  if (!cfg.otherFolders.length) return out;
  if (!slug) { notes.push("this branch has no card id prefix, so the other-folder patterns were not looked for"); return out; }
  const found: { path: string; detail: string }[] = [];
  for (const pat of cfg.otherFolders) {
    const parent = resolve(expand(dirname(pat), c.home)), re = otherFolderRe(basename(pat), slug);
    if (parent === c.home || inside(parent, c.home) || parent === "/") { notes.push(`other folders: ${pat} refused, its parent folder is the home directory or above it`); continue; }
    let names: string[] = [];
    try { names = readdirSync(parent, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && !e.isSymbolicLink() && re.test(e.name)).map((e) => e.name).sort(); } catch { /* no such folder */ }
    for (const n of names) {
      const path = join(parent, n);
      if (known.has(path) || found.some((f) => f.path === path)) continue;
      const why = otherFolderRefusal(path, main, c.home);
      if (why) { notes.push(`other folders: ${path} refused, ${why}`); continue; }
      const kind = folderKindOf(path, worktrees);
      if (kind === "repo") { notes.push(`other folders: ${path} refused, it is a git checkout that is not a worktree of this repository`); continue; }
      found.push({ path, detail: kind === "worktree" ? `git worktree (any branch): git worktree remove --force, then prune` : "plain folder" });
      if (kind === "worktree") {
        const st = await git(c, path, ["status", "--porcelain"]);
        if (st.code !== 0) out.blocks.push({ kind: "unreadable", why: `git could not read the checkout ${path}` });
        else if (st.stdout.trim()) {
          const files = st.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
          out.blocks.push({ kind: "dirty", why: `${path}: ${files.length} file${files.length === 1 ? "" : "s"} with changes that are not committed`, files: files.slice(0, 20) });
        }
      }
      for (const b of (await liveSessions(c, path, null, false)).blocks) out.blocks.push({ ...b, why: `${path}: ${b.why}` });
    }
  }
  const sizes = await sizeOf(c, found.map((f) => f.path));
  out.items = found.map((f) => item("other-folder", f.path, f.detail, sizes.get(f.path)));
  return out;
}

/** Remove `parent/name`; files a container wrote as root are removed by a container instead. */
async function removeFolder(c: CleanupCtx, parent: string, name: string): Promise<Outcome> {
  try { removeUnder(parent, name); return ok("removed"); } catch (e) {
    if (!/EACCES|EPERM|permission denied/i.test((e as Error).message) && (e as { code?: string }).code !== "EACCES") return bad((e as Error).message);
  }
  const d = await c.run("docker", ["run", "--rm", "-e", `D=${name}`, "-v", `${parent}:/c`, "alpine", "sh", "-c", 'rm -rf "/c/${D:?}"'], { timeoutMs: 300_000 });
  return d.code === 0 && !existsSync(join(parent, name)) ? ok("removed by a container (it belonged to root)") : bad(`the container fallback failed: ${firstLine(d.stderr)}`);
}

async function removeOtherFolder(c: CleanupCtx, cfg: CleanupConfig, plan: CleanupPlan, t: string): Promise<Outcome> {
  const main = plan.repo, name = basename(t), slug = plan.slug;
  const named = !!slug && cfg.otherFolders.some((p) => resolve(expand(dirname(p), c.home)) === dirname(t) && otherFolderRe(basename(p), slug).test(name));
  const why = otherFolderRefusal(t, main, c.home);
  if (!named || why) return bad(`refusing to remove ${t}: ${why ?? "no other-folder pattern of this project names it for this card"}`);
  const wl = await git(c, main, ["worktree", "list", "--porcelain"]);
  const kind = folderKindOf(t, wl.code === 0 ? parseWorktreeList(wl.stdout, main).map((w) => w.path) : []);
  if (kind === "repo") return bad(`refusing to remove ${t}: it is a git checkout that is not a worktree of this repository`);
  return kind === "worktree" ? removeWorktree(c, main, t) : removeFolder(c, dirname(t), name);
}

async function fsItems(c: CleanupCtx, cfg: CleanupConfig, slug: string | null, branch: string, notes: string[], wtParent: string | null): Promise<CleanupItem[]> {
  const found: { kind: CleanupKind; path: string; detail: string }[] = [];
  const seen = new Set<string>();
  if (wtParent) for (const n of listEntries(wtParent, c.home, (n) => evidenceNameMatches(n, slug, branch))) {
    if (isEmptyShell(join(wtParent, n))) { seen.add(join(wtParent, n)); found.push({ kind: "evidence", path: join(wtParent, n), detail: "empty folder beside the worktree (a container made it)" }); }
  }
  const roots = evidenceRootsOf(cfg, c.home);
  for (const root of roots) {
    const hits = listEntries(root, c.home, (n) => evidenceNameMatches(n, slug, branch));
    for (const n of hits) if (!seen.has(join(root, n))) { seen.add(join(root, n)); found.push({ kind: "evidence", path: join(root, n), detail: `evidence folder in ${root}` }); }
  }
  if (slug) for (const t of cfg.evidenceDirs) {
    const parent = dirname(expand(t, c.home));
    for (const n of listEntries(parent, c.home, (n) => matchesSlug(n, slug))) if (!seen.has(join(parent, n))) { seen.add(join(parent, n)); found.push({ kind: "evidence", path: join(parent, n), detail: "evidence folder" }); }
  }
  if (!found.some((f) => f.kind === "evidence")) {
    notes.push(roots.length || cfg.evidenceDirs.length
      ? `no evidence folder found: nothing in ${[...roots, ...cfg.evidenceDirs.map((t) => dirname(expand(t, c.home)))].join(", ")} starts with ${[slug, branchSlug(branch)].filter(Boolean).join(" or ") || "this branch"}`
      : "no evidence folder is set for this project, so none was looked for (Settings > Git and pull requests > What to include > Evidence)");
  }
  if (!slug) return found.length ? sized(c, found) : [];
  for (const d of cfg.notesDirs) {
    const dir = expand(d, c.home);
    for (const n of listEntries(dir, c.home, (n) => matchesSlug(n, slug) && cfg.transientMarkers.some((m) => n.toLowerCase().includes(m.toLowerCase())))) found.push({ kind: "note", path: join(dir, n), detail: "transient note" });
  }
  if (cfg.briefsDir) {
    const dir = expand(cfg.briefsDir, c.home);
    for (const n of listEntries(dir, c.home, (n) => n !== "archive" && matchesSlug(n, slug))) found.push({ kind: "brief", path: join(dir, n), detail: `moved to ${join(dir, "archive")}, not deleted` });
  }
  return sized(c, found);
}
async function sized(c: CleanupCtx, found: { kind: CleanupKind; path: string; detail: string }[]): Promise<CleanupItem[]> {
  const sizes = await sizeOf(c, found.filter((f) => f.kind !== "brief").map((f) => f.path));
  return found.map((f) => item(f.kind, f.path, f.detail, sizes.get(f.path)));
}

/**
 * What the agent CLI keeps for one checkout, keyed by the checkout's exact path with `/` as `-`. Claude Code's layout is the
 * only one known (other engines are not here). Only these three derived folders, never the folder above them, and the key
 * of a path with other characters (a dot, a space) is not guessed: nothing is found. `scratch` regenerates; `history` is
 * what the person resumes from, so it is its own, off-by-default kind.
 */
export function agentPaths(wt: string, home: string, uid: number): { scratch: string[]; history: string[] } {
  const key = wt.replaceAll("/", "-");
  if (!isAbsolute(wt) || wt === "/" || key.includes("\0")) return { scratch: [], history: [] };
  return {
    scratch: [join(home, ".cache", "claude-cli-nodejs", key), join(home, ".cache", "claude-tmp", String(uid), key)],
    history: [join(home, ".claude", "projects", key)],
  };
}
const uidOf = (c: CleanupCtx) => c.uid ?? process.getuid?.() ?? 0;
async function agentItems(c: CleanupCtx, wt: string, inc: Set<CleanupGroup>): Promise<CleanupItem[]> {
  const p = agentPaths(wt, c.home, uidOf(c));
  const found: { kind: CleanupKind; path: string; detail: string }[] = [];
  if (inc.has("agent-scratch")) for (const x of p.scratch) if (existsSync(x)) found.push({ kind: "agent-scratch", path: x, detail: "the agent's cache for this checkout; it makes it again" });
  if (inc.has("agent-history")) for (const x of p.history) if (existsSync(x)) found.push({ kind: "agent-history", path: x, detail: "Kept so you can resume or read what the agent did" });
  return found.length ? sized(c, found) : [];
}

const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** The repository's main checkout, whichever of its checkouts was named: the key the project's settings are held under. */
export async function mainCheckout(repo: string, c: CleanupCtx): Promise<string> {
  const wl = isAbsolute(repo) ? await git(c, repo, ["worktree", "list", "--porcelain"]) : null;
  const first = wl?.code === 0 ? parseWorktreeList(wl.stdout, repo)[0] : undefined;
  if (!first) throw new CleanupError(`${repo} is not a git repository (an absolute path is needed)`);
  return first.path;
}

/** What a finished PR left on this machine that the local state alone can name: no gh, no tabs, no safety checks. The plan and the inventory share it. */
async function localItems(c: CleanupCtx, cfg: CleanupConfig, o: { main: string; wt: { path: string } | null; branch: string; slug: string | null; defaults: Set<string>; inc: Set<CleanupGroup>; notes: string[] }): Promise<CleanupItem[]> {
  const { main, wt, branch, slug, defaults, inc, notes } = o;
  const items: CleanupItem[] = [];
  if (!slug) notes.push(`branch ${branch} has no card id prefix: docker, test database, notes and briefs steps are skipped (evidence is still looked for by the branch name)`);
  else if (inc.has("docker")) {
    items.push(...(await dockerItems(c, cfg, slug, wt?.path ?? null, notes)));
    items.push(...(await testDbItems(c, cfg, slug, notes)));
  }
  if (wt && wt.path !== main && inc.has("worktree")) {
    const sz = await sizeOf(c, [wt.path]);
    items.push(item("worktree", wt.path, "git worktree remove --force, then prune", sz.get(wt.path)));
    items.push(...(await agentItems(c, wt.path, inc)));
  }
  const bc = await git(c, main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (bc.code === 0 && !defaults.has(branch) && inc.has("branch")) {
    items.push(item("branch", branch, "git branch -D"));
    items.push(item("fetch-prune", "origin", "git fetch --prune origin (a failure is reported, not fatal)"));
  }
  if (inc.has("stashes")) items.push(...(await stashItems(c, main, branch)));
  if (inc.has("evidence") || inc.has("notes")) items.push(...(await fsItems(c, cfg, slug, branch, notes, wt && wt.path !== main ? dirname(wt.path) : null)));
  return items;
}

export async function planCleanup(repoIn: string, pr: number, cfg: CleanupConfig, c: CleanupCtx): Promise<CleanupPlan> {
  if (!isAbsolute(repoIn)) throw new CleanupError("repo must be an absolute path");
  if (!Number.isInteger(pr) || pr <= 0) throw new CleanupError("pr must be a positive whole number");
  const wl = await git(c, repoIn, ["worktree", "list", "--porcelain"]);
  if (wl.code !== 0) throw new CleanupError(`${repoIn} is not a git repository`);
  // `git worktree list` names the main checkout first, whichever checkout was asked.
  const list = parseWorktreeList(wl.stdout, repoIn);
  const main = list[0]!.path;
  const p = await prFacts(c, main, pr);
  const base = { repo: main, pr, title: p.title, url: p.url, state: p.state, mergedAt: p.mergedAt, notMerged: p.state === "CLOSED", branch: p.headRefName };
  const notes: string[] = [];
  if (p.state === "OPEN" || !p.headRefName) {
    const plan = { ...base, id: "", worktree: null, slug: null, head: "", include: cfg.include, items: [], notes, blocks: [{ kind: "pr-open" as const, why: `pull request #${pr} is still open` }] };
    return { ...plan, id: planId(plan) };
  }
  const branch = p.headRefName;
  const slug = slugOf(branch);
  const wt = list.find((w) => w.branch === branch && !w.bare) ?? null;
  const blocks: CleanupBlock[] = [];

  const def = await git(c, main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaults = new Set(["main", "master", def.code === 0 ? def.stdout.trim().replace(/^origin\//, "") : ""]);
  if (defaults.has(branch)) blocks.push({ kind: "default-branch", why: `${branch} is the default branch of this repository` });
  if (wt && wt.path === main) blocks.push({ kind: "main-checkout", why: `${wt.path} is the repository's main checkout, not a linked worktree` });

  const hr = wt ? await git(c, wt.path, ["rev-parse", "HEAD"]) : await git(c, main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const head = hr.code === 0 ? hr.stdout.trim() : "";
  const wtPath = wt ? wt.path : null;
  blocks.push(...(await safetyBlocks(c, main, wtPath, head, branch, pr, p)));
  const inc = new Set(cfg.include);
  const lv = await liveSessions(c, wtPath, slug, inc.has("tab"));
  blocks.push(...lv.blocks);

  const items: CleanupItem[] = [...lv.tabs, ...(await localItems(c, cfg, { main, wt, branch, slug, defaults, inc, notes }))];
  if (inc.has("worktree")) {
    const other = await otherFolderItems(c, cfg, { main, slug, worktrees: list.map((w) => w.path), known: new Set(items.map((i) => i.target)), notes });
    items.push(...other.items);
    blocks.push(...other.blocks);
  }
  if (c.forgetOwnState) items.push(item("own-state", `PR #${pr}`, "forget the closed-PR cache row and the agent status rows of this checkout"));
  if (cfg.worklogDir && p.state === "MERGED") {
    const f = join(expand(cfg.worklogDir, c.home), `${dayOf(c.now)}.md`);
    let seen = false;
    try { seen = !!p.url && readFileSync(f, "utf8").includes(p.url); } catch { /* no file yet */ }
    if (!seen) items.push(item("worklog", f, `append: PR merged: ${p.title} ${p.url}`));
  }

  // evidence, notes and briefs are two ticks: drop the unticked ones here, where every item has its kind
  const kept = items.filter((i) => { const g = GROUP_OF[i.kind]; return !g || inc.has(g); });
  const plan = { ...base, id: "", worktree: wtPath, slug, head, include: cfg.include, items: kept, blocks, notes };
  return { ...plan, id: planId(plan) };
}

function planId(p: Pick<CleanupPlan, "repo" | "pr" | "items" | "blocks" | "head" | "include">): string {
  return createHash("sha256").update(canon({
    repo: p.repo, pr: p.pr, head: p.head, include: [...p.include].sort(),
    items: p.items.map((i) => [i.id, i.target]).sort(), blocks: p.blocks.map((b) => [b.kind, b.why, b.files ?? []]),
  })).digest("hex");
}

// ------------------------------------------------------------------ run ----

type Outcome = Pick<CleanupItemResult, "status" | "detail">;
const ok = (detail: string): Outcome => ({ status: "done", detail });
const bad = (detail: string): Outcome => ({ status: "failed", detail });
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

async function removeWorktree(c: CleanupCtx, main: string, path: string): Promise<Outcome> {
  if (path === main || inside(path, main) || !isAbsolute(path)) return bad(`refusing to remove ${path}: it is the main checkout or holds it`);
  const r = await git(c, main, ["worktree", "remove", "--force", path]);
  if (r.code === 0) { await git(c, main, ["worktree", "prune"]); return ok("worktree removed"); }
  if (!/permission denied/i.test(r.stderr)) return bad(firstLine(r.stderr) || "git could not remove the worktree");
  // Files a container wrote as root: the same user cannot delete them, a container can.
  const parent = dirname(path), name = basename(path);
  if (!name || name === "." || name === ".." || parent === "/") return bad(`refusing the container fallback for ${path}`);
  const d = await c.run("docker", ["run", "--rm", "-e", `D=${name}`, "-v", `${parent}:/c`, "alpine", "sh", "-c", 'rm -rf "/c/${D:?}"'], { timeoutMs: 300_000 });
  await git(c, main, ["worktree", "prune"]);
  if (d.code !== 0) return bad(`git was refused (${firstLine(r.stderr)}) and the container fallback failed: ${firstLine(d.stderr)}`);
  return existsSync(path) ? bad("the directory is still there after the container fallback") : ok("worktree removed by a container (its files belonged to root)");
}

async function archiveAndDropStash(c: CleanupCtx, cfg: CleanupConfig, main: string, branch: string, sha: string): Promise<Outcome> {
  const dir = join(cfg.stashArchiveDir ? expand(cfg.stashArchiveDir, c.home) : join(c.stateDir, "cleanup-archive"), basename(main));
  let show = await git(c, main, ["stash", "show", "-p", "--include-untracked", sha]);
  if (show.code !== 0) show = await git(c, main, ["stash", "show", "-p", sha]);
  if (show.code !== 0 || !show.stdout.trim()) return bad(`the stash patch could not be read, so the stash is kept (${firstLine(show.stderr) || "empty patch"})`);
  const file = join(dir, `${branch.replace(/[^\w.-]+/g, "_")}-${sha.slice(0, 8)}.patch`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, show.stdout);
    if (readFileSync(file, "utf8").length !== show.stdout.length) throw new Error("short write");
  } catch (e) { return bad(`the stash patch could not be saved to ${file}, so the stash is kept (${(e as Error).message})`); }
  // A stash index moves when another is dropped: find this one by its commit each time.
  const l = await git(c, main, ["stash", "list", "--format=%H%x09%gd"]);
  const ref = lines(l.stdout).map((x) => x.split("\t")).find((x) => x[0] === sha)?.[1];
  if (!ref) return { status: "skipped", detail: `patch saved to ${file}; the stash was already gone` };
  const d = await git(c, main, ["stash", "drop", ref]);
  return d.code === 0 ? ok(`patch saved to ${file}; stash dropped`) : bad(`patch saved to ${file} but the stash was not dropped: ${firstLine(d.stderr)}`);
}

/** One plan item. Exported so a test can hand it a forged item: the removals re-check their own target and do not trust the plan. */
export async function runItem(it: CleanupItem, plan: CleanupPlan, cfg: CleanupConfig, c: CleanupCtx): Promise<Outcome> {
  const main = plan.repo, t = it.target;
  const dk = async (args: string[]) => c.run("docker", args, { timeoutMs: 120_000 });
  const res = (r: { code: number; stderr: string }, done: string) => (r.code === 0 ? ok(done) : bad(firstLine(r.stderr) || `exit ${r.code}`));
  switch (it.kind) {
    case "tab": {
      const m = /\((@\d+)(?:, socket (\d+))?\)$/.exec(t);
      const sock = m?.[2] ? (c.tmuxSockets?.() ?? [])[Number(m[2]) - 1] : [];
      if (!m || !sock) return bad(`refusing to close "${t}": not a window this plan listed`);
      return res(await c.run("tmux", [...sock, "kill-window", "-t", m[1]!], { timeoutMs: 5_000 }), "tab closed");
    }
    case "docker-container": {
      const s = await dk(["stop", t]);
      if (s.code !== 0 && !/is not running|No such container/i.test(s.stderr)) return bad(`docker stop: ${firstLine(s.stderr)}`);
      return res(await dk(["rm", t]), "stopped and removed");
    }
    case "docker-volume": return res(await dk(["volume", "rm", t]), "removed");
    case "docker-image": return res(await dk(["rmi", t]), "removed");
    case "test-db": {
      const [cmd, ...pre] = cfg.testDbCommand.trim().split(/\s+/);
      if (!SAFE_DB.test(t) || !t.startsWith(cfg.testDbPrefix) || !plan.slug || !matchesSlug(t, plan.slug)) return bad(`refusing to drop ${t}`);
      return res(await c.run(cmd!, [...pre, "-At", "-c", `DROP DATABASE "${t}"`], { timeoutMs: 60_000 }), "dropped");
    }
    case "worktree": return removeWorktree(c, main, t);
    case "branch": {
      if (plan.worktree && existsSync(plan.worktree)) return bad("the worktree is still there, so the branch is kept");
      return res(await git(c, main, ["branch", "-D", plan.branch]), "branch deleted");
    }
    case "fetch-prune": {
      const r = await git(c, main, ["fetch", "--prune", "origin"]);
      return r.code === 0 ? ok("fetched and pruned") : { status: "warn", detail: `fetch --prune failed, nothing else depends on it: ${firstLine(r.stderr)}` };
    }
    case "stash": return archiveAndDropStash(c, cfg, main, plan.branch, t);
    case "evidence": {
      // Only a folder directly inside a configured root (or the old template's parent) whose name is this card's, never a root.
      const parent = dirname(t), roots = evidenceRootsOf(cfg, c.home);
      const beside = !!plan.worktree && parent === dirname(plan.worktree) && t !== plan.worktree && evidenceNameMatches(basename(t), plan.slug, plan.branch) && isEmptyShell(t);
      if (beside) return removeFolder(c, parent, basename(t));
      const inRoot = roots.includes(parent) && evidenceNameMatches(basename(t), plan.slug, plan.branch);
      const inLegacy = !!plan.slug && cfg.evidenceDirs.some((d) => resolve(dirname(expand(d, c.home))) === parent) && matchesSlug(basename(t), plan.slug);
      if (roots.includes(t) || !(inRoot || inLegacy)) return bad(`refusing to remove ${t}: it is not a folder of this card inside an evidence folder`);
      try { removeUnder(parent, basename(t)); return ok("removed"); } catch (e) { return bad((e as Error).message); }
    }
    case "other-folder": return removeOtherFolder(c, cfg, plan, t);
    case "agent-scratch": case "agent-history": {
      const p = plan.worktree ? agentPaths(plan.worktree, c.home, uidOf(c)) : null;
      if (!p || !(it.kind === "agent-scratch" ? p.scratch : p.history).includes(t)) return bad(`refusing to remove ${t}: it is not this checkout's own folder`);
      try { removeUnder(dirname(t), basename(t)); return ok("removed"); } catch (e) { return bad((e as Error).message); }
    }
    case "note": {
      try { removeUnder(dirname(t), basename(t)); return ok("removed"); } catch (e) { return bad((e as Error).message); }
    }
    case "brief": {
      const dir = dirname(t), arch = join(dir, "archive");
      try {
        mkdirSync(arch, { recursive: true });
        let to = join(arch, basename(t));
        if (existsSync(to)) to = `${to}.${c.now}`;
        renameSync(t, to);
        return ok(`moved to ${to}`);
      } catch (e) { return bad((e as Error).message); }
    }
    case "own-state": {
      const n = c.forgetOwnState ? c.forgetOwnState({ repo: main, pr: plan.pr, worktree: plan.worktree }) : 0;
      return ok(`${n} row${n === 1 ? "" : "s"} forgotten`);
    }
    case "worklog": {
      try {
        const fresh = !existsSync(t);
        mkdirSync(dirname(t), { recursive: true });
        const line = `- PR merged: ${plan.title} ${plan.url}\n`;
        if (!fresh && readFileSync(t, "utf8").includes(plan.url)) return { status: "skipped", detail: "the pull request is already in the worklog" };
        appendFileSync(t, !fresh && !readFileSync(t, "utf8").endsWith("\n") ? `\n${line}` : line);
        return ok(`appended to ${t}`);
      } catch (e) { return bad((e as Error).message); }
    }
  }
}

export interface CleanupRunOpts {
  planId: string; exclude?: string[]; confirmNotMerged?: boolean;
  /** Told after each item, so a background run can show "5 of 10" and the bytes so far. */
  onItem?: (p: { done: number; total: number; bytes: number }) => void;
}

export async function runCleanup(repo: string, pr: number, cfg: CleanupConfig, c: CleanupCtx, o: CleanupRunOpts): Promise<CleanupReport> {
  const plan = await planCleanup(repo, pr, cfg, c);
  if (!o.planId || o.planId !== plan.id) throw new CleanupError("the state changed since the dry run (or the plan id is wrong): run the dry run again and confirm that plan", 409);
  if (plan.blocks.length) throw new CleanupError(`refused: ${plan.blocks.map((b) => b.why).join("; ")}`, 409);
  if (plan.notMerged && o.confirmNotMerged !== true) throw new CleanupError(`pull request #${pr} was closed without a merge: confirmNotMerged is required`, 409);
  const exclude = new Set(o.exclude ?? []);
  const unknown = [...exclude].filter((x) => !plan.items.some((i) => i.id === x));
  if (unknown.length) throw new CleanupError(`no such plan item to exclude: ${unknown.join(", ")}`);
  const items: CleanupItemResult[] = [];
  for (const it of plan.items) {
    const base = { id: it.id, kind: it.kind, target: it.target };
    if (exclude.has(it.id)) { items.push({ ...base, status: "skipped", detail: "left alone: unticked" }); continue; }
    let out: Outcome;
    try { out = await runItem(it, plan, cfg, c); } catch (e) { out = bad((e as Error).message); }
    items.push({ ...base, ...out, ...(out.status === "done" && it.bytes ? { bytes: it.bytes } : {}) });
    o.onItem?.({ done: items.length, total: plan.items.length, bytes: items.reduce((n, i) => n + (i.bytes ?? 0), 0) });
  }
  const freedBytes = items.reduce((n, i) => n + (i.bytes ?? 0), 0);
  const failed = items.filter((i) => i.status === "failed").length;
  const done = items.filter((i) => i.status === "done").length;
  // Re-read the same way the dialog does, so what the person sees next is what is left, not what was.
  let remaining: CleanupReport["remaining"] = null;
  try {
    const after = await planCleanup(repo, pr, cfg, c);
    const left = after.items.filter((i) => GROUP_OF[i.kind]);
    remaining = { items: left, bytes: left.reduce((n, i) => n + (i.bytes ?? 0), 0), blocks: after.blocks };
  } catch { /* the run happened; only the re-read failed */ }
  return { ok: failed === 0, planId: plan.id, items, freedBytes, failed, remaining, summary: `${done} done, ${failed} failed, ${items.length - done - failed} skipped; ${freedBytes} bytes freed` };
}

// ------------------------------------------------------- who may run it ----

/** Who asks for a run: a person's click, an agent (needs the person's card), or the person-set auto mode. */
export type CleanupCaller = "person" | "agent" | "auto";
/** The settings door's external card (settingsDoor.askExternal), as the engine needs it. */
export type CleanupAsk = (card: { key: string; who: string; diff: string[]; apply: () => Promise<{ ok: true } | { ok: false; error: string }> }) => { ok: true; cardId: string } | { ok: false; error: string; status: number };
export interface CleanupGate { caller: CleanupCaller; who: string; ask: CleanupAsk; /** How the card names the repository (`owner/name`); the plan's own path when absent. */ repoLabel?: string; auto?: { mode: CleanupMode; autoCleanDays: number; mergedAt: number | null } }
export type GatedRun = { kind: "ran"; report: CleanupReport } | { kind: "approval"; cardId: string; planId: string };

/**
 * The one door to a destructive run. A person runs it. An agent never does: a
 * stale plan id is refused now, then a card waits for the person and the run
 * happens on approval (the engine recomputes the plan id again then, so a tree
 * that moved in between is refused). The auto mode runs only when the person's
 * own setting says so and shouldAutoClean agrees; it never raises a card.
 */
export async function runCleanupGated(repo: string, pr: number, cfg: CleanupConfig, c: CleanupCtx, o: CleanupRunOpts, g: CleanupGate): Promise<GatedRun> {
  if (g.caller === "person") return { kind: "ran", report: await runCleanup(repo, pr, cfg, c, o) };
  if (g.caller === "auto") {
    const plan = await planCleanup(repo, pr, cfg, c);
    const a = g.auto ? shouldAutoClean(g.auto.mode, plan, g.auto.mergedAt, c.now, g.auto.autoCleanDays) : ({ clean: false, reason: "the auto mode was not asked for" } as const);
    if (!a.clean) throw new CleanupError(a.reason, 409);
    return { kind: "ran", report: await runCleanup(repo, pr, cfg, c, { ...o, planId: plan.id }) };
  }
  const plan = await planCleanup(repo, pr, cfg, c);
  if (!o.planId || o.planId !== plan.id) throw new CleanupError("the state changed since the dry run (or the plan id is wrong): run the dry run again and confirm that plan", 409);
  if (plan.blocks.length) throw new CleanupError(`refused: ${plan.blocks.map((b) => b.why).join("; ")}`, 409);
  if (plan.notMerged && o.confirmNotMerged !== true) throw new CleanupError(`pull request #${pr} was closed without a merge: confirmNotMerged is required`, 409);
  const card = g.ask({
    key: `${repo}#${pr}:${plan.id}`, who: g.who,
    diff: cleanupCardLines({
      pr, title: plan.title, repo: g.repoLabel ?? plan.repo, slug: plan.slug ?? "", mergedAt: plan.mergedAt,
      // the app's own bookkeeping rows (no group) are not leftovers and are not on the card
      items: plan.items.filter((i) => !(o.exclude ?? []).includes(i.id) && GROUP_OF[i.kind]).map((i) => ({ kind: i.kind, target: i.target, group: GROUP_OF[i.kind]!, bytes: i.bytes ?? 0 })),
    }),
    apply: async () => {
      try { const r = await runCleanup(repo, pr, cfg, c, o); return r.ok ? { ok: true } : { ok: false, error: r.summary }; }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    },
  });
  if (!card.ok) throw new CleanupError(card.error, card.status);
  return { kind: "approval", cardId: card.cardId, planId: plan.id };
}

// ------------------------------------------------------------ auto rule ----

export const CLEANUP_MODES = ["off", "ask", "atMerge", "auto"] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];
export type AutoDecision = { clean: true } | { clean: false; reason: string };
const DAY_MS = 86_400_000;

/**
 * Whether a cleanup may start without a person pressing anything. The caller
 * (a job, phase 2) only asks; this decides, and a "no" always carries the
 * sentence to show beside the badge. Order matters: off beats everything, a
 * block beats a mode, and a pull request closed without a merge is never
 * automatic. `auto` cleans a merged, unblocked pull request as soon as it is
 * seen; in `ask` and `atMerge`, `autoCleanDays` > 0 cleans one merged at least
 * that many days ago and 0 never does.
 */
export function shouldAutoClean(mode: CleanupMode, plan: Pick<CleanupPlan, "blocks" | "notMerged" | "state">, mergedAt: number | null, now: number, autoCleanDays: number): AutoDecision {
  const no = (reason: string): AutoDecision => ({ clean: false, reason });
  if (mode === "off") return no("cleanup is turned off for this project");
  if (plan.state !== "MERGED" || plan.notMerged) return no("the pull request was not merged: a person decides");
  if (plan.blocks.length) return no(plan.blocks.map((b) => b.why).join("; "));
  if (mode === "auto") return { clean: true };
  if (!(autoCleanDays > 0)) return no("waiting for a person: automatic cleanup is not on");
  if (mergedAt === null) return no("when it was merged is not known, so the age rule cannot apply");
  const age = (now - mergedAt) / DAY_MS;
  return age >= autoCleanDays ? { clean: true } : no(`merged ${Math.floor(age)} day${Math.floor(age) === 1 ? "" : "s"} ago; cleaned automatically after ${autoCleanDays}`);
}


/**
 * A row of the Closed list: does this merged or closed PR have anything on this machine? Local only (git, docker, the
 * folders the engine knows), never gh and never per-row `du` of a tab: the branch comes from the list the caller already
 * holds. Docker's listings are asked once for the whole batch. A PR whose answer cannot be read is `null`, which is
 * "unknown", never "nothing". Ceiling: a tab left open is not counted here; the plan still lists it.
 */
export interface Leftover { pr: number; items: number; bytes: number; groups: { group: string; items: number; bytes: number }[] }
export async function leftoverInventory(repoIn: string, prs: { pr: number; branch: string }[], cfgOf: (main: string) => CleanupConfig, c: CleanupCtx): Promise<(Leftover | { pr: number; unknown: true })[]> {
  const wl = await git(c, repoIn, ["worktree", "list", "--porcelain"]);
  if (wl.code !== 0) throw new CleanupError(`${repoIn} is not a git repository`);
  const list = parseWorktreeList(wl.stdout, repoIn);
  const main = list[0]!.path;
  const cfg = cfgOf(main);
  const memo = new Map<string, Promise<Awaited<ReturnType<CleanupCtx["run"]>>>>();
  const cx: CleanupCtx = { ...c, run: (cmd, args, opt) => {
    if (cmd !== "docker" || !["ps", "images", "volume"].includes(args[0] ?? "")) return c.run(cmd, args, opt);
    const k = args.join(" "); if (!memo.has(k)) memo.set(k, c.run(cmd, args, opt)); return memo.get(k)!;
  } };
  const def = await git(cx, main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaults = new Set(["main", "master", def.code === 0 ? def.stdout.trim().replace(/^origin\//, "") : ""]);
  const inc = new Set(cfg.include);
  const out: (Leftover | { pr: number; unknown: true })[] = [];
  for (const { pr, branch } of prs.slice(0, 60)) {
    try {
      if (!branch || defaults.has(branch)) { out.push({ pr, items: 0, bytes: 0, groups: [] }); continue; }
      const wt = list.find((w) => w.branch === branch && !w.bare && w.path !== main) ?? null;
      const items = (await localItems(cx, cfg, { main, wt, branch, slug: slugOf(branch), defaults, inc, notes: [] })).filter((i) => GROUP_OF[i.kind]);
      const groups = [...new Set(items.map((i) => GROUP_OF[i.kind]!))].map((g) => { const m = items.filter((i) => GROUP_OF[i.kind] === g); return { group: g, items: m.length, bytes: m.reduce((n, i) => n + (i.bytes ?? 0), 0) }; });
      out.push({ pr, items: items.length, bytes: groups.reduce((n, g) => n + g.bytes, 0), groups });
    } catch { out.push({ pr, unknown: true }); }
  }
  return out;
}
