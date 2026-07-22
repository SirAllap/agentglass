import type { WatchEvent, SessionRollup, StatsSummary, SkillInfo, FileChange, DiffHunk, Insight, SearchHit, PendingGate, GateRecord, SessionDetail, GitStatusResponse, CommitResult, WalkthroughResult, WalkthroughInputFile, GitRepoRef, FsCompletion, WorkingTree, GitActionResult, GitBranch, GitCommit, GitStash, GitGraphLine, GitWorktree, WorktreeLeftovers, GitRemote, GitRemoteBranch, GitTag, GitReflogEntry, GitLogEntry, DockerOverview, DockerStat, DockerActionResult, TerminalCommands, ChatImage, ConflictBlock, BlockChoice, UpdateStatus, ReleaseNotes } from "../../../shared/types.ts";
import * as demo from "./demo.ts";

export const IS_DEMO = demo.IS_DEMO;

/** Set when the agentglass server itself served this page (single-port mode) —
 *  it plants the marker into index.html on the way out (server/src/webui.ts).
 *  Serve-time, not build-time, so the same bundle still resolves :4000 under
 *  vite dev/preview and the desktop shell's static server. */
const SERVED_BY_API: boolean =
  typeof window !== "undefined" &&
  (window as unknown as { __AGENTGLASS_SAME_ORIGIN__?: boolean }).__AGENTGLASS_SAME_ORIGIN__ === true;

/** The desktop shell's API origin. Needed because the packaged renderer is
 *  served from `agentglass://app`, whose hostname says nothing about where the
 *  sidecar listens — `http://${location.hostname}:4000` would resolve to the
 *  nonsense `http://app:4000`. */
const DESKTOP_API: string | undefined =
  typeof window !== "undefined"
    ? (window as unknown as { agentglass?: { apiOrigin?: string } }).agentglass?.apiOrigin
    : undefined;

export const SERVER: string =
  (import.meta.env.VITE_CW_SERVER as string | undefined)?.replace(/\/$/, "") ||
  DESKTOP_API?.replace(/\/$/, "") ||
  (SERVED_BY_API ? location.origin : `http://${location.hostname}:4000`);

/** Auth token for a server that requires one (exposed / multi-user box). Read
 *  once from `?token=` — then stripped from the URL bar so it isn't shoulder-
 *  surfed or copied around — or from a prior localStorage save. Empty on the
 *  usual local box, where every call below is a no-op passthrough. */
const TOKEN: string = (() => {
  try {
    const u = new URL(location.href);
    const fromUrl = u.searchParams.get("token");
    if (fromUrl) {
      try { localStorage.setItem("agentglass_token", fromUrl); } catch { /* private mode */ }
      u.searchParams.delete("token");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      return fromUrl;
    }
    return localStorage.getItem("agentglass_token") || "";
  } catch { return ""; }
})();

/** Attach the bearer token to fetch headers when one is configured. */
export const authHeaders = (h: Record<string, string> = {}): Record<string, string> =>
  TOKEN ? { ...h, authorization: `Bearer ${TOKEN}` } : h;

/** Append ?token= to URLs a browser can't put a header on: WS upgrades and the
 *  download navigations (export links). */
export const withToken = (url: string): string =>
  TOKEN ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : url;

/** Whether this client has a shared-secret token configured. */
export const hasToken = (): boolean => !!TOKEN;

/** Why a chat turn ended early.
 *
 *  `refused` — the server answered and declined; `detail` is its reason.
 *  `unreachable` — the request never got a response at all.
 *  `dropped` — the turn was accepted and the connection died partway through.
 *
 *  The distinction is the whole point: a dropped turn may still be running in
 *  the background, so the advice is to go look, whereas a refusal is over and
 *  the reason is already known. Neither is recoverable from the raw fetch error,
 *  which under WebKitGTK is the same opaque "TypeError: Load failed" either way. */
export type ChatStreamFailure = "refused" | "unreachable" | "dropped";

export class ChatStreamError extends Error {
  constructor(readonly kind: ChatStreamFailure, readonly detail = "", readonly status = 0) {
    super(
      kind === "refused"
        ? `the server refused this turn${status ? ` (${status})` : ""}${detail ? `: ${detail}` : ""}`
        : kind === "unreachable"
          ? `can't reach the agentglass server at ${SERVER} — it may not be running`
          : "the connection to the agentglass server dropped mid-turn — it may have restarted (reinstalling replaces the running server). The turn itself may still be going; check the session in the fleet view before resending",
    );
    this.name = "ChatStreamError";
  }
}

