import type { WatchEvent, SessionRollup, StatsSummary, SkillInfo, FileChange, DiffHunk, Insight, SearchHit, PendingGate, SessionDetail, GitStatusResponse, CommitResult, WalkthroughResult, WalkthroughInputFile, GitRepoRef, FsCompletion, WorkingTree, GitActionResult, GitBranch, GitCommit, GitStash, GitGraphLine, GitWorktree, DockerOverview, DockerStat, DockerActionResult, TerminalCommands } from "../../../shared/types.ts";
import * as demo from "./demo.ts";

export const IS_DEMO = demo.IS_DEMO;

export const SERVER: string =
  (import.meta.env.VITE_CW_SERVER as string | undefined)?.replace(/\/$/, "") ||
  `http://${location.hostname}:4000`;

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
const authHeaders = (h: Record<string, string> = {}): Record<string, string> =>
  TOKEN ? { ...h, authorization: `Bearer ${TOKEN}` } : h;

/** Append ?token= to URLs a browser can't put a header on: WS upgrades and the
 *  download navigations (export links). */
const withToken = (url: string): string =>
  TOKEN ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : url;

/** Whether this client has a shared-secret token configured. */
export const hasToken = (): boolean => !!TOKEN;

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
  gitBranches: (root: string) => get<{ current: string; branches: GitBranch[] }>(`/git/branches?root=${encodeURIComponent(root)}`),
  gitLog: (root: string, limit = 100) => get<{ commits: GitCommit[] }>(`/git/log?root=${encodeURIComponent(root)}&limit=${limit}`),
  gitCommitDiff: (root: string, hash: string) => get<{ changes: FileChange[] }>(`/git/commit-diff?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`),
  gitStashes: (root: string) => get<{ stashes: GitStash[] }>(`/git/stashes?root=${encodeURIComponent(root)}`),
  gitCheckout: (root: string, name: string) => post<GitActionResult>("/git/checkout", { root, name }),
  gitBranchCreate: (root: string, name: string) => post<GitActionResult>("/git/branch-create", { root, name }),
  gitBranchDelete: (root: string, name: string, force: boolean) => post<GitActionResult>("/git/branch-delete", { root, name, force }),
  gitStashPush: (root: string, message: string) => post<GitActionResult>("/git/stash-push", { root, message }),
  gitStashApply: (root: string, index: number) => post<GitActionResult>("/git/stash-apply", { root, index }),
  gitStashPop: (root: string, index: number) => post<GitActionResult>("/git/stash-pop", { root, index }),
  gitStashDrop: (root: string, index: number) => post<GitActionResult>("/git/stash-drop", { root, index }),
  gitApplyHunk: (root: string, path: string, staged: boolean, action: "stage" | "unstage" | "discard", hunk: DiffHunk) => post<GitActionResult>("/git/apply-hunk", { root, path, staged, action, hunk }),
  gitGraph: (root: string, limit = 400) => get<{ lines: GitGraphLine[] }>(`/git/graph?root=${encodeURIComponent(root)}&limit=${limit}`),
  gitWorktrees: (root: string) => get<{ worktrees: GitWorktree[] }>(`/git/worktrees?root=${encodeURIComponent(root)}`),
  gitMerge: (root: string, name: string) => post<GitActionResult>("/git/merge", { root, name }),
  gitRebase: (root: string, name: string) => post<GitActionResult>("/git/rebase", { root, name }),
  gitBranchRename: (root: string, name: string, to: string) => post<GitActionResult>("/git/branch-rename", { root, name, to }),
  gitReset: (root: string, ref: string, mode: "soft" | "mixed" | "hard") => post<GitActionResult>("/git/reset", { root, ref, mode }),
  gitWorktreeAdd: (root: string, path: string, branch: string, newBranch: boolean) => post<GitActionResult>("/git/worktree-add", { root, path, branch, newBranch }),
  gitWorktreeRemove: (root: string, path: string, force: boolean) => post<GitActionResult>("/git/worktree-remove", { root, path, force }),
  // --- live docker panel (lazydocker-style) ---
  dockerOverview: () => get<DockerOverview>("/docker/overview"),
  dockerStats: () => get<{ stats: DockerStat[] }>("/docker/stats"),
  dockerLogs: (id: string, tail = 400) => get<{ ok: boolean; text: string; error?: string }>(`/docker/logs?id=${encodeURIComponent(id)}&tail=${tail}`),
  // --- in-browser terminal: ready-to-run project commands (make + scripts) ---
  terminalCommands: (root: string) => get<TerminalCommands>(`/terminal/commands?root=${encodeURIComponent(root)}`),
  // --- multi-chat: drive a claude session from the browser ---
  chatEnabled: () => get<{ enabled: boolean; bypass?: boolean }>("/chat/enabled"),
  chatStream: async (payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[] }, onEvent: (o: Record<string, unknown>) => void, signal?: AbortSignal) => {
    const res = await fetch(SERVER + "/chat/send", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload), signal });
    if (!res.body) { try { onEvent(JSON.parse(await res.text())); } catch { /* non-json */ } return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const flush = (line: string) => { const t = line.trim(); if (t) { try { onEvent(JSON.parse(t)); } catch { /* skip */ } } };
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let nl; while ((nl = buf.indexOf("\n")) >= 0) { flush(buf.slice(0, nl)); buf = buf.slice(nl + 1); } }
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
  gitGraph: (_root: string, _limit?: number) => D(demo.gitGraph()),
  gitWorktrees: (_root: string) => D(demo.gitWorktrees()),
  gitMerge: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitRebase: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchRename: (_root: string, _name: string, _to: string) => D(demo.gitActionUnavailable()),
  gitReset: (_root: string, _ref: string, _mode: "soft" | "mixed" | "hard") => D(demo.gitActionUnavailable()),
  gitWorktreeAdd: (_root: string, _path: string, _branch: string, _newBranch: boolean) => D(demo.gitActionUnavailable()),
  gitWorktreeRemove: (_root: string, _path: string, _force: boolean) => D(demo.gitActionUnavailable()),
  dockerOverview: () => D(demo.dockerOverview()),
  dockerStats: () => D(demo.dockerStats()),
  dockerLogs: (id: string, _tail?: number) => D(demo.dockerLogs(id)),
  terminalCommands: (_root: string) => D({ enabled: false, make: [], scripts: [] } as TerminalCommands),
  chatEnabled: () => D({ enabled: false }),
  chatStream: async (_payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[] }, onEvent: (o: Record<string, unknown>) => void) => {
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