/** Tell an auth failure apart from a plain outage. A browser WebSocket can't
 *  read the 401 that rejects its upgrade, so a socket that closes before it ever
 *  opens looks identical to the server being down. Probing an authenticated HTTP
 *  endpoint (which *can* read the status) disambiguates: 401 → the token is
 *  wrong/rotated/missing; any other answer → the server is up; a thrown fetch →
 *  it's unreachable. */
export async function probeAuth(): Promise<"ok" | "unauthorized" | "offline"> {
  try {
    const r = await fetch(SERVER + "/events/filter-options", { headers: authHeaders() });
    return r.status === 401 ? "unauthorized" : "ok";
  } catch {
    return "offline";
  }
}

/** Ask for a token, persist it, and reload so every fetch/WS picks it up. The
 *  recovery path when a server starts requiring a token, or rotates it, after
 *  this tab was loaded. */
export function reauthPrompt(): void {
  if (typeof window === "undefined") return;
  const t = window.prompt("This server needs an access token.\nPaste it to reconnect:");
  if (t && t.trim()) {
    try { localStorage.setItem("agentglass_token", t.trim()); } catch { /* private mode */ }
    location.reload();
  }
}

export const WS_URL = withToken(SERVER.replace(/^http/, "ws") + "/stream");

/** WebSocket URL for a real PTY shell in `root` (the in-browser terminal). */
export const ptyWsUrl = (root: string, cols: number, rows: number) =>
  withToken(`${SERVER.replace(/^http/, "ws")}/terminal/pty?root=${encodeURIComponent(root)}&cols=${cols}&rows=${rows}`);

async function get<T>(path: string): Promise<T> {
  const r = await fetch(SERVER + path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(SERVER + path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
  return r.json() as Promise<T>;
}

const D = <T,>(v: T) => Promise.resolve(v); // demo helper

const realApi = {
  recent: (limit = 300) => get<WatchEvent[]>(`/events/recent?limit=${limit}`),
  /** Scope + discovered projects. `workspace` is set when this instance was
   *  opened for a single project. */
  projects: () => get<{ projects: { source_app: string; path: string }[]; scanning: boolean; workspace: string | null }>("/projects"),
  stats: (windowMs: number, provider?: string) =>
    get<StatsSummary>(`/stats?window=${windowMs}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`),
  sessions: (limit = 100, provider?: string) =>
    get<SessionRollup[]>(`/sessions?limit=${limit}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`),
  filterOptions: () =>
    get<{ source_apps: string[]; hook_event_types: string[]; models: string[] }>(
      `/events/filter-options`
    ),
  exportUrl: (fmt: "csv" | "json") => withToken(`${SERVER}/export?format=${fmt}`),
  skillsExportUrl: (fmt: "md" | "csv" | "json" = "md") => withToken(`${SERVER}/skills/export?format=${fmt}`),
  usage: () => get<UsagePayload>(`/usage`),
  skills: () => get<{ skills: SkillInfo[]; generated_at: number }>(`/skills`),
  changes: (limit = 200) => get<{ changes: FileChange[] }>(`/changes?limit=${limit}`),
  session: (id: string) => get<SessionDetail>(`/session?id=${encodeURIComponent(id)}`),
  insights: () => get<{ insights: Insight[] }>(`/insights`),
  search: (q: string) => get<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`),
  gatePending: () => get<{ gates: PendingGate[] }>(`/gate/pending`),
  gateHistory: (limit = 25) => get<{ gates: GateRecord[] }>(`/gate/history?limit=${limit}`),
  gateDecide: (id: string, decision: "allow" | "deny", reason = "") =>
    fetch(SERVER + "/gate/decide", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ id, decision, reason }),
    }).then((r) => r.json()),
  gitStatus: (paths: string[]) =>
    fetch(SERVER + "/git/status", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ paths }),
    }).then((r) => r.json() as Promise<GitStatusResponse>),
  gitCommit: (payload: { root: string; files: string[]; title: string; body: string }) =>
    fetch(SERVER + "/git/commit", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    }).then((r) => r.json() as Promise<CommitResult>),
  walkthrough: (files: WalkthroughInputFile[]) =>
    fetch(SERVER + "/walkthrough", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ files }),
    }).then((r) => r.json() as Promise<WalkthroughResult>),
  /** Scope this instance to one project dir (null → whole machine). */
  setWorkspace: (root: string | null) => post<{ ok: boolean; workspace: string | null; persisted: boolean; error?: string; note?: string }>("/workspace", { root }),
  /** Subdirectories matching a half-typed path — the picker's completion. */
  fsComplete: (prefix: string) => get<FsCompletion>(`/fs/complete?prefix=${encodeURIComponent(prefix)}`),
  // --- live git panel (lazygit-style) ---
  gitRepos: () => get<{ repos: GitRepoRef[] }>("/git/repos"),
  /** Every repo on the machine — for the project picker, even when scoped. */
  gitReposAll: () => get<{ repos: GitRepoRef[] }>("/git/repos?all=1"),
  gitTree: (root: string) => get<WorkingTree>(`/git/tree?root=${encodeURIComponent(root)}`),
  gitStage: (root: string, paths: string[]) => post<GitActionResult>("/git/stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => post<GitActionResult>("/git/unstage", { root, paths }),
  gitStageAll: (root: string) => post<GitActionResult>("/git/stage-all", { root }),
  gitUnstageAll: (root: string) => post<GitActionResult>("/git/unstage-all", { root }),
  gitDiscard: (root: string, paths: string[]) => post<GitActionResult>("/git/discard", { root, paths }),
  gitCommitStaged: (root: string, title: string, body: string) => post<GitActionResult>("/git/commit-staged", { root, title, body }),
  gitPush: (root: string) => post<GitActionResult>("/git/push", { root }),
  gitPull: (root: string) => post<GitActionResult>("/git/pull", { root }),
  gitFetch: (root: string) => post<GitActionResult>("/git/fetch", { root }),
  gitBranches: (root: string) => get<{ current: string; branches: GitBranch[]; trunk?: string | null }>(`/git/branches?root=${encodeURIComponent(root)}`),
  gitLog: (root: string, limit = 100) => get<{ commits: GitCommit[] }>(`/git/log?root=${encodeURIComponent(root)}&limit=${limit}`),
  gitCommitDiff: (root: string, hash: string) => get<{ changes: FileChange[] }>(`/git/commit-diff?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`),
  gitStashes: (root: string) => get<{ stashes: GitStash[] }>(`/git/stashes?root=${encodeURIComponent(root)}`),
  gitRemotes: (root: string) => get<{ remotes: GitRemote[] }>(`/git/remotes?root=${encodeURIComponent(root)}`),
  /** Every branch on one remote, as the last fetch left them — the whole list,
   *  filtered and rendered progressively on this side. */
  gitRemoteBranches: (root: string, remote: string) => get<{ ok: boolean; remote: string; branches: GitRemoteBranch[]; error?: string }>(`/git/remote-branches?root=${encodeURIComponent(root)}&remote=${encodeURIComponent(remote)}`),
  /** Create a local branch tracking `ref` ("origin/WEB-1042"). `switch` also
   *  moves this checkout onto it. */
  gitTrackRemote: (root: string, ref: string, switchTo: boolean) => post<GitActionResult>("/git/track-remote", { root, ref, switch: switchTo }),
  gitTags: (root: string) => get<{ tags: GitTag[] }>(`/git/tags?root=${encodeURIComponent(root)}`),
  gitReflog: (root: string) => get<{ entries: GitReflogEntry[] }>(`/git/reflog?root=${encodeURIComponent(root)}`),
  gitCommandLog: (since = 0) => get<{ entries: GitLogEntry[] }>(`/git/commandlog?since=${since}`),
  /** Is a running nvim reachable for this file? Lets the key be labelled
   *  honestly before it's pressed. */
  editorCapability: () => get<{ hasNvim: boolean; editor: string | null }>("/editor/capability"),
  editorTarget: (path: string) => get<{ running: boolean; hasNvim: boolean }>(`/editor/target?path=${encodeURIComponent(path)}`),
  editorOpen: (path: string, line: number) =>
    post<{ ok: boolean; how?: "remote" | "spawn"; command?: string; otherCwds?: string[]; stuck?: number; error?: string;
      /** Set when the file went to an nvim rooted in a *sibling* checkout of the
       *  same project — a worktree of the repo you are looking at. */
      viaFamily?: string }>("/editor/open", { path, line }),
  gitCheckout: (root: string, name: string) => post<GitActionResult>("/git/checkout", { root, name }),
  gitBranchCreate: (root: string, name: string) => post<GitActionResult>("/git/branch-create", { root, name }),
  gitBranchDelete: (root: string, name: string, force: boolean) => post<GitActionResult>("/git/branch-delete", { root, name, force }),
  gitStashPush: (root: string, message: string) => post<GitActionResult>("/git/stash-push", { root, message }),
  gitStashApply: (root: string, index: number) => post<GitActionResult>("/git/stash-apply", { root, index }),
  gitStashPop: (root: string, index: number) => post<GitActionResult>("/git/stash-pop", { root, index }),
  gitStashDrop: (root: string, index: number) => post<GitActionResult>("/git/stash-drop", { root, index }),
  gitApplyHunk: (root: string, path: string, staged: boolean, action: "stage" | "unstage" | "discard", hunk: DiffHunk) => post<GitActionResult>("/git/apply-hunk", { root, path, staged, action, hunk }),
  gitConflictBlocks: (root: string, path: string) => get<{ ok: boolean; blocks: ConflictBlock[]; error?: string }>(`/git/conflict-blocks?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  gitResolveBlocks: (root: string, path: string, choices: BlockChoice[]) => post<GitActionResult>("/git/resolve-blocks", { root, path, choices }),
  /** `scope` is whose history: this checkout's own by default, the whole repo
   *  on request. See logGraph() — the default used to be everything, which put
   *  other people's branches at the top of your own log. */
  gitGraph: (root: string, limit = 400, scope: "head" | "all" = "head") => get<{ lines: GitGraphLine[]; scope: "head" | "all"; branch: string }>(`/git/graph?root=${encodeURIComponent(root)}&limit=${limit}&scope=${scope}`),
  gitWorktrees: (root: string) => get<{ worktrees: GitWorktree[] }>(`/git/worktrees?root=${encodeURIComponent(root)}`),
  gitMerge: (root: string, name: string) => post<GitActionResult>("/git/merge", { root, name }),
  gitRebase: (root: string, name: string) => post<GitActionResult>("/git/rebase", { root, name }),
  gitBranchRename: (root: string, name: string, to: string) => post<GitActionResult>("/git/branch-rename", { root, name, to }),
  gitReset: (root: string, ref: string, mode: "soft" | "mixed" | "hard") => post<GitActionResult>("/git/reset", { root, ref, mode }),
  /** `startPoint` is what the new branch is cut from — a remote branch when the
   *  Remotes tab asks; HEAD when omitted. */
  gitWorktreeAdd: (root: string, path: string, branch: string, newBranch: boolean, startPoint?: string) => post<GitActionResult>("/git/worktree-add", { root, path, branch, newBranch, startPoint }),
  gitWorktreeRemove: (root: string, path: string, force: boolean) => post<GitActionResult>("/git/worktree-remove", { root, path, force }),
  /** What removing these worktrees would delete that git wouldn't warn about —
   *  ask before offering the removal. One request for the whole batch. */
  /** Copy chosen leftovers into the main checkout. Never overwrites — anything
   *  already there comes back in `skipped` with the reason. */
  gitWorktreeRescue: (root: string, path: string, paths: string[]) =>
    post<GitActionResult & { copied?: string[]; skipped?: { path: string; why: string }[] }>("/git/worktree-rescue", { root, path, paths }),
  gitWorktreeLeftovers: (root: string, paths: string[]) =>
    get<{ leftovers: WorktreeLeftovers[] }>(`/git/worktree-leftovers?root=${encodeURIComponent(root)}${paths.map((p) => `&path=${encodeURIComponent(p)}`).join("")}`),
  /** Merge a checkout's base branch into it — "update from base". `root` is the
   *  checkout doing the updating, since the merge runs where the branch is. */
  gitSyncBase: (root: string, base?: string) => post<GitActionResult>("/git/sync-base", { root, base }),
  /** Remember which branch this one was cut from. Written to the repo's own
   *  config, so it survives restarts and is readable with plain `git config`. */
  gitSetBase: (root: string, branch: string, base: string | null) => post<GitActionResult>("/git/set-base", { root, branch, base }),
  gitBaseCandidates: (root: string) => get<{ ok: boolean; refs: { name: string; remote: boolean }[] }>(`/git/base-candidates?root=${encodeURIComponent(root)}`),
  gitConflicts: (root: string) => get<{ ok: boolean; state: string; files: string[]; error?: string }>(`/git/conflicts?root=${encodeURIComponent(root)}`),
  gitResolve: (root: string, paths: string[], side: "ours" | "theirs") => post<GitActionResult>("/git/resolve", { root, paths, side }),
  gitMergeAbort: (root: string) => post<GitActionResult>("/git/merge-abort", { root }),
  gitUndoMerge: (root: string) => post<GitActionResult>("/git/undo-merge", { root }),
  gitMergeContinue: (root: string) => post<GitActionResult>("/git/merge-continue", { root }),
  // --- live docker panel (lazydocker-style) ---
  dockerOverview: () => get<DockerOverview>("/docker/overview"),
  dockerStats: () => get<{ stats: DockerStat[] }>("/docker/stats"),
  dockerLogs: (id: string, tail = 400) => get<{ ok: boolean; text: string; error?: string }>(`/docker/logs?id=${encodeURIComponent(id)}&tail=${tail}`),
  updateStatus: () => get<UpdateStatus>("/update/status"),
  updateNotes: () => get<ReleaseNotes>("/update/notes"),
  updateRun: () => post<{ ok: boolean; error?: string }>("/update/run", {}),
  updateLog: () => get<{ ok: boolean; text: string }>("/update/log"),
  dockerInspect: (id: string) => get<{ ok: boolean; env: string[]; config: string; error?: string }>(`/docker/inspect?id=${encodeURIComponent(id)}`),
  dockerTop: (id: string) => get<{ ok: boolean; text: string; error?: string }>(`/docker/top?id=${encodeURIComponent(id)}`),
  // --- in-browser terminal: ready-to-run project commands (make + scripts) ---
  terminalCommands: (root: string) => get<TerminalCommands>(`/terminal/commands?root=${encodeURIComponent(root)}`),
  // --- multi-chat: drive a claude session from the browser ---
  chatEnabled: () => get<{ enabled: boolean; bypass?: boolean }>("/chat/enabled"),
  chatStream: async (payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[]; images?: ChatImage[] }, onEvent: (o: Record<string, unknown>) => void, signal?: AbortSignal) => {
    let res: Response;
    // A fetch that throws before a response has arrived never reached the
    // server, which is a different problem from one that dies mid-turn — the
    // turn has not started, so there is nothing running to go back to.
    try {
      res = await fetch(SERVER + "/chat/send", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload), signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ChatStreamError("unreachable", "");
    }
    // A refusal — chat disabled, out of scope, a bad directory — comes back as
    // plain text with a 4xx, not ndjson. Without this it fell into the reader
    // below, failed to parse as JSON, and was skipped line by line, so the user
    // was told nothing at all about why their turn did not run.
    if (!res.ok) throw new ChatStreamError("refused", (await res.text().catch(() => "")).trim(), res.status);
    if (!res.body) { try { onEvent(JSON.parse(await res.text())); } catch { /* non-json */ } return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const flush = (line: string) => { const t = line.trim(); if (t) { try { onEvent(JSON.parse(t)); } catch { /* skip */ } } };
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); } }
    } catch (e) {
      // The turn was accepted and then the connection died under it. The raw
      // error is opaque (a bare "TypeError: Load failed" or similar, depending
      // on the engine) and says nothing about what happened — the cause is
      // named here instead, where it is known.
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ChatStreamError("dropped", "");
    }
    flush(buf);
  },
  dockerStart: (id: string) => post<DockerActionResult>("/docker/start", { id }),
  dockerStop: (id: string) => post<DockerActionResult>("/docker/stop", { id }),
  dockerRestart: (id: string) => post<DockerActionResult>("/docker/restart", { id }),
  dockerRm: (id: string) => post<DockerActionResult>("/docker/rm", { id }),
};

// In demo mode every call resolves against the fabricated dataset — no server.
const demoApi: typeof realApi = {
  recent: () => D(demo.recent()),
  // The demo is a showcase of the whole fleet, so it is never scoped.
  projects: () => D({ projects: [], scanning: false, workspace: null }),
  stats: (windowMs: number, provider?: string) => D(demo.stats(windowMs, provider)),
  sessions: (_limit?: number, provider?: string) => D(demo.sessions(provider)),
  filterOptions: () => D(demo.filterOptions()),
  exportUrl: (fmt: "csv" | "json") => demo.eventsExportUri(fmt),
  skillsExportUrl: () => demo.skillsExportUri(),
  usage: () => D(demo.usage() as UsagePayload),
  skills: () => D(demo.skills()),
  changes: () => D(demo.changes()),
  session: (id: string) => D(demo.session(id)),
  insights: () => D(demo.insights()),
  search: (q: string) => D(demo.search(q)),
  gatePending: () => D(demo.gatePending()),
  gateHistory: () => D({ gates: [] as GateRecord[] }),
  gateDecide: (id: string) => D(demo.gateDecide(id)),
  gitStatus: (_paths: string[]) => D(demo.gitStatus()),
  gitCommit: (_payload: { root: string; files: string[]; title: string; body: string }) => D(demo.gitCommit()),
  walkthrough: (files: WalkthroughInputFile[]) => D(demo.walkthrough(files)),
  setWorkspace: (_root: string | null) => D({ ok: false, workspace: null, persisted: false, error: "unavailable in the demo" }),
  // The demo has no filesystem to browse, so completion is simply always empty.
  fsComplete: (_prefix: string) => D({ base: "", entries: [], truncated: false }),
  gitRepos: () => D(demo.gitRepos()),
  gitReposAll: () => D(demo.gitRepos()),
  gitTree: (root: string) => D(demo.gitTree(root)),
  gitStage: (_root: string, _paths: string[]) => D(demo.gitActionUnavailable()),
  gitUnstage: (_root: string, _paths: string[]) => D(demo.gitActionUnavailable()),
  gitStageAll: (_root: string) => D(demo.gitActionUnavailable()),
  gitUnstageAll: (_root: string) => D(demo.gitActionUnavailable()),
  gitDiscard: (_root: string, _paths: string[]) => D(demo.gitActionUnavailable()),
  gitCommitStaged: (_root: string, _title: string, _body: string) => D(demo.gitActionUnavailable()),
  gitPush: (_root: string) => D(demo.gitActionUnavailable()),
  gitPull: (_root: string) => D(demo.gitActionUnavailable()),
  gitFetch: (_root: string) => D(demo.gitActionUnavailable()),
  gitBranches: (_root: string) => D(demo.gitBranches()),
  // The demo has no real repo behind it; empty lists render as "none yet"
  // rather than as an error, which is the right shape for a showcase.
  gitRemotes: (_root: string) => D({ remotes: [] as GitRemote[] }),
  gitRemoteBranches: (_root: string, _remote: string) => D({ ok: true, remote: "", branches: [] as GitRemoteBranch[] }),
  gitTrackRemote: (_root: string, _ref: string, _switchTo: boolean) => D(demo.gitActionUnavailable()),
  gitTags: (_root: string) => D({ tags: [] as GitTag[] }),
  gitReflog: (_root: string) => D({ entries: [] as GitReflogEntry[] }),
  gitCommandLog: (_since?: number) => D({ entries: [] as GitLogEntry[] }),
  editorCapability: () => D({ hasNvim: false, editor: null as string | null }),
  editorTarget: (_path: string) => D({ running: false, hasNvim: false }),
  editorOpen: (_path: string, _line: number) => D({ ok: false, error: "no editor in the demo" }),
  gitLog: (_root: string, _limit?: number) => D(demo.gitLog()),
  gitCommitDiff: (_root: string, hash: string) => D(demo.gitCommitDiff(hash)),
  gitStashes: (_root: string) => D(demo.gitStashes()),
  gitCheckout: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchCreate: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchDelete: (_root: string, _name: string, _force: boolean) => D(demo.gitActionUnavailable()),
  gitStashPush: (_root: string, _message: string) => D(demo.gitActionUnavailable()),
  gitStashApply: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitStashPop: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitStashDrop: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitApplyHunk: (_root: string, _path: string, _staged: boolean, _action: "stage" | "unstage" | "discard", _hunk: DiffHunk) => D(demo.gitActionUnavailable()),
  gitConflictBlocks: (_root: string, _path: string) => D({ ok: false, blocks: [] as ConflictBlock[], error: "not available in the demo" }),
  gitResolveBlocks: (_root: string, _path: string, _choices: BlockChoice[]) => D(demo.gitActionUnavailable()),
  gitGraph: (_root: string, _limit?: number, _scope?: "head" | "all") => D({ ...demo.gitGraph(), scope: "head" as const, branch: "main" }),
  gitWorktrees: (_root: string) => D(demo.gitWorktrees()),
  gitMerge: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitRebase: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchRename: (_root: string, _name: string, _to: string) => D(demo.gitActionUnavailable()),
  gitReset: (_root: string, _ref: string, _mode: "soft" | "mixed" | "hard") => D(demo.gitActionUnavailable()),
  gitWorktreeAdd: (_root: string, _path: string, _branch: string, _newBranch: boolean, _startPoint?: string) => D(demo.gitActionUnavailable()),
  gitSyncBase: (_root: string, _base?: string) => D(demo.gitActionUnavailable()),
  gitSetBase: (_root: string, _branch: string, _base: string | null) => D(demo.gitActionUnavailable()),
  gitBaseCandidates: (_root: string) => D({ ok: true, refs: [] }),
  gitConflicts: (_root: string) => D({ ok: true, state: "clean", files: [] }),
  gitResolve: (_root: string, _paths: string[], _side: "ours" | "theirs") => D(demo.gitActionUnavailable()),
  gitMergeAbort: (_root: string) => D(demo.gitActionUnavailable()),
  gitUndoMerge: (_root: string) => D(demo.gitActionUnavailable()),
  gitMergeContinue: (_root: string) => D(demo.gitActionUnavailable()),
  gitWorktreeRemove: (_root: string, _path: string, _force: boolean) => D(demo.gitActionUnavailable()),
  gitWorktreeLeftovers: (_root: string, _paths: string[]) => D({ leftovers: [] as WorktreeLeftovers[] }),
  gitWorktreeRescue: (_root: string, _path: string, _paths: string[]) => D(demo.gitActionUnavailable()),
  dockerOverview: () => D(demo.dockerOverview()),
  dockerStats: () => D(demo.dockerStats()),
  dockerLogs: (id: string, _tail?: number) => D(demo.dockerLogs(id)),
  updateNotes: () => D({ ok: false, tag: "", notes: "", source: "", error: "not available in the demo" } as ReleaseNotes),
  updateStatus: () => D({ ok: true, available: false, info: { version: "demo", commit: "", builtAt: "", source: "", origin: "", baseTag: "", distance: 0 }, branch: "", behind: 0, ahead: 0, incoming: [], blocked: "not available in the demo" } as UpdateStatus),
  updateRun: () => D({ ok: false, error: "not available in the demo" }),
  updateLog: () => D({ ok: true, text: "" }),
  dockerInspect: (_id: string) => D({ ok: false, env: [] as string[], config: "", error: "not available in the demo" }),
  dockerTop: (_id: string) => D({ ok: false, text: "", error: "not available in the demo" }),
  terminalCommands: (_root: string) => D({ enabled: false, make: [], scripts: [] } as TerminalCommands),
  chatEnabled: () => D({ enabled: false }),
  chatStream: async (_payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[]; images?: ChatImage[] }, onEvent: (o: Record<string, unknown>) => void) => {
    onEvent({ type: "system", subtype: "init", session_id: "demo" });
    onEvent({ type: "assistant", message: { content: [{ type: "text", text: "(chat is disabled in the demo — run agentglass locally to drive real Claude sessions)" }] } });
    onEvent({ type: "result", result: "" });
  },
  dockerStart: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerStop: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerRestart: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerRm: (_id: string) => D(demo.dockerActionUnavailable()),
};

export const api = IS_DEMO ? demoApi : realApi;

export interface UsageWindow {
  utilization: number;
  remaining: number;
  resets_at: string | null;
}
export interface UsagePayload {
  available: boolean;
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at: number;
  error?: string;
}
