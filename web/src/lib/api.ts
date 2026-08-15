import type { ImportedPlace } from "./desktop.ts";
import type { WatchEvent, SessionRollup, StatsSummary, SkillInfo, FileChange, DiffHunk, Insight, SearchHit, PendingGate, GateRecord, SessionDetail, GitStatusResponse, CommitResult, WalkthroughResult, WalkthroughInputFile, GitRepoRef, FsCompletion, WorkingTree, GitActionResult, GitBranch, GitCommit, GitStash, GitGraphLine, GitWorktree, WorktreeLeftovers, GitRemote, GitRemoteBranch, GitTag, GitReflogEntry, GitLogEntry, DockerOverview, DockerStat, DockerActionResult, DockerCapability, TerminalCommands, CodexStatus, AgentCliStatus, AgentModel, ChatImage, ConflictBlock, ConflictFile, MergeSessionView, BlockChoice, MergeInfo, UpdateStatus, ReleaseNotes, PrListResponse, PrDetail, PrSummary, PrActionResult, PrLocalHead, GitCapability, HookSetupStatus, HookSetupResult, PrCheckJob, PrCheckRollup, ChatEngine, TmuxEngineInfo, ChatEffort, RemoteStatus, PairState, PairedDevice, DeviceScope, ChatPaneList, Budget, BudgetStatus, AgentProbe, UsageHistory, ActionRecord, IssuesReport, IssuePrsReport, IssueDetail, IssueWork, IssueStartResult, IssueActionResult, StartMode, PortsReport, ResourceReport, SpaceReport, TreeReport, FindReport, GrepReport, AgentPane, PanesResponse, TasksListResponse, RemindersResponse, Reminder, TaskWriteResponse, TidyReport, Recipe, RecipesResponse, BrowserUseStatus, ProviderUsage, GitLocksReport, ProcDetail, PrBranchSummary, GitFileChange, RepoStats, Changelog, GitSubmodule, BlameLine, FileHistoryEntry, GitBisectStatus, GitGrepHit } from "../../../shared/types.ts";
import type { ProvidersResponse, ProviderStatus, ProviderTasksResponse, SavedView, ClickUpBoards, ViewTasksResponse, TaskDetail, ProviderTask, ListStatus, ListField, ListPlace, ListMember } from "../../../shared/providers.ts";

/** What every ClickUp write answers with: the card as it now stands, or why not. */
/* `conflict` and `unauthorised` are the two failures with a remedy the app can
   name — reload, reconnect — so both are fields. Everything else is prose,
   because this provider answers 401 for a card that does not exist and a code
   pretending to know which it was would be wrong on the common case. */
type ClickUpWrite = { ok: boolean; error?: string; conflict?: boolean; unauthorised?: boolean; task?: ProviderTask };
import { DEPS, type DepsResponse } from "../../../shared/deps.ts";
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

/** Running inside the packaged desktop shell on the host machine — the only
 *  place from which it is safe to broadcast a theme out to the machine's tmux
 *  and nvim on boot. A phone or a paired browser reaches the same server but
 *  must never repaint the host's terminals just by loading; they have no
 *  `apiOrigin`, so this is false for them. */
export const IS_DESKTOP: boolean = !!DESKTOP_API;

export let SERVER: string =
  (import.meta.env.VITE_CW_SERVER as string | undefined)?.replace(/\/$/, "") ||
  DESKTOP_API?.replace(/\/$/, "") ||
  /*
   * Guarded because there is not always a window.
   *
   * This line is the reason no test can import a component: everything reaches
   * `api.ts`, and reading `location` at module scope throws under `bun test`,
   * which has no DOM. An audit proved what that cost — it made `PrView` return
   * null, so the entire Pull requests panel drew nothing, and the suite stayed
   * at 1802 pass because not one test executes the component.
   *
   * The fallback is a string no test will ever call, and in a browser nothing
   * changes: `typeof location` is never "undefined" there.
   */
  (typeof location === "undefined" ? "http://127.0.0.1:4000"
    : SERVED_BY_API ? location.origin : `http://${location.hostname}:4000`);

/**
 * Whether the line above *guessed* the origin rather than being told it.
 *
 * The three configured paths are known-good: `VITE_CW_SERVER` was typed by
 * someone, the desktop shell probes and hands over the origin it verified, and
 * a page the server itself served is the server by definition. Only the last
 * fallback is a guess, and it is the one worth checking.
 */
export const SERVER_GUESSED: boolean =
  !(import.meta.env.VITE_CW_SERVER as string | undefined) && !DESKTOP_API && !SERVED_BY_API;

/**
 * The desktop shell's own report that there is no sidecar, and why.
 *
 * This exists because `SERVER_GUESSED` above is FALSE in the packaged app —
 * `DESKTOP_API` is always set there — and ServerBanner returns early on that,
 * so the "No server" banner was unreachable from inside the desktop. Its own
 * comment said the shell "has probed the port since #126", which is true and is
 * not the same claim: the shell probes to PICK a port and then spawns into it.
 * If that spawn never answers, the origin is configured, looks verified, and is
 * empty. Nothing else on screen disagreed except a CLOSED pill in the header.
 *
 * So the shell says so out loud (electron/main.js, `reportSidecar`) and this is
 * where the page hears it. `reason` is what happened, the other three are what
 * to put in front of a person.
 */
export type SidecarFailure = {
  reason: "missing" | "spawn" | "exited" | "timeout";
  what: string;
  where?: string;
  fix: string;
  /** The tail of the server's own stderr. Often the only text that names the
   *  real cause — a bind error names the port. May be empty. */
  detail?: string;
  port?: number;
};

type ShellBridge = {
  sidecarFailure?: SidecarFailure | null;
  onServerFailed?: (fn: (f: SidecarFailure | null) => void) => () => void;
};

const SHELL: ShellBridge | undefined =
  typeof window !== "undefined" ? (window as unknown as { agentglass?: ShellBridge }).agentglass : undefined;

/** What the shell knew when this page loaded. Null in a browser tab, which has
 *  no shell to ask and keeps the origin-probe path below instead. */
export function sidecarFailure(): SidecarFailure | null {
  return SHELL?.sidecarFailure ?? null;
}

/** Everything the shell learns after that, failures and recoveries alike. A
 *  no-op unsubscribe outside the desktop, so the caller needs no branch. */
export function onSidecarFailure(fn: (f: SidecarFailure | null) => void): () => void {
  if (!SHELL?.onServerFailed) return () => {};
  return SHELL.onServerFailed(fn);
}

/** What is answering at `SERVER`. `foreign` is the interesting one: something
 *  is there, it is not us, and every panel is about to ask it for data. */
export type ServerIdentity = "ours" | "foreign" | "down";

/**
 * Ask the origin who it is.
 *
 * A 200 is not proof of identity, and treating it as proof is a bug with teeth:
 * `:4000` is a common default (Phoenix ships on it, and any number of local
 * observability servers pick it), so a machine with one of those running hands
 * the dashboard a stranger. Every request then gets a 404 or a shape we do not
 * understand, and the cockpit renders exactly as it would with no agents at
 * all. The conclusion a reasonable person draws is "this project is broken".
 *
 * The desktop shell has checked this since #126 — it walks eight ports and
 * reads the body of `/health` rather than its status. This is the same check on
 * the side that never had it: run from source, which is contributors.
 *
 * The `ok`/`clients` shape is accepted alongside the name so that a server
 * built before `service` existed still identifies as ours rather than as an
 * impostor.
 */
export async function probeServer(timeoutMs = 2500): Promise<ServerIdentity> {
  const ctl = new AbortController();
  const bail = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${SERVER}/health`, { headers: authHeaders(), signal: ctl.signal });
    // A server that needs a token is still ours, and the header we just sent
    // may simply be missing — that is the auth banner's problem, not this one.
    if (r.status === 401 || r.status === 403) return "ours";
    if (!r.ok) return "foreign";
    // A body we cannot read is still a body: something is listening and it is
    // not us. Letting the parse failure fall through to the catch below would
    // report "nothing is there" about a server that just answered, which is the
    // exact confusion this function exists to end — a Phoenix app on :4000
    // serves HTML from every path, including this one.
    let j: { service?: unknown; ok?: unknown; clients?: unknown };
    try { j = await r.json(); } catch { return "foreign"; }
    return j.service === "agentglass" || (j.ok === true && typeof j.clients === "number") ? "ours" : "foreign";
  } catch (e) {
    // Refused, DNS, CORS, or the abort above: nothing usable is there. Told
    // apart from `foreign` deliberately — "start the server" and "something
    // else owns this port" are different problems with different fixes, and
    // today they look identical.
    return (e as Error)?.name === "AbortError" ? "foreign" : "down";
  } finally {
    clearTimeout(bail);
  }
}

/** Auth token for a server that requires one (exposed / multi-user box). Read
 *  once from `?token=` — then stripped from the URL bar so it isn't shoulder-
 *  surfed or copied around — or from a prior localStorage save. Empty on the
 *  usual local box, where every call below is a no-op passthrough. */
let TOKEN: string = (() => {
  try {
    const u = new URL(location.href);
    const fromUrl = u.searchParams.get("token");
    if (fromUrl) {
      try { localStorage.setItem("agentglass_token", fromUrl); } catch { /* private mode */ }
      u.searchParams.delete("token");
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      return fromUrl;
    }
    const saved = localStorage.getItem("agentglass_token");
    if (saved) return saved;
  } catch { /* no URL, no storage — fall through to the shell */ }
  // Inside the desktop app, the shell knows the token because it is the thing
  // that minted it (turning on remote access). Nobody should have to paste a
  // secret into an app running on the same machine that generated it.
  try {
    return (window as unknown as { agentglass?: { apiToken?: string | null } }).agentglass?.apiToken || "";
  } catch {
    return "";
  }
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

/*
 * There was an `authToken()` here, handing the raw credential out for the one
 * caller that could not use `authHeaders`: the service worker, which answered a
 * gate from a notification with the app closed and therefore needed its own
 * copy in IndexedDB. The worker is gone with Web Push, and so is the only
 * reason this module ever exported the secret rather than a header carrying it.
 */

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

/**
 * POST a turn and read the ndjson stream it answers with, a frame at a time.
 *
 * Shared by both agents because none of this is agent-specific: the framing,
 * the three ways a turn can fail, and the reader are properties of how the
 * server streams a subprocess, not of which subprocess it streamed. What the
 * frames *mean* diverges completely, and that lives in the two parsers above
 * the store.
 */
async function turnStream(
  path: string,
  payload: Record<string, unknown>,
  onEvent: (o: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  // A fetch that throws before a response has arrived never reached the
  // server, which is a different problem from one that dies mid-turn — the
  // turn has not started, so there is nothing running to go back to.
  try {
    res = await fetch(SERVER + path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload), signal });
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

export let WS_URL = withToken(SERVER.replace(/^http/, "ws") + "/stream");

/**
 * Point this client at a (possibly new) server, without reloading the page.
 *
 * Turning remote access on or off, and revoking a link, all restart the sidecar
 * with a different environment: it may come back on another port, and it comes
 * back demanding a token the page did not have when it loaded. The obvious way
 * to deal with that is to reload the window, which is what this replaced — and
 * reloading the whole cockpit because a setting changed is a jarring answer to
 * a small question. Terminals, drafts and scroll positions are not worth a
 * rotated secret.
 *
 * `SERVER`, `TOKEN` and `WS_URL` are live bindings for exactly this reason:
 * every consumer reads them at call time, so the next fetch and the next socket
 * connect go to the right place with the right credential.
 */
export function adoptServer(next: { origin?: string | null; token?: string | null }): void {
  if (next.origin) SERVER = next.origin.replace(/\/$/, "");
  if (next.token !== undefined) {
    TOKEN = next.token ?? "";
    // Keep storage in step, so a genuine reload later does not fall back to a
    // secret that has been revoked.
    try {
      if (TOKEN) localStorage.setItem("agentglass_token", TOKEN);
      else localStorage.removeItem("agentglass_token");
    } catch { /* private mode */ }
  }
  WS_URL = withToken(SERVER.replace(/^http/, "ws") + "/stream");
}

/** WebSocket URL for a real PTY shell in `root` (the in-browser terminal). */
export const ptyWsUrl = (root: string, cols: number, rows: number, view?: string, edit = false, agent?: string,
  /**
   * A shell in `root`, and not the tmux session the desk was last in.
   *
   * The server resumes that session for a plain shell, which is what the
   * terminal view wants and what the phone wants. A console docked inside
   * another view does not: it becomes a second client on the session, showing
   * whichever tab the terminal is on and typing into whatever pane that tab has
   * — an agent's, in the case that was reported.
   */
  fresh = false,
  /**
   * This socket is the docked console.
   *
   * The server gives it the engine whatever the terminal view is set to, and in
   * a session of its own. Passed rather than inferred from `fresh`: they are
   * different questions — `fresh` says "not the session the desk resumed", and
   * this says "this is the app's shell, and it must outlive the window".
   */
  isConsole = false) =>
  withToken(`${SERVER.replace(/^http/, "ws")}/terminal/pty?root=${encodeURIComponent(root)}&cols=${cols}&rows=${rows}`
    // A single-use ticket for an agent to start in this pane — never the prompt
    // itself, which is kilobytes and has no business in a URL. See
    // api.termAgentTicket and the server's agentticket.ts.
    + (agent ? `&agent=${encodeURIComponent(agent)}` : "")
    // A file to open instead of a shell. A path — the server decides what runs
    // with it, and refuses one outside the open project.
    + (view ? `&view=${encodeURIComponent(view)}` : "")
    // Editable, rather than the read-only default. Asked for explicitly because
    // the two intents are different: a pull request is somebody else's code in
    // a temp copy, a file tree is your checkout. The server refuses this for a
    // temp copy however loudly the client asks.
    + (view && edit ? "&edit=1" : "")
    + (fresh ? "&fresh=1" : "")
    + (isConsole ? "&console=1" : ""));

async function get<T>(path: string): Promise<T> {
  const r = await fetch(SERVER + path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(SERVER + path, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
  return r.json() as Promise<T>;
}

/** The viewer's IANA zone, or null if the runtime cannot say. Memoized: this
 *  is asked on every stats poll and resolvedOptions() is not free. */
let tzMemo: string | null | undefined;
function viewerTz(): string | null {
  if (tzMemo === undefined) {
    try { tzMemo = Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
    catch { tzMemo = null; }
  }
  return tzMemo;
}

const D = <T,>(v: T) => Promise.resolve(v); // demo helper
const demoPrAction = (): PrActionResult => ({ ok: false, error: "the demo is read-only" });

const realApi = {
  recent: (limit = 300) => get<WatchEvent[]>(`/events/recent?limit=${limit}`),
  /** Where the machine's agents are sitting, in tmux terms. Asked on demand —
   *  when the bar's panel opens — never polled: nobody reads the answer between
   *  pressing the chip and clicking through it. */
  agentPanes: () => get<PanesResponse>("/terminal/panes"),
  /** Where the agent in the focused pane of this tmux window has been working,
   *  newest first. Directories, not worktrees — the caller matches them against
   *  the worktrees it is already showing. See panewt.ts for why the screen
   *  cannot answer this. */
  paneDirs: (windowId: string) =>
    get<{ ok: boolean; pane: string | null; dirs: string[] }>(`/terminal/pane-dirs?window=${encodeURIComponent(windowId)}`),
  /** Put one in front of whoever is attached to tmux. */
  focusPane: (p: { sessionId: string; windowId: string; paneId: string }) =>
    post<{ ok: boolean; error?: string }>("/terminal/panes/focus", p),
  // --- the pane engine's tmux, driven entirely from the UI ---
  /** Everything the settings panel needs to describe the engine's tmux. */
  tmuxStatus: () => get<{
    ok: boolean;
    bin: { available: boolean; source: string; path: string; version: string | null; reason: string };
    capability: { available: boolean; reason: string };
    confMode: string;
    override: string;
    overrideActive: boolean;
    broken: boolean;
    brokenReason: string;
    restoreEnabled: boolean;
    resumeMode: string;
    /** The engine's prefix key in tmux spelling; "" is tmux's own C-b. */
    prefix: string;
    /** Which tmux the terminal view opens on. */
    terminal: string;
    source: string;
    lastCaptureAt: number | null;
  }>("/terminal/tmux-status"),
  /** Save the conf override (validated server-side before it lands). */
  tmuxConfSave: (confMode: string, override: string) =>
    post<{ ok: boolean; error?: string; appliedAtNextStart?: boolean; appliedNow?: boolean }>("/terminal/tmux-conf", { confMode, override }),
  /** Save the binary/restore settings. */
  tmuxSettingsSave: (f: { source?: string; path?: string; restore?: boolean; resume?: string; prefix?: string; terminal?: string }) =>
    post<{ ok: boolean; persisted?: boolean; error?: string; appliedNow?: boolean }>("/terminal/tmux-settings", f),
  /** Restore the generated conf, override cleared, our server killed. */
  tmuxReset: () =>
    post<{ ok: boolean; error?: string }>("/terminal/tmux-reset", {}),
  /** capture | restore | clear for the layout persistence. */
  tmuxRestoreAction: (action: "capture" | "restore" | "clear", mode?: "lazy" | "all") =>
    post<{ ok: boolean; error?: string; restored?: number; capturedAt?: number | null }>("/terminal/tmux-restore", { action, mode }),
  /** A session's windows with their panes — the tab strip's data. */
  tmuxWindows: (session: string) =>
    get<{ ok: boolean; windows: Array<{ id: string; index: number; name: string; active: boolean; flags: string; panes: Array<{ id: string; index: number; active: boolean; command: string; path: string }> }> }>(
      `/terminal/tmux/windows?session=${encodeURIComponent(session)}`),
  /** Tabs/splits/focus/kill/rename/resize on the engine's tmux. */
  tmuxWindowOp: (op: string, body: Record<string, unknown>) =>
    post<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>("/terminal/tmux/windows", { op, ...body }),
  /** Scope + discovered projects. `workspace` is set when this instance was
   *  opened for a single project. */
  projects: () => get<{ projects: { source_app: string; path: string }[]; scanning: boolean; workspace: string | null }>("/projects"),
  // tz: the heatmap is a weekday × hour grid, and only this end knows which
  // clock those mean. Sent on every call rather than negotiated once, because
  // a laptop can cross a timezone between two polls and the server caches per
  // zone anyway. Resolving it can throw on an exotic runtime; the server falls
  // back to its own clock when it is absent.
  stats: (windowMs: number, provider?: string) =>
    get<StatsSummary>(
      `/stats?window=${windowMs}`
      + (provider ? `&provider=${encodeURIComponent(provider)}` : "")
      + (viewerTz() ? `&tz=${encodeURIComponent(viewerTz()!)}` : ""),
    ),
  // No tz, unlike /stats: these days are UTC because that is the grain the
  // retention fold wrote them at, and re-slicing a day-summary by a viewer's
  // clock would move spend onto a day it was never recorded on.
  usageDaily: (days = 90) => get<UsageHistory>(`/usage/daily?days=${days}`),
  sessions: (limit = 100, provider?: string) =>
    get<SessionRollup[]>(`/sessions?limit=${limit}${provider ? `&provider=${encodeURIComponent(provider)}` : ""}`),
  filterOptions: () =>
    get<{ source_apps: string[]; hook_event_types: string[]; models: string[] }>(
      `/events/filter-options`
    ),
  // `kind`: "events" is the raw rows, bounded by retention; "daily" is the
  // day series, which reads the rollup too and so goes back as far as the
  // fold does rather than as far as the events table happens to.
  exportUrl: (fmt: "csv" | "json", kind: "events" | "daily" = "events") =>
    withToken(`${SERVER}/export?format=${fmt}${kind === "daily" ? "&kind=daily" : ""}`),
  skillsExportUrl: (fmt: "md" | "csv" | "json" = "md") => withToken(`${SERVER}/skills/export?format=${fmt}`),
  providerUsage: () => get<ProviderUsage[]>(`/usage/providers`),
  refreshCodexUsage: () => post<{ ok: boolean; error?: string }>(`/usage/codex/refresh`, {}),
  // usage_since: the epoch the call counts are known from. They are bounded
  // by AGENTGLASS_RETENTION_DAYS, so a bare count reads as a lifetime total
  // and is not. 0 means pruning is off and it really is all time.
  skills: () => get<{ skills: SkillInfo[]; usage_since?: number; generated_at: number }>(`/skills`),
  changes: (limit = 200) => get<{ changes: FileChange[]; project?: string | null }>(`/changes?limit=${limit}`),
  session: (id: string) => get<SessionDetail>(`/session?id=${encodeURIComponent(id)}`),
  /** Sessions with a turn running right now. The only honest answer to "can I
   *  send to this without interrupting it" — see server/src/chat.ts. */
  chatActive: () => get<{ ids: string[] }>(`/chat/active`),
  insights: () => get<{ insights: Insight[] }>(`/insights`),
  search: (q: string) => get<{ hits: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}`),
  gatePending: () => get<{ gates: PendingGate[] }>(`/gate/pending`),
  gateHistory: (limit = 25) => get<{ gates: GateRecord[] }>(`/gate/history?limit=${limit}`),
  // Unscoped, unlike every other metric call: "who merged that" is at its most
  // useful when the answer is somewhere you were not looking.
  actions: (limit = 200, before?: number) =>
    get<{ actions: ActionRecord[] }>(`/actions?limit=${limit}${before ? `&before=${before}` : ""}`),
  /** `ok: false` is a 200: the request arrived and something else had already
   *  decided the gate. `error` says what won, and a caller that ignores it
   *  tells somebody their answer took when it did not. */
  gateDecide: (id: string, decision: "allow" | "deny", reason = "") =>
    fetch(SERVER + "/gate/decide", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ id, decision, reason }),
    }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>),
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
  gitAmend: (payload: { root: string; files: string[]; title: string; body: string }) =>
    fetch(SERVER + "/git/amend", {
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
  /** Whether an agent could drive the built-in browser at all: the CLI on PATH,
   *  the skill where agents look, and a window able to answer. See browseruse.ts
   *  for why each of the three is reported separately. */
  browserUseStatus: () => get<BrowserUseStatus>("/browser-use/status"),
  /** Put the skill this build ships where agents look, keeping what was there. */
  browserUseInstall: () => post<{ ok: boolean; path?: string; backup?: string; error?: string }>("/browser-use/install", {}),
  /** Say that this window has a browser panel that can answer an agent's ask —
   *  or that it no longer does. A heartbeat: the server expires it, so a window
   *  that dies without saying goodbye stops being counted. */
  browserReady: (client: string, on: boolean) => post<{ ok: boolean }>("/browser/ready", { client, on }),
  /** Report what the built-in browser did with an agent's ask. The server is
   *  holding that agent's request open until this lands — see browserdrive.ts. */
  browserResult: (r: { id: string; ok: boolean; value?: unknown; error?: string }) =>
    post<{ ok: boolean; known: boolean }>("/browser/result", r),
  /** Stop offering a project in the picker, or offer it again. Nothing on disk
   *  is touched — see config.ts. */
  hideProject: (path: string, hidden: boolean) => post<{ ok: boolean; hidden: string[]; persisted: boolean; error?: string }>("/projects/hidden", { path, hidden }),
  /** Clone a repository into a folder. Answers with where it landed, so the
   *  picker can open it straight away. Slow by nature — a real clone over a
   *  slow line takes minutes and the request is held for all of it. */
  cloneProject: (url: string, parent: string) => post<{ ok: boolean; path?: string; error?: string }>("/projects/clone", { url, parent }),
  /** A new, empty project: a folder with a git repository in it. */
  newProject: (name: string, parent: string) => post<{ ok: boolean; path?: string; error?: string }>("/projects/new", { name, parent }),
  // --- live git panel (lazygit-style) ---
  gitCapability: () => get<GitCapability>("/git/capability"),
  /** Every outside tool the app shells out to, and what this machine has.
   *  `force` is the Recheck button: it re-probes inside the server's cache
   *  window, which is the only case where a stale answer is the wrong one. */
  dependencies: (force = false) => get<DepsResponse>(`/dependencies${force ? "?force=1" : ""}`),
  gitRepos: () => get<{ repos: GitRepoRef[] }>("/git/repos"),
  /** Put a PNG somewhere an agent can read it, and say where. A tmux window
   *  takes text; a megabyte of base64 in a prompt is not text. */
  /** Everywhere another browser has been, for the address bar. */
  browserPlaces: () => get<{ ok: boolean; places: ImportedPlace[] }>("/browser/places/all"),
  browserPlaceCount: () => get<{ ok: boolean; total: number; bookmarks: number; sources: string[] }>("/browser/places"),
  saveBrowserPlaces: (source: string, places: ImportedPlace[]) =>
    post<{ ok: boolean; saved?: number; total?: number; bookmarks?: number; error?: string }>("/browser/places", { source, places }),
  forgetBrowserPlaces: () => post<{ ok: boolean; total?: number }>("/browser/places/forget", {}),
  /** Remember a page the built-in browser just visited, so the bar suggests your own history back. */
  recordVisit: (url: string, title: string) =>
    post<{ ok: boolean }>("/browser/visit", { url, title }),
  saveScratchImage: (dataUrl: string, name: string) =>
    post<{ ok: boolean; path?: string; error?: string }>("/scratch/image", { dataUrl, name }),
  /** Every repo on the machine — for the project picker, even when scoped. */
  /** Every repo on the machine, plus the paths the picker has been told to
   *  stop offering — sent together so the picker can also show them again. */
  gitReposAll: () => get<{ repos: GitRepoRef[]; hidden?: string[] }>("/git/repos?all=1"),
  gitTree: (root: string) => get<WorkingTree>(`/git/tree?root=${encodeURIComponent(root)}`),
  /** What every in-scope worktree changed at once, behind File changes.
   *  "working" = the working tree (uncommitted); "committed" = each checkout's
   *  last commit — so a change is still there after it is committed. */
  gitChangesAll: (mode: "working" | "committed" = "working") => get<{ changes: FileChange[] }>(`/git/changes-all?mode=${mode}`),
  gitStage: (root: string, paths: string[]) => post<GitActionResult>("/git/stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => post<GitActionResult>("/git/unstage", { root, paths }),
  gitStageAll: (root: string) => post<GitActionResult>("/git/stage-all", { root }),
  gitUnstageAll: (root: string) => post<GitActionResult>("/git/unstage-all", { root }),
  gitDiscard: (root: string, paths: string[]) => post<GitActionResult>("/git/discard", { root, paths }),
  gitCommitStaged: (root: string, title: string, body: string) => post<GitActionResult>("/git/commit-staged", { root, title, body }),
  gitPush: (root: string, opts?: { force?: boolean }) => post<GitActionResult>("/git/push", { root, force: opts?.force === true }),
  gitPull: (root: string) => post<GitActionResult>("/git/pull", { root }),
  gitFetch: (root: string) => post<GitActionResult>("/git/fetch", { root }),
  gitBranches: (root: string) => get<{ current: string; branches: GitBranch[]; trunk?: string | null; checking?: boolean }>(`/git/branches?root=${encodeURIComponent(root)}`),
  gitLog: (root: string, limit = 100) => get<{ commits: GitCommit[] }>(`/git/log?root=${encodeURIComponent(root)}&limit=${limit}`),
  gitCommitDiff: (root: string, hash: string) => get<{ changes: FileChange[] }>(`/git/commit-diff?root=${encodeURIComponent(root)}&hash=${encodeURIComponent(hash)}`),
  gitRefs: (root: string) => get<{ ok: boolean; refs?: string[]; error?: string }>(`/git/refs?root=${encodeURIComponent(root)}`),
  gitSnapshots: (root: string) => get<{ ok: boolean; snapshots?: { sha: string; ref: string; time: string; label: string }[]; error?: string }>(`/git/snapshots?root=${encodeURIComponent(root)}`),
  gitSnapshotCreate: (root: string, label?: string) => post<GitActionResult & { sha?: string; ref?: string }>("/git/snapshot-create", { root, label }),
  gitSnapshotRestore: (root: string, sha: string) => post<GitActionResult>("/git/snapshot-restore", { root, sha }),
  gitSnapshotDelete: (root: string, sha: string) => post<GitActionResult>("/git/snapshot-delete", { root, sha }),
  gitProtectedBranches: (root: string) => get<{ ok: boolean; branches?: string[]; error?: string }>(`/git/protected-branches?root=${encodeURIComponent(root)}`),
  gitProtectedBranchesSet: (root: string, names: string[]) => post<GitActionResult>("/git/protected-branches-set", { root, names }),
  gitStashes: (root: string) => get<{ stashes: GitStash[] }>(`/git/stashes?root=${encodeURIComponent(root)}`),
  gitTidy: (root: string) => get<TidyReport>(`/git/tidy?root=${encodeURIComponent(root)}`),
  gitRemotes: (root: string) => get<{ remotes: GitRemote[] }>(`/git/remotes?root=${encodeURIComponent(root)}`),
  /** Every branch on one remote, as the last fetch left them — the whole list,
   *  filtered and rendered progressively on this side. */
  gitRemoteBranches: (root: string, remote: string) => get<{ ok: boolean; remote: string; branches: GitRemoteBranch[]; error?: string }>(`/git/remote-branches?root=${encodeURIComponent(root)}&remote=${encodeURIComponent(remote)}`),
  /** Create a local branch tracking `ref` ("origin/WEB-1042"). `switch` also
   *  moves this checkout onto it. */
  gitTrackRemote: (root: string, ref: string, switchTo: boolean) => post<GitActionResult>("/git/track-remote", { root, ref, switch: switchTo }),
  gitTags: (root: string) => get<{ tags: GitTag[] }>(`/git/tags?root=${encodeURIComponent(root)}`),
  gitReflog: (root: string) => get<{ entries: GitReflogEntry[] }>(`/git/reflog?root=${encodeURIComponent(root)}`),
  gitRepoStats: (root: string, days?: number) => get<RepoStats>(`/git/stats?root=${encodeURIComponent(root)}&days=${days ?? 30}`),
  gitChangelog: (root: string, from?: string, to?: string) => get<Changelog>(`/git/changelog?root=${encodeURIComponent(root)}&from=${encodeURIComponent(from ?? "")}&to=${encodeURIComponent(to ?? "")}`),
  gitSubmodules: (root: string) => get<{ submodules: GitSubmodule[] }>(`/git/submodules?root=${encodeURIComponent(root)}`),
  gitSubmoduleAdd: (root: string, url: string, path: string) => post<GitActionResult>("/git/submodule-add", { root, url, path }),
  gitSubmoduleUpdate: (root: string, path?: string) => post<GitActionResult>("/git/submodule-update", { root, path }),
  gitSubmoduleSync: (root: string, path?: string) => post<GitActionResult>("/git/submodule-sync", { root, path }),
  gitSubmoduleDeinit: (root: string, path: string) => post<GitActionResult>("/git/submodule-deinit", { root, path }),
  gitSubmoduleRemove: (root: string, path: string) => post<GitActionResult>("/git/submodule-remove", { root, path }),
  gitBlame: (root: string, path: string, ref?: string) => get<{ ok: boolean; lines?: BlameLine[]; error?: string }>(`/git/blame?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref ?? "")}`),
  gitFileHistory: (root: string, path: string) => get<{ ok: boolean; entries?: FileHistoryEntry[]; error?: string }>(`/git/file-history?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  gitBisectStatus: (root: string) => get<GitBisectStatus>(`/git/bisect-status?root=${encodeURIComponent(root)}`),
  gitBisectStart: (root: string, bad: string, good: string) => post<GitActionResult>("/git/bisect-start", { root, bad, good }),
  gitBisectMark: (root: string, mark: "good" | "bad") => post<GitActionResult>("/git/bisect-mark", { root, mark }),
  gitBisectReset: (root: string) => post<GitActionResult>("/git/bisect-reset", { root }),
  gitSearchCommits: (root: string, q: string, author?: string, since?: string) => get<{ ok: boolean; entries: FileHistoryEntry[]; error?: string }>(`/git/search-commits?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}${author ? `&author=${encodeURIComponent(author)}` : ""}${since ? `&since=${encodeURIComponent(since)}` : ""}`),
  gitGrep: (root: string, q: string, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }) => get<{ ok: boolean; hits: GitGrepHit[]; error?: string }>(`/git/grep?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&caseSensitive=${opts.caseSensitive ? 1 : 0}&wholeWord=${opts.wholeWord ? 1 : 0}&regex=${opts.regex ? 1 : 0}`),
  gitPickaxe: (root: string, q: string, type?: "S" | "G") => get<{ ok: boolean; entries: FileHistoryEntry[]; error?: string }>(`/git/pickaxe?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&type=${type ?? "S"}`),
  gitTagCreate: (root: string, name: string, opts: { annotated?: boolean; message?: string; signed?: boolean; target?: string }) => post<GitActionResult>("/git/tag-create", { root, name, ...opts }),
  gitTagDelete: (root: string, name: string) => post<GitActionResult>("/git/tag-delete", { root, name }),
  gitTagPush: (root: string, name: string, remote?: string) => post<GitActionResult>("/git/tag-push", { root, name, remote }),
  gitTagDeleteRemote: (root: string, name: string, remote?: string) => post<GitActionResult>("/git/tag-delete-remote", { root, name, remote }),
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
  gitStashRename: (root: string, index: number, message: string) => post<GitActionResult>("/git/stash-rename", { root, index, message }),
  gitStashToBranch: (root: string, index: number, branch: string) => post<GitActionResult>("/git/stash-to-branch", { root, index, branch }),
  gitStashPartial: (root: string, paths: string[], keepIndex?: boolean) => post<GitActionResult>("/git/stash-partial", { root, paths, keepIndex: keepIndex === true }),
  gitStashApplyOverwrite: (root: string, index: number) => post<GitActionResult>("/git/stash-apply-overwrite", { root, index }),
  gitApplyHunk: (root: string, path: string, staged: boolean, action: "stage" | "unstage" | "discard", hunk: DiffHunk) => post<GitActionResult>("/git/apply-hunk", { root, path, staged, action, hunk }),
  gitConflictBlocks: (root: string, path: string) => get<{ ok: boolean; blocks: ConflictBlock[]; error?: string }>(`/git/conflict-blocks?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  gitResolveBlocks: (root: string, path: string, choices: BlockChoice[], stamp?: string) => post<GitActionResult>("/git/resolve-blocks", { root, path, choices, stamp }),
  /** What this stop conflicted, including the files already resolved — git
   *  forgets the set the moment one is staged, so the server keeps it. */
  gitMergeSession: (root: string) => get<MergeSessionView>(`/git/merge-session?root=${encodeURIComponent(root)}`),
  /** Put a resolved file back to how git left it. Refuses without `confirm`,
   *  because `git checkout --merge` destroys a hand resolution silently. */
  gitReopenConflict: (root: string, path: string, confirm: boolean) => post<GitActionResult>("/git/reopen-conflict", { root, path, confirm }),
  /** The whole conflicted file — text and conflicts together — plus the stamp
   *  that says which parse the choices were made against. */
  gitConflictFile: (root: string, path: string) => get<ConflictFile>(`/git/conflict-file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
  /** Which two sides git has stopped between, read from `.git` rather than
   *  deduced from the checkout's base — see MergeInfo. */
  gitMergeInfo: (root: string) => get<MergeInfo>(`/git/merge-info?root=${encodeURIComponent(root)}`),
  /** `scope` is whose history: this checkout's own by default, the whole repo
   *  on request. See logGraph() — the default used to be everything, which put
   *  other people's branches at the top of your own log. */
  gitGraph: (root: string, limit = 400, scope: "head" | "all" = "head") => get<{ lines: GitGraphLine[]; scope: "head" | "all"; branch: string }>(`/git/graph?root=${encodeURIComponent(root)}&limit=${limit}&scope=${scope}`),
  gitWorktrees: (root: string) => get<{ worktrees: GitWorktree[] }>(`/git/worktrees?root=${encodeURIComponent(root)}`),
  gitMerge: (root: string, name: string) => post<GitActionResult>("/git/merge", { root, name }),
  gitRebase: (root: string, name: string) => post<GitActionResult>("/git/rebase", { root, name }),
  gitBranchRename: (root: string, name: string, to: string) => post<GitActionResult>("/git/branch-rename", { root, name, to }),
  gitReset: (root: string, ref: string, mode: "soft" | "mixed" | "hard", force?: boolean) => post<GitActionResult>("/git/reset", { root, ref, mode, force }),
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
  /** Hand a worktree's root-owned files back, via the desktop's own auth
   *  dialog. chown only — the removal still runs as you. */
  gitWorktreeChown: (root: string, path: string) => post<GitActionResult>("/git/worktree-chown", { root, path }),
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
  gitMergeContinue: (root: string, anyway?: boolean) => post<GitActionResult>("/git/merge-continue", { root, anyway }),
  /** One sequencer run for the whole set — a conflict pauses the series, not
   *  each commit. Order is the caller's, oldest-first. */
  gitCherryPick: (root: string, hashes: string[], noCommit?: boolean) => post<GitActionResult>("/git/cherry-pick", { root, hashes, noCommit }),
  gitCherryPickContinue: (root: string) => post<GitActionResult>("/git/cherry-pick-continue", { root }),
  gitCherryPickAbort: (root: string) => post<GitActionResult>("/git/cherry-pick-abort", { root }),
  /** A new commit undoing the picked one, `--no-edit` so nothing opens. */
  gitRevert: (root: string, hash: string) => post<GitActionResult>("/git/revert", { root, hash }),
  /** Fold the staged changes into the previous commit. */
  /** Fold the staged changes into the previous commit — the Source Control
   *  composer's variant, which amends the index as it stands. */
  gitAmendStaged: (root: string, title: string, body: string) => post<GitActionResult>("/git/amend-staged", { root, title, body }),
  /** Fold a contiguous tip-span into one commit; ORIG_HEAD is the undo point. */
  gitSquash: (root: string, oldest: string, newest: string) => post<GitActionResult>("/git/squash", { root, oldest, newest }),
  /** The commits `base..HEAD`, oldest first, for the rebase editor. */
  gitRebaseSteps: (root: string, base: string) => post<GitActionResult & { steps?: { action: string; hash: string; subject: string }[] }>("/git/rebase-steps", { root, base }),
  /** Run the edited plan as one interactive rebase. */
  gitRebaseRun: (root: string, base: string, steps: { action: string; hash: string; subject: string; newMessage?: string }[]) => post<GitActionResult>("/git/rebase-run", { root, base, steps }),
  /** Compare two refs: how far ahead/behind each is, and the diff between them. */
  gitCompare: (root: string, base: string, other: string) => post<GitActionResult & { ahead?: GitCommit[]; behind?: GitCommit[]; diff?: GitFileChange[] }>("/git/compare", { root, base, other }),
  // --- live docker panel (lazydocker-style) ---
  /** Installed / daemon-down / OK — so the panel can show install guidance for a
   *  missing binary instead of the overview's daemon message. Mirrors gitCapability. */
  dockerCapability: () => get<DockerCapability>("/docker/capability"),
  dockerOverview: () => get<DockerOverview>("/docker/overview"),
  dockerStats: () => get<{ stats: DockerStat[] }>("/docker/stats"),
  dockerLogs: (id: string, tail = 400) => get<{ ok: boolean; text: string; error?: string }>(`/docker/logs?id=${encodeURIComponent(id)}&tail=${tail}`),

  // --- local tasks ---
  tasksList: (force = false) => get<TasksListResponse>(`/tasks/list${force ? "?force=1" : ""}`),
  taskAdd: (input: string, fingerprint?: string) => post<TaskWriteResponse>("/tasks/write/add", { input, fingerprint }),
  taskDone: (uuid: string, fingerprint?: string) => post<TaskWriteResponse>("/tasks/write/done", { uuid, fingerprint }),
  taskReopen: (uuid: string, fingerprint?: string) => post<TaskWriteResponse>("/tasks/write/reopen", { uuid, fingerprint }),
  taskDelete: (uuid: string, fingerprint?: string) => post<TaskWriteResponse>("/tasks/write/delete", { uuid, fingerprint }),
  taskPriority: (uuid: string, current: "H" | "M" | "L" | null, fingerprint?: string) =>
    post<TaskWriteResponse>("/tasks/write/priority", { uuid, current, fingerprint }),
  taskEdit: (uuid: string, input: string, previousTags: string[], fingerprint?: string) =>
    post<TaskWriteResponse>("/tasks/write/edit", { uuid, input, previousTags, fingerprint }),
  taskTags: (uuid: string, tags: string[], fingerprint?: string) =>
    post<TaskWriteResponse>("/tasks/write/tags", { uuid, tags, fingerprint }),
  taskNote: (uuid: string, oldText: string, newText: string, fingerprint?: string) =>
    post<TaskWriteResponse>("/tasks/write/note", { uuid, oldText, newText, fingerprint }),
  /** The same change to a run of tasks. `applied` comes back because a run can
   *  stop part-way, and the message on screen has to say how far it got. */
  taskBulk: (uuids: string[], action: "done" | "priority" | "tag" | "delete", value: string | null, fingerprint?: string) =>
    post<TaskWriteResponse & { applied?: number }>("/tasks/write/bulk", { uuids, action, value, fingerprint }),

  /* Integrations. `connect` is the only call in this file that sends a secret,
     and nothing here ever receives one back — the responses carry a status. */
  providers: () => get<ProvidersResponse>("/providers"),
  /** Where this app keeps things, and for how long. Paths, never contents. */
  privacy: () => get<{ db: string; config: string; credentials: string; retentionDays: number; pairedDevices: number }>("/privacy"),
  /** What is left of GitHub's hourly budget — this app is made of `gh` calls. */
  ghRateLimit: () => get<{ ok: boolean; error?: string; budgets?: { id: string; label: string; limit: number; remaining: number; reset: number }[] }>("/prs/rate-limit"),
  providerConnect: (id: string, token: string) =>
    post<{ ok: boolean; error?: string; status?: ProviderStatus }>("/providers/connect", { id, token }),
  providerDisconnect: (id: string) =>
    post<{ ok: boolean; error?: string; status?: ProviderStatus }>("/providers/disconnect", { id }),
  providerWorkspaces: (id: string) =>
    get<{ ok: boolean; workspaces?: { id: string; name: string }[]; error?: string }>(`/providers/workspaces?id=${encodeURIComponent(id)}`),
  providerWorkspace: (id: string, workspaceId: string, name: string) =>
    post<{ ok: boolean; error?: string; status?: ProviderStatus }>("/providers/workspace", { id, workspaceId, name }),
  providerTasks: (force = false) =>
    get<ProviderTasksResponse>(`/tasks/provider${force ? "?force=1" : ""}`),

  /* ClickUp boards. `clickupWrite*` are the only calls in this file that change
     anything in somebody's company workspace; each one carries the
     `date_updated` the client was looking at, so a card that moved underneath
     is refused rather than overwritten. */
  /* Recipes — saved commands. `recipesRender` shows what WILL run and never
     runs it; that separation is the whole safety story on the client side. */
  recipes: (root?: string) =>
    get<RecipesResponse>(`/recipes${root ? `?root=${encodeURIComponent(root)}` : ""}`),
  recipeSave: (r: Recipe) => post<{ ok: boolean; error?: string; recipe?: Recipe }>("/recipes/save", r as unknown as Record<string, unknown>),
  recipeRemove: (id: string) => post<{ ok: boolean }>("/recipes/remove", { id }),
  recipeRender: (id: string, values: Record<string, string>) =>
    get<{ ok: boolean; error?: string; steps?: string[]; confirm?: boolean; missing?: string[] }>(
      `/recipes/render?id=${encodeURIComponent(id)}&values=${encodeURIComponent(JSON.stringify(values))}`),
  clickupViews: () => get<ClickUpBoards>("/clickup/views"),
  clickupSetWrites: (on: boolean) => post<{ ok: boolean }>("/clickup/writes", { on }),
  clickupView: (id?: string, force = false) =>
    get<ViewTasksResponse>(`/clickup/view?${new URLSearchParams({ ...(id ? { id } : {}), ...(force ? { force: "1" } : {}) })}`),
  clickupAddView: (url: string) =>
    post<{ ok: boolean; error?: string; view?: SavedView }>("/clickup/views/add", { url }),
  clickupRemoveView: (id: string) => post<{ ok: boolean }>("/clickup/views/remove", { id }),
  /** Point a saved board at a different address. Resolves the new one before it
   *  drops the old — see replaceViewUrl. */
  clickupReplaceView: (id: string, url: string) =>
    post<{ ok: boolean; error?: string; view?: SavedView }>("/clickup/views/replace", { id, url }),
  /** One list's own statuses and fields, for a card that came from somewhere
   *  other than the board on screen. */
  clickupList: (id: string) =>
    get<{ ok: boolean; error?: string; name?: string; statuses?: ListStatus[]; fields?: ListField[]; place?: ListPlace }>(
      `/clickup/list?id=${encodeURIComponent(id)}`),
  /** Who can be put on a card, from the list it lives in. */
  clickupMembers: (list: string) =>
    get<{ ok: boolean; error?: string; members?: ListMember[] }>(`/clickup/members?list=${encodeURIComponent(list)}`),
  clickupPrs: (card: string, field: string, root: string) =>
    get<{ ok: boolean; prs: { number: number; title: string; state: string; draft?: boolean; url: string; stated?: boolean }[]; error?: string }>(
      `/clickup/prs?${new URLSearchParams({ card, field, root })}`),
  clickupFind: (q: string) =>
    get<{ ok: boolean; error?: string; task?: ProviderTask; asked?: string }>(`/clickup/find?q=${encodeURIComponent(q)}`),
  /** Merge the base into the pull request's branch in a worktree of its own, so
   *  the conflict exists somewhere it can be resolved. Writes — see the route. */
  prConflict: (root: string, number: number) =>
    post<{ ok: boolean; root?: string; conflicts?: string[]; clean?: boolean; error?: string }>("/prs/conflict", { root, number }),
  /** WHICH files would conflict, without merging anything — GitHub only ever
   *  says that a pull request conflicts, never where. Read-only: the merge
   *  happens in git's object database and the checkout is untouched. */
  prConflictFiles: (root: string, number: number) =>
    get<{ ok: boolean; conflicts: string[]; clean: boolean; stale?: boolean;
      /** You merged the base in here and have not pushed it — see gitwork.ts. */
      resolvedLocally?: { branch: string; ahead: number };
      error?: string }>(
      `/prs/conflict-files?root=${encodeURIComponent(root)}&number=${number}`),
  /** How far behind its base a pull request's branch is. Its own call: it costs
   *  about 600ms, and the detail should not wait on an offer. */
  /** The pull requests on a branch: one out of it, any number into it. By
   *  branch rather than by author — see prsForBranch. */
  prsForBranch: (root: string, branch: string) =>
    get<{ ok: boolean; repo?: string; from?: PrBranchSummary; into: PrBranchSummary[]; needsAuth?: boolean; error?: string }>(
      `/prs/for-branch?${new URLSearchParams({ root, branch })}`),
  /** Just the local half — whether your checkout is dirty, ahead, or can be
   *  fast-forwarded. Git only, no network, so it can be asked again while a
   *  pull request is open; `prBehind` holds the slow half. */
  prLocalHead: (root: string, branch: string) =>
    get<{ ok: boolean; local?: PrLocalHead }>(
      `/prs/local-head?${new URLSearchParams({ root, branch })}`),
  /** The latest run per check name for ONE pull request — the list's rollup
   *  counts a re-run's old attempt beside the new one. See prRollupStore. */
  prRollup: (root: string, number: number) =>
    get<{ ok: boolean; checks?: PrCheckRollup; error?: string }>(
      `/prs/rollup?${new URLSearchParams({ root, number: String(number) })}`),
  prBehind: (root: string, number: number) =>
    get<{ ok: boolean; behind?: number; ahead?: number; local?: PrLocalHead; error?: string }>(
      `/prs/behind?${new URLSearchParams({ root, number: String(number) })}`),
  /** Which saved board already holds this card. Local — the server answers from
   *  its cache, so this can be asked before every lookup. */
  clickupWhere: (id: string) =>
    get<{ ok: boolean; viewId?: string; task?: ProviderTask }>(`/clickup/where?id=${encodeURIComponent(id)}`),
  clickupTask: (id: string) =>
    get<{ ok: boolean; error?: string } & Partial<TaskDetail>>(`/clickup/task?id=${encodeURIComponent(id)}`),
  /** `user` puts somebody ELSE on the card; without it, you. */
  clickupAssign: (id: string, on: boolean, updated?: number, user?: number) =>
    post<ClickUpWrite>("/clickup/assign", { id, on, updated, ...(user != null ? { user } : null) }),
  clickupStatus: (id: string, status: string, updated?: number) =>
    post<ClickUpWrite>("/clickup/status", { id, status, updated }),
  /**
   * Several changes to one card, as one write.
   *
   * Not three calls in a row: `updated` is the precondition, the first write
   * moves it, and the second and third were refused as "somebody changed this
   * card while you had it open" — by us.
   */
  clickupCard: (id: string, changes: { add?: number[]; rem?: number[]; status?: string }, updated?: number) =>
    post<ClickUpWrite>("/clickup/card", { id, updated, ...changes }),
  clickupField: (id: string, field: string, value: string) =>
    post<ClickUpWrite>("/clickup/field", { id, field, value }),
  reminders: (window: "live" | "upcoming" | "history" = "live") =>
    get<RemindersResponse>(`/tasks/reminders?window=${window}`),
  remind: (body: { taskUuid?: string | null; title: string; civil: string; zone?: string; root?: string | null }) =>
    post<{ ok: boolean; reminder?: Reminder; error?: string }>("/tasks/remind", body),
  reminderAck: (id: string) => post<{ ok: boolean }>("/tasks/reminder/ack", { id }),
  reminderCancel: (id: string) => post<{ ok: boolean }>("/tasks/reminder/cancel", { id }),
  reminderSnooze: (id: string, minutes: number) => post<{ ok: boolean }>("/tasks/reminder/snooze", { id, minutes }),

  // --- github issues ---
  issuesList: (root: string, state = "open", q = "", assignee = "") =>
    get<IssuesReport>(`/issues/list?root=${encodeURIComponent(root)}&state=${state}`
      + `&q=${encodeURIComponent(q)}&assignee=${encodeURIComponent(assignee)}`),
  issueDetail: (root: string, number: number) =>
    get<{ ok: boolean; issue?: IssueDetail; error?: string }>(`/issues/detail?root=${encodeURIComponent(root)}&number=${number}`),
  /** The pull requests that close or mention an issue. Its own call rather than
   *  part of the detail: it is a second round trip, and the description should
   *  be on screen before it finishes. */
  issuePrs: (root: string, number: number) =>
    get<IssuePrsReport>(`/issues/prs?root=${encodeURIComponent(root)}&number=${number}`),
  /** Hand the server a prompt and get a ticket to open a pane with. The way a
   *  terminal with no tmux starts an agent — see server/src/agentticket.ts. */
  termAgentTicket: (cwd: string, prompt: string, yolo: boolean, title: string) =>
    post<{ ok: boolean; ticket?: string; error?: string }>("/terminal/agent", { cwd, prompt, yolo, title }),
  /** Everything with a worktree still on disk, so the list can say what is in
   *  progress without asking per row. */
  issuesWork: (repo = "") => get<{ work: IssueWork[] }>(`/issues/work?repo=${encodeURIComponent(repo)}`),
  issueStart: (root: string, number: number, mode: StartMode) =>
    post<IssueStartResult>("/issues/start", { root, number, mode }),
  /** Put the worktree away. Refused while it is dirty unless `force`. */
  issueFinish: (root: string, number: number, force = false) =>
    post<IssueActionResult>("/issues/finish", { root, number, force }),
  issueClaim: (root: string, number: number, comment?: string) =>
    post<IssueActionResult>("/issues/claim", { root, number, comment }),
  issueComment: (root: string, number: number, body: string) =>
    post<IssueActionResult>("/issues/comment", { root, number, body }),
  issueState: (root: string, number: number, close: boolean) =>
    post<IssueActionResult>("/issues/state", { root, number, close }),

  // --- what this machine is doing: ports, processes, disk ---
  /** Every listening TCP socket, with the process behind the ones we own. */
  machinePorts: () => get<PortsReport>("/machine/ports"),
  /** Every process this user owns, with the ones descended from this server
   *  marked. `limit` caps only the rest of the machine — ours all come back. */
  machineResources: (limit = 40) => get<ResourceReport>(`/machine/resources?limit=${limit}`),
  /** Where a checkout's disk went, one level down. A `du` walk: seconds on a
   *  repository with a node_modules, so it is asked for, never polled. */
  machineSpace: (root: string) => get<SpaceReport>(`/machine/space?root=${encodeURIComponent(root)}`),
  /** SIGTERM a process we started. Refused for anything this user does not own. */
  machineKill: (pid: number) => post<{ ok: boolean; error?: string; detail?: string }>("/machine/kill", { pid }),
  machineLocks: () => get<GitLocksReport>("/machine/locks"),
  machineProcess: (pid: number) => get<ProcDetail>(`/machine/process?pid=${pid}`),
  /** Desktop only — the server refuses this from a paired device on purpose. */
  machineEnv: (pid: number, key: string) => post<{ ok: boolean; value?: string; error?: string }>("/machine/env", { pid, key }),
  machineUnlock: (path: string) => post<{ ok: boolean; error?: string; detail?: string }>("/machine/unlock", { path }),

  // --- browsing and searching a checkout ---
  filesTree: (root: string, rel = "") => get<TreeReport>(`/files/tree?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`),
  /** One file as text, for the markdown viewer. Refuses a binary rather than
   *  handing back a screenful of replacement characters — see files.ts. */
  filesRead: (root: string, rel: string, ref?: string) =>
    get<{ ok: boolean; rel: string; text: string; bytes: number; truncated?: boolean; error?: string }>(
      `/files/read?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
  /** That ref's copy of a file, written out so the editor can open it. For
   *  everything the viewer does not render — which is everything but markdown. */
  filesTemp: (root: string, rel: string, ref: string) =>
    get<{ ok: boolean; file?: string; ref?: string; error?: string }>(
      `/files/temp?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}&ref=${encodeURIComponent(ref)}`),
  filesFind: (root: string, q: string, ref?: string) =>
    get<FindReport>(`/files/find?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
  /** Which of these paths the working tree still has — see filesExist. */
  filesExist: (root: string, rels: string[]) =>
    get<{ ok: boolean; here: string[]; error?: string }>(
      `/files/exist?root=${encodeURIComponent(root)}${rels.map((r) => `&rel=${encodeURIComponent(r)}`).join("")}`),
  /** Every branch this repository can be searched at — local and remote.
   *  Selecting one reads the object store; nothing is ever checked out. */
  filesRefs: (root: string) =>
    get<{ ok: boolean; local: string[]; remote: string[]; head?: string; error?: string }>(
      `/files/refs?root=${encodeURIComponent(root)}`),
  filesGrep: (root: string, q: string, ref?: string) =>
    get<GrepReport>(`/files/grep?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`),
  /** Where this server is reachable from another device, whether one has
   *  arrived, and which firewall is the likely reason if none has. */
  remoteStatus: () => get<RemoteStatus>("/remote/status"),
  /** Cut one device off (or let it back in). Closes the sockets it is holding
   *  as well as refusing what it sends next; only this machine may call it. */
  remoteDevice: (address: string, blocked: boolean) =>
    post<{ ok: boolean; address?: string; blocked?: boolean; closed?: number; error?: string }>("/remote/device", { address, blocked }),

  // --- pairing a device: the machine's half. See server/src/pairing.ts.
  //
  // Every one of these is refused unless it comes from loopback *and* carries
  // the machine's token, because the three things they do — start an
  // invitation, read the code, accept a request — are the three that have to
  // happen where the user is sitting.

  /** Start an invitation: a ticket for the QR and a code for the screen. */
  pairTicket: () => post<{ ok: boolean; id?: string; code?: string; expiresAt?: number; error?: string }>("/pair/ticket", {}),
  /** Close one early — when the pane is shut, or a fresh code is asked for. */
  pairCancel: (ticket: string) => post<{ ok: boolean }>("/pair/cancel", { ticket }),
  /** The live invitation, the requests waiting on a decision, and what is
   *  already paired — one poll, because the pane shows all three at once. */
  pairState: (ticket: string) => get<PairState>(`/pair/state?ticket=${encodeURIComponent(ticket)}`),
  pairAccept: (ticket: string, scope: DeviceScope) =>
    post<{ ok: boolean; device?: PairedDevice; error?: string }>("/pair/accept", { ticket, scope }),
  pairReject: (ticket: string) => post<{ ok: boolean }>("/pair/reject", { ticket }),
  /** Revoke one device's credential and close what it is holding. */
  pairForget: (id: string) => post<{ ok: boolean; closed?: number; error?: string }>("/pair/forget", { id }),

  /** Which agent CLIs are on this machine, and whether any is reporting. */
  agents: () => get<{ agents: AgentProbe[] }>("/agents"),
  /** Wire one — and only the one asked for. */
  agentConnect: (id: string, undo = false) =>
    post<{ ok: boolean; detail?: string; error?: string; agents?: AgentProbe[] }>("/agents/connect", { id, undo }),

  /** Spending limits, and where each stands right now. */
  budgets: () => get<{ budgets: Budget[]; status: BudgetStatus[]; models: string[] }>("/budgets"),
  /** Replace the whole set — a budget row has no identity to address a partial
   *  update at, since two can differ only by a limit being typed. */
  budgetsSet: (budgets: Budget[]) =>
    post<{ ok: boolean; persisted?: boolean; error?: string; budgets?: Budget[]; status?: BudgetStatus[] }>(
      "/budgets/set", { budgets }),

  updateStatus: () => get<UpdateStatus>("/update/status"),
  // The tag is optional because the automatic modal wants "whatever this build
  // came from", while About asks for a named release — the update it is about
  // to install, say, which is not the one running.
  updateNotes: (tag?: string) => get<ReleaseNotes>(`/update/notes${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`),
  updateRun: () => post<{ ok: boolean; error?: string }>("/update/run", {}),
  updateLog: () => get<{ ok: boolean; text: string }>("/update/log"),
  // Claude Code hook wiring (#187): read state, and turn it on/off by writing
  // ~/.claude/settings.json server-side (idempotent, backed up first).
  hooksStatus: () => get<HookSetupStatus>("/hooks/status"),
  hooksInstall: () => post<HookSetupResult>("/hooks/install", {}),
  hooksUninstall: () => post<HookSetupResult>("/hooks/uninstall", {}),
  dockerInspect: (id: string) => get<{ ok: boolean; env: string[]; config: string; error?: string }>(`/docker/inspect?id=${encodeURIComponent(id)}`),
  dockerTop: (id: string) => get<{ ok: boolean; text: string; error?: string }>(`/docker/top?id=${encodeURIComponent(id)}`),
  // --- pull requests (gh-backed) ---
  prCapability: (force = false) => get<{ available: boolean; authed: boolean; login?: string; reason?: string }>(`/prs/capability${force ? "?force=1" : ""}`),
  /** Emoji on anything: the body, a comment, a review, a line comment. `nodeId`
   *  is the GraphQL id, and `on:false` takes the reaction back off. */
  prReactTo: (root: string, nodeId: string, content: string, on: boolean) =>
    post<PrActionResult>("/prs/react", { root, nodeId, content, on }),
  prEditComment: (root: string, nodeId: string, body: string, kind: "issue" | "review" = "issue") =>
    post<PrActionResult>("/prs/comment-edit", { root, nodeId, body, kind }),
  prDeleteComment: (root: string, nodeId: string, kind: "issue" | "review" = "issue") =>
    post<PrActionResult>("/prs/comment-delete", { root, nodeId, kind }),
  /** GitHub's own viewed tick, so it survives leaving the panel. */
  prFileViewed: (root: string, prNodeId: string, path: string, viewed: boolean) =>
    post<PrActionResult>("/prs/file-viewed", { root, prNodeId, path, viewed }),
  prAssignees: (root: string, number: number, add: string[], remove: string[]) =>
    post<PrActionResult>("/prs/assignees", { root, number, add, remove }),
  prMilestone: (root: string, number: number, title: string) =>
    post<PrActionResult>("/prs/milestone", { root, number, title }),
  prList: (root: string, filter: "mine" | "review" | "all", state: "open" | "closed" | "all" = "open", force = false, after?: string, q?: string) =>
    get<PrListResponse>(`/prs/list?root=${encodeURIComponent(root)}&filter=${filter}&state=${state}${force ? "&force=1" : ""}${after ? `&after=${encodeURIComponent(after)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  /** Apply a suggested change: reads the file, splices the lines, commits. */
  prApplySuggestion: (root: string, number: number, a: { path: string; startLine?: number; line: number; suggestion: string; author?: string }) =>
    post<PrActionResult>("/prs/apply-suggestion", { root, number, ...a }),
  /** A slice of a file at one side — for expanding diff context, and for the
   *  bytes of a binary the diff cannot carry. */
  prFileSlice: (root: string, number: number, path: string, side: "LEFT" | "RIGHT", from?: number, to?: number) =>
    get<{ ok: boolean; lines?: string[]; start?: number; total?: number; binary?: boolean; url?: string; error?: string }>(
      `/prs/file-slice?root=${encodeURIComponent(root)}&number=${number}&path=${encodeURIComponent(path)}&side=${side}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  /** What the facet menus can offer — from the repository, not the page. */
  prFacets: (root: string) =>
    get<{ ok: boolean; data?: { authors: string[]; assignees: string[]; labels: { name: string; color: string }[]; milestones: string[]; bases: string[] }; error?: string }>(
      `/prs/facets?root=${encodeURIComponent(root)}`),
  /** Who `@` can complete to, and which issues `#` can. */
  prMentions: (root: string) =>
    get<{ ok: boolean; data?: { users: string[]; issues: { number: number; title: string }[] }; error?: string }>(
      `/prs/mentions?root=${encodeURIComponent(root)}`),
  /** One line comment, posted on its own — no review, no verdict. */
  prLineComment: (root: string, number: number, c: { path: string; line: number; startLine?: number; side?: "LEFT" | "RIGHT"; body: string }) =>
    post<PrActionResult>("/prs/line-comment", { root, number, ...c }),
  /** One CI job's log, read in the app instead of sending you to a browser. */
  prJobLog: (root: string, job: string) =>
    get<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>(
      `/prs/job-log?root=${encodeURIComponent(root)}&job=${encodeURIComponent(job)}`),
  prCheckJobs: (root: string, number: number) =>
    get<{ ok: boolean; jobs?: PrCheckJob[]; error?: string }>(
      `/prs/check-jobs?root=${encodeURIComponent(root)}&number=${number}`),
  /** Re-run everything, only the failures, or a single job. */
  prRerunJobs: (root: string, what: "all" | "failed" | "job", id: string) =>
    post<PrActionResult>("/prs/rerun-jobs", { root, what, id }),
  /** Exact totals for every saved view, in one request. */
  prCounts: (root: string, state: "open" | "closed" | "all") =>
    get<{ ok: boolean; counts?: { review: number; mine: number; failing: number; ready: number; all: number }; error?: string }>(
      `/prs/counts?root=${encodeURIComponent(root)}&state=${state}`),
  prDetail: (root: string, number: number, force = false) =>
    get<{ ok: boolean; detail?: PrDetail; error?: string; stale?: boolean }>(`/prs/detail?root=${encodeURIComponent(root)}&number=${number}${force ? "&force=1" : ""}`),
  prDiff: (root: string, number: number) =>
    get<{ ok: boolean; text?: string; error?: string }>(`/prs/diff?root=${encodeURIComponent(root)}&number=${number}`),
  /** Images in a PR body go through the server, which attaches the gh token —
   *  GitHub's own attachment URLs 404 without it. This is an `<img src>`, a
   *  navigation the browser can't put an auth header on, so the shared secret
   *  rides as ?token= (see withToken) — omit it and every avatar 401s when a
   *  token is configured. */
  prAssetUrl: (raw: string) => withToken(`${SERVER}/prs/asset?url=${encodeURIComponent(raw)}`),
  prReview: (root: string, number: number, verb: "approve" | "request_changes" | "comment", body: string) =>
    post<PrActionResult>("/prs/review", { root, number, verb, body }),
  /** A verdict plus every line comment queued while reading the diff, in one
   *  request — GitHub's "pending review", which arrives as one notification
   *  instead of a scatter. */
  prReviewWith: (root: string, number: number, verb: "approve" | "request_changes" | "comment", body: string,
    comments: { path: string; line: number; startLine?: number; side?: "LEFT" | "RIGHT"; startSide?: "LEFT" | "RIGHT"; body: string }[]) =>
    post<PrActionResult>("/prs/review-with", { root, number, verb, body, comments }),
  prComment: (root: string, number: number, body: string) => post<PrActionResult>("/prs/comment", { root, number, body }),
  prReply: (root: string, number: number, commentId: number, body: string) => post<PrActionResult>("/prs/reply", { root, number, commentId, body }),
  prSetThreadResolved: (root: string, threadId: string, resolved: boolean) => post<PrActionResult>("/prs/thread-resolved", { root, threadId, resolved }),
  prReact: (root: string, commentId: number, content = "+1") => post<PrActionResult>("/prs/react", { root, commentId, content }),
  prEdit: (root: string, number: number, patch: { title?: string; body?: string; base?: string }) => post<PrActionResult>("/prs/edit", { root, number, ...patch }),
  prLabels: (root: string, number: number, add: string[], remove: string[]) => post<PrActionResult>("/prs/labels", { root, number, add, remove }),
  /** A pull request's version of a file, written to a temp copy so it can be
   *  opened. The working tree holds whatever branch you have out, which for
   *  somebody else's pull request is a different file wearing the same path. */
  prFileTemp: (root: string, number: number, path: string) =>
    post<{ ok: boolean; file?: string; sha?: string; error?: string }>("/prs/file-temp", { root, number, path }),
  prReviewers: (root: string, number: number, add: string[], remove: string[]) => post<PrActionResult>("/prs/reviewers", { root, number, add, remove }),
  prDraft: (root: string, number: number, draft: boolean) => post<PrActionResult>("/prs/draft", { root, number, draft }),
  /** `syncLocal` asks the server to fast-forward this machine's copy of the
   *  branch afterwards, when that is safe — see PrLocalHead. */
  prUpdateBranch: (root: string, number: number, syncLocal = false) =>
    post<PrActionResult>("/prs/update-branch", { root, number, syncLocal }),
  prRerun: (root: string, number: number) => post<PrActionResult>("/prs/rerun", { root, number }),
  prMerge: (root: string, number: number, method: "squash" | "merge" | "rebase", opts: { deleteBranch?: boolean; auto?: boolean; headSha?: string; subject?: string; body?: string; disableAuto?: boolean }) =>
    post<PrActionResult>("/prs/merge", { root, number, method, ...opts }),
  prClose: (root: string, number: number, reopen = false) => post<PrActionResult>("/prs/close", { root, number, reopen }),
  /** The prompt to review a PR with Claude, and the directory to run it in.
   *  Reads only: no fetch, no checkout, nothing left behind. */
  /** The line comments GitHub is holding in your unsubmitted review, so the
   *  Review tab can show a review you started in the browser instead of
   *  claiming nothing is queued. */
  /** A note on a ClickUp card's activity. `assignee` is what makes it arrive:
   *  an `@Name` inside the text is plain text and notifies nobody. */
  clickupComment: (id: string, text: string, assignee?: number) =>
    post<{ ok: boolean; error?: string; unauthorised?: boolean }>("/clickup/comment", { id, text, ...(assignee != null ? { assignee } : null) }),
  /** Whether the agent on this machine can post to Slack — see slackreach.ts. */
  notifyReach: () => get<{ ok: boolean; slack: boolean }>("/notify/reach"),
  prPendingReview: (root: string, number: number) =>
    post<{ ok: boolean; id: string | null; comments: { path: string; line: number | null; startLine: number | null; body: string }[] }>("/prs/pending-review", { root, number }),
  prReviewPrompt: (root: string, number: number) =>
    post<{ ok: boolean; cwd?: string; prompt?: string; branch?: string; error?: string }>("/prs/review-prompt", { root, number }),
  /** Where a local branch lives on the web. A live branch resolves to its tree
   *  with no network at all; a gone one resolves to the PR it came from. */
  prCommitDiff: (root: string, sha: string) =>
    get<{ ok: boolean; text?: string; error?: string }>(`/prs/commit-diff?root=${encodeURIComponent(root)}&sha=${encodeURIComponent(sha)}`),
  prBranchUrl: (root: string, branch: string, gone: boolean) =>
    get<{ ok: boolean; url?: string; kind?: "tree" | "pr"; error?: string }>(
      `/prs/branch-url?root=${encodeURIComponent(root)}&branch=${encodeURIComponent(branch)}&gone=${gone ? "true" : "false"}`),

  // --- in-browser terminal: ready-to-run project commands (make + scripts) ---
  terminalCommands: (root: string) => get<TerminalCommands>(`/terminal/commands?root=${encodeURIComponent(root)}`),
  // --- multi-chat: drive a claude session from the browser ---
  // `models` rides along for the same reason it does on the other two agents:
  // the panel cannot usefully draw a model picker without knowing what the CLI
  // will accept, and asking twice would let it render one for a CLI that turns
  // out not to be there. Claude's list is data on the server
  // (shared/claude-models.json) rather than a table compiled in here.
  chatEnabled: () => get<{ enabled: boolean; bypass?: boolean; models?: AgentModel[]; tmuxEngine?: TmuxEngineInfo }>("/chat/enabled"),
  /** The command that hands a chat to the user's own terminal, and whether its
   *  pane is up right now. Assembled server-side so the socket name never has to
   *  be duplicated here. */
  chatAttach: (session: string) => get<{ command: string; live: boolean }>(`/chat/attach?session=${encodeURIComponent(session)}`),
  /** Give a chat's warm CLI back. Destroys no conversation — the transcript
   *  stays on disk and resuming relaunches the pane with `--resume`. */
  chatPaneClose: (session: string) => post<{ killed: boolean }>("/chat/pane/close", { session }),
  /** Press one key in a chat's pane, and get back what it shows afterwards.
   *  Only navigation and the two answers a prompt takes — the server keeps its
   *  own allowlist, since this reaches a live terminal running an agent. */
  chatPaneKey: (session: string, key: string) => post<{ screen: string }>("/chat/pane/key", { session, key }),
  /** Exempt this chat's pane from idle eviction. About idleness only — closing
   *  the chat still releases the pane. */
  chatPanePin: (session: string, pinned: boolean) =>
    post<{ ok: boolean; session: string; pinned: boolean }>("/chat/pane/pin", { session, pinned }),
  /** Every pane on this machine, with which of them belongs to nothing. `open`
   *  is the chats this client has on screen — the server does not know, and a
   *  pane belonging to a chat in another window is not an orphan. */
  chatPanes: (open: string[]) =>
    get<ChatPaneList>(`/chat/panes?open=${encodeURIComponent(open.join(","))}`),
  chatStream: (payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[]; images?: ChatImage[]; engine?: ChatEngine; effort?: ChatEffort }, onEvent: (o: Record<string, unknown>) => void, signal?: AbortSignal) =>
    turnStream("/chat/send", payload, onEvent, signal),

  // --- multi-chat: the same panel, driving codex instead ---
  // Codex takes neither an allowlist nor pasted images, so its payload is the
  // Claude one minus the two things it has no equivalent for.
  codexEnabled: () => get<CodexStatus>("/codex/enabled"),
  // What a codex thread said, read from Codex's own rollout on disk. The OTel
  // stream that puts Codex on the radar carries tool calls but no prose, so this
  // is the only source for a resumed thread's history — see codexTranscript().
  codexTranscript: (id: string) => get<{ timeline: SessionDetail["timeline"] }>(`/codex/transcript?id=${encodeURIComponent(id)}`),
  codexStream: (payload: { cwd: string; message: string; model: string; mode: string; resumeId: string }, onEvent: (o: Record<string, unknown>) => void, signal?: AbortSignal) =>
    turnStream("/codex/send", payload, onEvent, signal),

  // --- multi-chat: the same panel, driving google antigravity ---
  // No transcript call to match the other two: Antigravity keeps a conversation
  // as protobuf inside SQLite, so there is nothing readable to ask for.
  antigravityEnabled: () => get<AgentCliStatus>("/antigravity/enabled"),
  antigravityStream: (payload: { cwd: string; message: string; model: string; mode: string; resumeId: string }, onEvent: (o: Record<string, unknown>) => void, signal?: AbortSignal) =>
    turnStream("/antigravity/send", payload, onEvent, signal),

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
  // No tmux behind a demo build, so there is never a pane to point at — which
  // lands the panel on the sentence it already has for that case.
  agentPanes: () => D({ ok: false, reason: "not in the demo", panes: [] as AgentPane[] }),
  paneDirs: () => D({ ok: true, pane: null, dirs: [] as string[] }),
  focusPane: (_p: { sessionId: string; windowId: string; paneId: string }) => D({ ok: false, error: "not in the demo" }),
  stats: (windowMs: number, provider?: string) => D(demo.stats(windowMs, provider)),
  usageDaily: (days = 90) => D(demo.usageDaily(days)),
  sessions: (_limit?: number, provider?: string) => D(demo.sessions(provider)),
  filterOptions: () => D(demo.filterOptions()),
  exportUrl: (fmt: "csv" | "json", kind: "events" | "daily" = "events") =>
    kind === "daily" ? demo.dailyExportUri(fmt) : demo.eventsExportUri(fmt),
  skillsExportUrl: () => demo.skillsExportUri(),
  providerUsage: () => D(demo.providerUsage() as ProviderUsage[]),
  refreshCodexUsage: () => D({ ok: false, error: "not available in the demo" }),
  skills: () => D(demo.skills()),
  changes: () => D(demo.changes()),
  session: (id: string) => D(demo.session(id)),
  // Nothing spawns anything in the demo, so nothing is ever mid-turn.
  chatActive: () => D({ ids: [] as string[] }),
  insights: () => D(demo.insights()),
  search: (q: string) => D(demo.search(q)),
  gatePending: () => D(demo.gatePending()),
  gateHistory: () => D({ gates: [] as GateRecord[] }),
  actions: () => D(demo.actions()),
  gateDecide: (id: string) => D(demo.gateDecide(id)),
  gitStatus: (_paths: string[]) => D(demo.gitStatus()),
  gitCommit: (_payload: { root: string; files: string[]; title: string; body: string }) => D(demo.gitCommit()),
  gitAmend: (_payload: { root: string; files: string[]; title: string; body: string }) => D(demo.gitCommit()),
  walkthrough: (files: WalkthroughInputFile[]) => D(demo.walkthrough(files)),
  setWorkspace: (_root: string | null) => D({ ok: false, workspace: null, persisted: false, error: "unavailable in the demo" }),
  // The demo has no filesystem to browse, so completion is simply always empty.
  fsComplete: (_prefix: string) => D({ base: "", entries: [], truncated: false }),
  cloneProject: (_url: string, _parent: string) => D({ ok: false, error: "unavailable in the demo" }),
  newProject: (_name: string, _parent: string) => D({ ok: false, error: "unavailable in the demo" }),
  gitCapability: () => D({ available: true } as GitCapability),
  // The demo runs no local processes, so it has nothing to probe. The catalog
  // is still the honest thing to show: it is what the real app would check.
  dependencies: (_force = false) => D({
    platform: "demo",
    deps: DEPS.map((d) => ({ ...d, status: "unsupported" as const, detail: "the demo runs no local processes, so nothing here is probed" })),
  } as DepsResponse),
  gitRepos: () => D(demo.gitRepos()),
  browserPlaces: () => D({ ok: true, places: [] as ImportedPlace[] }),
  browserPlaceCount: () => D({ ok: true, total: 0, bookmarks: 0, sources: [] as string[] }),
  saveBrowserPlaces: (_s: string, _p: ImportedPlace[]) => D({ ok: false, error: "not available in the demo" }),
  forgetBrowserPlaces: () => D({ ok: true, total: 0 }),
  recordVisit: (_url: string, _title: string) => D({ ok: true }),
  saveScratchImage: (_d: string, _n: string) => D({ ok: false, error: "not available in the demo" }),
  gitReposAll: () => D(demo.gitRepos()),
  browserUseStatus: () => D({
    cli: { state: "missing" as const, path: "", target: null },
    skill: { state: "unshipped" as const, path: "", shipped: null },
    windows: 0, desktop: false,
  }),
  browserUseInstall: () => D({ ok: false, error: "unavailable in the demo" }),
  browserReady: (_client: string, _on: boolean) => D({ ok: true }),
  browserResult: (_r: { id: string; ok: boolean; value?: unknown; error?: string }) => D({ ok: true, known: false }),
  hideProject: (_path: string, _hidden: boolean) => D({ ok: false, hidden: [] as string[], persisted: false, error: "unavailable in the demo" }),
  gitTree: (root: string) => D(demo.gitTree(root)),
  gitChangesAll: () => D({ changes: [] as FileChange[] }),
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
  gitRepoStats: (_root: string, _days?: number) => D({ days: 30, commitsPerDay: 0, contributors: [], filesTouched: 0, linesChanged: 0, topContributors: [], hotspots: [], churn: [] } as RepoStats),
  gitChangelog: (_root: string, _from?: string, _to?: string) => D({ from: "", to: "", sections: [] } as Changelog),
  gitSubmodules: (_root: string) => D({ submodules: [] as GitSubmodule[] }),
  gitSubmoduleAdd: (_root: string, _url: string, _path: string) => D(demo.gitActionUnavailable()),
  gitSubmoduleUpdate: (_root: string, _path?: string) => D(demo.gitActionUnavailable()),
  gitSubmoduleSync: (_root: string, _path?: string) => D(demo.gitActionUnavailable()),
  gitSubmoduleDeinit: (_root: string, _path: string) => D(demo.gitActionUnavailable()),
  gitSubmoduleRemove: (_root: string, _path: string) => D(demo.gitActionUnavailable()),
  gitBlame: (_root: string, _path: string, _ref?: string) => D({ ok: false, error: "not available in the demo" }),
  gitFileHistory: (_root: string, _path: string) => D({ ok: false, error: "not available in the demo" }),
  gitBisectStatus: (_root: string) => D({ ok: true, bisecting: false }),
  gitBisectStart: (_root: string, _bad: string, _good: string) => D(demo.gitActionUnavailable()),
  gitBisectMark: (_root: string, _mark: "good" | "bad") => D(demo.gitActionUnavailable()),
  gitBisectReset: (_root: string) => D(demo.gitActionUnavailable()),
  gitSearchCommits: (_root: string, _q: string, _author?: string, _since?: string) => D({ ok: false, entries: [], error: "not available in the demo" }),
  gitGrep: (_root: string, _q: string, _opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }) => D({ ok: false, hits: [], error: "not available in the demo" }),
  gitPickaxe: (_root: string, _q: string, _type?: "S" | "G") => D({ ok: false, entries: [], error: "not available in the demo" }),
  gitTagCreate: (_root: string, _name: string, _opts: { annotated?: boolean; message?: string; signed?: boolean; target?: string }) => D(demo.gitActionUnavailable()),
  gitTagDelete: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitTagPush: (_root: string, _name: string, _remote?: string) => D(demo.gitActionUnavailable()),
  gitTagDeleteRemote: (_root: string, _name: string, _remote?: string) => D(demo.gitActionUnavailable()),
  gitCommandLog: (_since?: number) => D({ entries: [] as GitLogEntry[] }),
  editorCapability: () => D({ hasNvim: false, editor: null as string | null }),
  editorTarget: (_path: string) => D({ running: false, hasNvim: false }),
  editorOpen: (_path: string, _line: number) => D({ ok: false, error: "no editor in the demo" }),
  gitLog: (_root: string, _limit?: number) => D(demo.gitLog()),
  gitCommitDiff: (_root: string, hash: string) => D(demo.gitCommitDiff(hash)),
  gitRefs: (_root: string) => D({ ok: true, refs: ["main", "origin/main"] as string[] }),
  gitSnapshots: (_root: string) => D({ ok: true, snapshots: [] as { sha: string; ref: string; time: string; label: string }[] }),
  gitSnapshotCreate: (_root: string, _label?: string) => D(demo.gitActionUnavailable()),
  gitSnapshotRestore: (_root: string, _sha: string) => D(demo.gitActionUnavailable()),
  gitSnapshotDelete: (_root: string, _sha: string) => D(demo.gitActionUnavailable()),
  gitProtectedBranches: (_root: string) => D({ ok: true, branches: ["main", "master"] as string[] }),
  gitProtectedBranchesSet: (_root: string, _names: string[]) => D(demo.gitActionUnavailable()),
  gitStashes: (_root: string) => D(demo.gitStashes()),
  gitTidy: (_root: string) => D({ root: "", base: "main", findings: [], error: "not available in the demo" }),
  gitCheckout: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchCreate: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchDelete: (_root: string, _name: string, _force: boolean) => D(demo.gitActionUnavailable()),
  gitStashPush: (_root: string, _message: string) => D(demo.gitActionUnavailable()),
  gitStashApply: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitStashPop: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitStashDrop: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitStashRename: (_root: string, _index: number, _message: string) => D(demo.gitActionUnavailable()),
  gitStashToBranch: (_root: string, _index: number, _branch: string) => D(demo.gitActionUnavailable()),
  gitStashPartial: (_root: string, _paths: string[], _keepIndex?: boolean) => D(demo.gitActionUnavailable()),
  gitStashApplyOverwrite: (_root: string, _index: number) => D(demo.gitActionUnavailable()),
  gitApplyHunk: (_root: string, _path: string, _staged: boolean, _action: "stage" | "unstage" | "discard", _hunk: DiffHunk) => D(demo.gitActionUnavailable()),
  gitConflictBlocks: (_root: string, _path: string) => D({ ok: false, blocks: [] as ConflictBlock[], error: "not available in the demo" }),
  gitResolveBlocks: (_root: string, _path: string, _choices: BlockChoice[], _stamp?: string) => D(demo.gitActionUnavailable()),
  gitMergeSession: (_root: string) => D({ ok: true, op: "", files: [], left: [], mine: [] } as MergeSessionView),
  gitReopenConflict: (_root: string, _path: string, _confirm: boolean) => D(demo.gitActionUnavailable()),
  gitConflictFile: (_root: string, _path: string) => D({ ok: false, segments: [], blocks: [], lines: 0, stamp: "", error: "not available in the demo" } as ConflictFile),
  gitMergeInfo: (_root: string) => D({ ok: true, state: "clean", ours: null, theirs: null } as MergeInfo),
  gitGraph: (_root: string, _limit?: number, _scope?: "head" | "all") => D({ ...demo.gitGraph(), scope: "head" as const, branch: "main" }),
  gitWorktrees: (_root: string) => D(demo.gitWorktrees()),
  gitMerge: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitRebase: (_root: string, _name: string) => D(demo.gitActionUnavailable()),
  gitBranchRename: (_root: string, _name: string, _to: string) => D(demo.gitActionUnavailable()),
  gitReset: (_root: string, _ref: string, _mode: "soft" | "mixed" | "hard", _force?: boolean) => D(demo.gitActionUnavailable()),
  gitWorktreeAdd: (_root: string, _path: string, _branch: string, _newBranch: boolean, _startPoint?: string) => D(demo.gitActionUnavailable()),
  gitSyncBase: (_root: string, _base?: string) => D(demo.gitActionUnavailable()),
  gitSetBase: (_root: string, _branch: string, _base: string | null) => D(demo.gitActionUnavailable()),
  gitBaseCandidates: (_root: string) => D({ ok: true, refs: [] }),
  gitConflicts: (_root: string) => D({ ok: true, state: "clean", files: [] }),
  gitResolve: (_root: string, _paths: string[], _side: "ours" | "theirs") => D(demo.gitActionUnavailable()),
  gitMergeAbort: (_root: string) => D(demo.gitActionUnavailable()),
  gitUndoMerge: (_root: string) => D(demo.gitActionUnavailable()),
  gitMergeContinue: (_root: string, _anyway?: boolean) => D(demo.gitActionUnavailable()),
  gitCherryPick: (_root: string, _hashes: string[], _noCommit?: boolean) => D(demo.gitActionUnavailable()),
  gitCherryPickContinue: (_root: string) => D(demo.gitActionUnavailable()),
  gitCherryPickAbort: (_root: string) => D(demo.gitActionUnavailable()),
  gitRevert: (_root: string, _hash: string) => D(demo.gitActionUnavailable()),
  gitAmendStaged: (_root: string, _title: string, _body: string) => D(demo.gitActionUnavailable()),
  gitSquash: (_root: string, _oldest: string, _newest: string) => D(demo.gitActionUnavailable()),
  gitRebaseSteps: (_root: string, _base: string) => D(demo.gitActionUnavailable()),
  gitRebaseRun: (_root: string, _base: string, _steps: { action: string; hash: string; subject: string; newMessage?: string }[]) => D(demo.gitActionUnavailable()),
  gitCompare: (_root: string, _base: string, _other: string) => D(demo.gitActionUnavailable()),
  gitWorktreeRemove: (_root: string, _path: string, _force: boolean) => D(demo.gitActionUnavailable()),
  gitWorktreeLeftovers: (_root: string, _paths: string[]) => D({ leftovers: [] as WorktreeLeftovers[] }),
  gitWorktreeRescue: (_root: string, _path: string, _paths: string[]) => D(demo.gitActionUnavailable()),
  gitWorktreeChown: (_root: string, _path: string) => D(demo.gitActionUnavailable()),
  dockerCapability: () => D({ available: true, version: "27.0.3" } as DockerCapability),
  dockerOverview: () => D(demo.dockerOverview()),
  dockerStats: () => D(demo.dockerStats()),
  dockerLogs: (id: string, _tail?: number) => D(demo.dockerLogs(id)),
  updateNotes: (_tag?: string) => D({ ok: false, tag: "", notes: "", source: "", error: "not available in the demo" } as ReleaseNotes),
  remoteStatus: () => D({ exposed: false, bind: "127.0.0.1", port: 4000, trustLan: false, tokenRequired: false, webUi: true, urls: [], addresses: [], clients: { count: 0, lastAt: null, addresses: [], liveCount: 0 }, devices: [], firewall: null } as RemoteStatus),
  remoteDevice: (_address: string, _blocked: boolean) => D({ ok: false, error: "not available in the demo" }),
  // Pairing needs a machine on the other end of it. The demo has none, and a
  // QR that cannot lead anywhere is worse than an absent one.
  pairTicket: () => D({ ok: false, error: "not available in the demo" }),
  pairCancel: (_ticket: string) => D({ ok: false }),
  pairState: (_ticket: string) => D({ ticket: null, pending: [], devices: [] } as PairState),
  pairAccept: (_ticket: string, _scope: DeviceScope) => D({ ok: false, error: "not available in the demo" }),
  pairReject: (_ticket: string) => D({ ok: false }),
  pairForget: (_id: string) => D({ ok: false, error: "not available in the demo" }),
  // The demo runs on a page, not a machine — there is no PATH to probe and
  // nothing to wire, and an empty list is the truth rather than a placeholder.
  agents: () => D({ agents: [] as AgentProbe[] }),
  agentConnect: (_id: string, _undo?: boolean) => D({ ok: false, error: "not available in the demo" }),
  budgets: () => D({ budgets: [], status: [], models: [] }),
  budgetsSet: (_budgets: Budget[]) => D({ ok: false, error: "not available in the demo" }),
  updateStatus: () => D({ ok: true, available: false, info: { version: "demo", commit: "", builtAt: "", source: "", origin: "", baseTag: "", distance: 0, stamp: "demo", tree: "", dirty: false, dirtyCount: 0, dirtyFiles: [] }, branch: "", behind: 0, ahead: 0, incoming: [], blocked: "not available in the demo" } as UpdateStatus),
  updateRun: () => D({ ok: false, error: "not available in the demo" }),
  hooksStatus: () => D({ installed: false, bundled: false, settingsPath: "~/.claude/settings.json", python: "python3" } as HookSetupStatus),
  hooksInstall: () => D({ ok: false, installed: false, changed: false, settingsPath: "~/.claude/settings.json", error: "not available in the demo" } as HookSetupResult),
  hooksUninstall: () => D({ ok: false, installed: false, changed: false, settingsPath: "~/.claude/settings.json", error: "not available in the demo" } as HookSetupResult),
  updateLog: () => D({ ok: true, text: "" }),
  dockerInspect: (_id: string) => D({ ok: false, env: [] as string[], config: "", error: "not available in the demo" }),
  dockerTop: (_id: string) => D({ ok: false, text: "", error: "not available in the demo" }),
  terminalCommands: (_root: string) => D({ enabled: false, make: [], scripts: [] } as TerminalCommands),
  chatEnabled: () => D({ enabled: false, models: [] as AgentModel[], tmuxEngine: { available: false, reason: "the demo runs no local processes", defaultOn: false } }),
  chatAttach: (_session: string) => D({ command: "", live: false }),
  chatPaneClose: (_session: string) => D({ killed: false }),
  chatPaneKey: (_session: string, _key: string) => D({ screen: "" }),
  chatPanePin: (_session: string, pinned: boolean) => D({ ok: false, session: "", pinned }),
  // The demo runs no processes, so there is nothing to list and nothing to
  // reclaim. An empty list is the truth here rather than a placeholder.
  chatPanes: (_open: string[]) => D({ panes: [], idleEvictMs: 0 } as ChatPaneList),
  chatStream: async (_payload: { cwd: string; message: string; model: string; mode: string; resumeId: string; allowedTools?: string[]; images?: ChatImage[]; engine?: ChatEngine; effort?: ChatEffort }, onEvent: (o: Record<string, unknown>) => void) => {
    onEvent({ type: "system", subtype: "init", session_id: "demo" });
    onEvent({ type: "assistant", message: { content: [{ type: "text", text: "(chat is disabled in the demo — run agentglass locally to drive real Claude sessions)" }] } });
    onEvent({ type: "result", result: "" });
  },
  codexEnabled: () => D({ enabled: false, models: [] } as CodexStatus),
  codexTranscript: (_id: string) => D({ timeline: [] as SessionDetail["timeline"] }),
  codexStream: async (_payload: { cwd: string; message: string; model: string; mode: string; resumeId: string }, onEvent: (o: Record<string, unknown>) => void) => {
    onEvent({ type: "thread.started", thread_id: "demo" });
    onEvent({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "(chat is disabled in the demo — run agentglass locally to drive real Codex sessions)" } });
    onEvent({ type: "turn.completed", usage: {} });
  },
  antigravityEnabled: () => D({ enabled: false, models: [] } as AgentCliStatus),
  antigravityStream: async (_payload: { cwd: string; message: string; model: string; mode: string; resumeId: string }, onEvent: (o: Record<string, unknown>) => void) => {
    onEvent({ event: "init", conversation_id: "demo-0000-0000-0000-demodemodemo", init: { model: "demo" } });
    onEvent({ event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "(chat is disabled in the demo — run agentglass locally to drive real Antigravity sessions)" } });
    onEvent({ event: "result", result: { status: "SUCCESS", usage: {} } });
  },
  dockerStart: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerStop: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerRestart: (_id: string) => D(demo.dockerActionUnavailable()),
  dockerRm: (_id: string) => D(demo.dockerActionUnavailable()),

  // The demo has no GitHub behind it, and pretending otherwise would put a
  // fake PR list in front of someone evaluating the app. It reports the same
  // "gh isn't set up" state a real machine without gh would, which is honest
  // and is a screen worth showing anyway.
  // The panel used to answer available:false here, so the feature the landing
  // page calls out as new was dead in the demo that page links to.
  prCapability: (_force?: boolean) => D(demo.prCapability()),
  prApplySuggestion: () => D(demoPrAction()),
  prFileSlice: () => D({ ok: false, error: "not available in the demo" } as { ok: boolean; lines?: string[]; start?: number; total?: number; binary?: boolean; url?: string; error?: string }),
  prFacets: () => D({ ok: false, error: "not available in the demo" } as { ok: boolean; data?: { authors: string[]; assignees: string[]; labels: { name: string; color: string }[]; milestones: string[]; bases: string[] }; error?: string }),
  prList: (root: string, filter: "mine" | "review" | "all", _state?: "open" | "closed" | "all", _force?: boolean, _after?: string, _q?: string) => D<PrListResponse>(demo.prList(root, filter)),
  prMentions: () => D({ ok: false, error: "not available in the demo" } as { ok: boolean; data?: { users: string[]; issues: { number: number; title: string }[] }; error?: string }),
  prLineComment: () => D(demoPrAction()),
  prJobLog: () => D({ ok: false, error: "not available in the demo" }),
  prCheckJobs: () => D({ ok: false, error: "not available in the demo" } as { ok: boolean; jobs?: PrCheckJob[]; error?: string }),
  prRerunJobs: () => D(demoPrAction()),
  prCounts: (_r: string, _s: "open" | "closed" | "all") => D({ ok: false, error: "not available in the demo" } as { ok: boolean; counts?: { review: number; mine: number; failing: number; ready: number; all: number }; error?: string }),
  prDetail: (_root: string, number: number, _force?: boolean) => D(demo.prDetail(number)),
  prDiff: (_root: string, number: number) => D(demo.prDiff(number)),
  prAssetUrl: (raw: string) => raw,
  prFileTemp: (_r: string, _n: number, _p: string) => D({ ok: false as const, error: "not available in the demo" }),
  prReview: (_r: string, _n: number, _v: "approve" | "request_changes" | "comment", _b: string) => D(demoPrAction()),
  prReviewWith: (_r: string, _n: number, _v: "approve" | "request_changes" | "comment", _b: string, _c: unknown[]) => D(demoPrAction()),
  prComment: (_r: string, _n: number, _b: string) => D(demoPrAction()),
  prReply: (_r: string, _n: number, _c: number, _b: string) => D(demoPrAction()),
  prSetThreadResolved: (_r: string, _t: string, _v: boolean) => D(demoPrAction()),
  prReact: (_r: string, _c: number, _content?: string) => D(demoPrAction()),
  prReactTo: (_r: string, _id: string, _c: string, _on: boolean) => D(demoPrAction()),
  prEditComment: (_r: string, _id: string, _b: string, _k?: "issue" | "review") => D(demoPrAction()),
  prDeleteComment: (_r: string, _id: string, _k?: "issue" | "review") => D(demoPrAction()),
  prFileViewed: (_r: string, _p: string, _path: string, _v: boolean) => D(demoPrAction()),
  prAssignees: (_r: string, _n: number, _a: string[], _rm: string[]) => D(demoPrAction()),
  prMilestone: (_r: string, _n: number, _t: string) => D(demoPrAction()),
  prEdit: (_r: string, _n: number, _p: { title?: string; body?: string; base?: string }) => D(demoPrAction()),
  prLabels: (_r: string, _n: number, _a: string[], _rm: string[]) => D(demoPrAction()),
  prReviewers: (_r: string, _n: number, _a: string[], _rm: string[]) => D(demoPrAction()),
  prDraft: (_r: string, _n: number, _d: boolean) => D(demoPrAction()),
  prUpdateBranch: (_r: string, _n: number, _s?: boolean) => D(demoPrAction()),
  prRerun: (_r: string, _n: number) => D(demoPrAction()),
  prMerge: (_r: string, _n: number, _m: "squash" | "merge" | "rebase", _o: { deleteBranch?: boolean; auto?: boolean; headSha?: string; subject?: string; body?: string; disableAuto?: boolean }) => D(demoPrAction()),
  prClose: (_r: string, _n: number, _reopen?: boolean) => D(demoPrAction()),
  prReviewPrompt: (_r: string, _n: number) => D({ ok: false, error: "not available in the demo" }),
  prPendingReview: (_r: string, _n: number) => D({ ok: true, id: null, comments: [] }),
  clickupComment: (_i: string, _t: string, _a?: number) => D({ ok: false, error: "not available in the demo" }),
  notifyReach: () => D({ ok: true, slack: false }),
  prCommitDiff: (_r: string, _s: string) => D({ ok: false, error: "not available in the demo" }),
  prBranchUrl: (_r: string, _b: string, _g: boolean) => D({ ok: false, error: "not available in the demo" }),
  // The demo has no machine to report on and no checkout to browse: it is a
  // fabricated dataset in a browser tab. Empty and honest beats invented — a
  // fake port list would be the one screen in the tour that lies.
  tasksList: (_f?: boolean) => D({ ok: true, tasks: [], capability: { available: false, configured: false, reason: "not available in the demo" } }),
  taskAdd: (_i: string, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskDone: (_u: string, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskReopen: (_u: string, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskDelete: (_u: string, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskPriority: (_u: string, _c: "H" | "M" | "L" | null, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskEdit: (_u: string, _i: string, _p: string[], _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskTags: (_u: string, _t: string[], _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskNote: (_u: string, _o: string, _n: string, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  taskBulk: (_u: string[], _a: string, _v: string | null, _f?: string) => D({ ok: false, error: "not available in the demo" }),
  providers: () => D({ providers: [] }),
  ghRateLimit: () => D({ ok: false, error: "not available in the demo" }),
  privacy: () => D({ db: "", config: "", credentials: "", retentionDays: 0, pairedDevices: 0 }),
  providerConnect: (_i: string, _t: string) => D({ ok: false, error: "not available in the demo" }),
  providerDisconnect: (_i: string) => D({ ok: false, error: "not available in the demo" }),
  providerWorkspaces: (_i: string) => D({ ok: false, error: "not available in the demo" }),
  providerWorkspace: (_i: string, _w: string, _n: string) => D({ ok: false, error: "not available in the demo" }),
  providerTasks: (_f?: boolean) => D({ tasks: [], more: false, at: 0 }),
  recipes: (_r?: string) => D({ recipes: [] }),
  recipeSave: (_r: Recipe) => D({ ok: false, error: "not available in the demo" }),
  recipeRemove: (_i: string) => D({ ok: true }),
  recipeRender: (_i: string, _v: Record<string, string>) => D({ ok: false, error: "not available in the demo" }),
  // `connected: false` — the demo has no token, and every chip that gates on
  // this stays off rather than leading somewhere that does not exist.
  clickupViews: () => D({ views: [], connected: false, writeEnabled: false }),
  clickupSetWrites: (_o: boolean) => D({ ok: false }),
  clickupView: (_i?: string, _f?: boolean) => D({ tasks: [], statuses: [], fields: [], at: 0 }),
  clickupAddView: (_u: string) => D({ ok: false, error: "not available in the demo" }),
  clickupRemoveView: (_i: string) => D({ ok: true }),
  clickupList: (_i: string) => D({ ok: false, error: "not available in the demo" }),
  clickupReplaceView: (_i: string, _u: string) => D({ ok: false, error: "not available in the demo" }),
  clickupPrs: (_c: string, _f: string, _r: string) => D({ ok: true, prs: [] }),
  clickupFind: (_q: string) => D({ ok: false, error: "not available in the demo" }),
  // The one pull request in the demo that is behind its base is #461, and it
  // said so with no number and nothing about this machine — which is exactly
  // the pair of blanks the Update button used to leave everywhere. The demo
  // shows the whole offer: how far behind, and that the local branch comes
  // along. Everything else keeps the old "no answer, no promises" shape.
  prsForBranch: (_r: string, _b: string) => D({ ok: true, into: [] as PrSummary[] }),
  /* The demo has no checkout, so the local half is simply absent — the panel
     then makes no promises about here, which is its oldest behaviour. */
  prLocalHead: (_r: string, branch: string) => D({
    ok: true,
    local: { branch, exists: false, ahead: 0, behind: 0, dirty: false, sync: "absent" as const },
  }),
  prRollup: (_r: string, _n: number) => D({ ok: false, error: "not available in the demo" }),
  prBehind: (_r: string, n: number) => D(n === 461
    ? {
      ok: true, behind: 12, ahead: 3,
      local: {
        branch: "chore/drop-coupons-v1", exists: true, ahead: 0, behind: 12,
        dirty: false, sync: "ff" as const,
      },
    }
    : { ok: false }),
  prConflict: (_r: string, _n: number) => D({ ok: false, error: "not available in the demo" }),
  prConflictFiles: (_r: string, _n: number) => D({ ok: false, conflicts: [] as string[], clean: false, error: "not available in the demo" }),
  clickupWhere: (_i: string) => D({ ok: false }),
  clickupTask: (_i: string) => D({ ok: false, error: "not available in the demo" }),
  clickupAssign: (_i: string, _o: boolean, _u?: number, _w?: number) => D({ ok: false, error: "not available in the demo" }),
  clickupMembers: (_l: string) => D({ ok: false, error: "not available in the demo" }),
  clickupStatus: (_i: string, _s: string, _u?: number) => D({ ok: false, error: "not available in the demo" }),
  clickupCard: (_i: string, _c: { add?: number[]; rem?: number[]; status?: string }, _u?: number) => D({ ok: false, error: "not available in the demo" }),
  clickupField: (_i: string, _f: string, _v: string) => D({ ok: false, error: "not available in the demo" }),
  reminders: (_w?: "live" | "upcoming" | "history") => D({ ok: true, reminders: [] }),
  remind: (_b: { taskUuid?: string | null; title: string; civil: string; zone?: string; root?: string | null }) => D({ ok: false, error: "not available in the demo" }),
  reminderAck: (_i: string) => D({ ok: false }),
  reminderCancel: (_i: string) => D({ ok: false }),
  reminderSnooze: (_i: string, _m: number) => D({ ok: false }),
  issuesList: (_r: string, s = "open", q = "", a = "") => D(demo.issues(s, q, a)),
  issueDetail: (_r: string, n: number) => D(demo.issueDetail(n)),
  // No linked pull requests in the demo: the fixtures have no GitHub graph
  // behind them, and an invented link is a link somebody would click.
  issuePrs: (_r: string, _n: number) => D({ ok: true, prs: [] }),
  termAgentTicket: (_c: string, _p: string, _y: boolean, _t: string) =>
    D({ ok: false, error: "not available in the demo" }),
  tmuxStatus: () => D({ ok: false, bin: { available: false, source: "none", path: "", version: null, reason: "demo" }, capability: { available: false, reason: "demo" }, confMode: "append", override: "", overrideActive: false, broken: false, brokenReason: "", restoreEnabled: false, resumeMode: "lazy", prefix: "", terminal: "engine", source: "auto", lastCaptureAt: null }),
  tmuxConfSave: (_m: string, _o: string) => D({ ok: false, error: "not available in the demo" }),
  tmuxSettingsSave: (_f: object) => D({ ok: false, error: "not available in the demo" }),
  tmuxReset: () => D({ ok: false, error: "not available in the demo" }),
  tmuxRestoreAction: (_a: string, _m?: string) => D({ ok: false, error: "not available in the demo" }),
  tmuxWindows: (_s: string) => D({ ok: false, windows: [] }),
  tmuxWindowOp: (_o: string, _b: object) => D({ ok: false, error: "not available in the demo" }),
  issuesWork: (_repo?: string) => D(demo.issuesWork()),
  issueStart: (_r: string, _n: number, _m: StartMode) => D({ ok: false, error: "not available in the demo" }),
  issueFinish: (_r: string, _n: number, _f?: boolean) => D({ ok: false, error: "not available in the demo" }),
  issueClaim: (_r: string, _n: number, _c?: string) => D({ ok: false, error: "not available in the demo" }),
  issueComment: (_r: string, _n: number, _b: string) => D({ ok: false, error: "not available in the demo" }),
  issueState: (_r: string, _n: number, _c: boolean) => D({ ok: false, error: "not available in the demo" }),
  // Fabricated, like the rest of the demo: a fictional dev machine with the
  // Acme Shop services listening and a plausible load. Clearly a showcase, not
  // this machine — the demo ships to GitHub Pages with no server behind it.
  machinePorts: () => D(demo.machinePorts()),
  machineResources: (l = 40) => D(demo.machineResources(l)),
  machineSpace: (r: string) => D(demo.machineSpace(r)),
  machineKill: (_p: number) => D({ ok: false, error: "not available in the demo" }),
  machineLocks: () => D({ locks: [], scanned: 0, error: "not available in the demo" }),
  machineProcess: (pid: number) => D({ pid, comm: "", cmd: "", cwd: null, ageSec: null, ancestry: [], env: [], error: "not available in the demo" }),
  machineEnv: (_p: number, _k: string) => D({ ok: false, error: "not available in the demo" }),
  machineUnlock: (_p: string) => D({ ok: false, error: "not available in the demo" }),
  filesTree: (_r: string, rel = "") => D(demo.filesTree(rel)),
  filesRead: (_r: string, rel: string, _ref?: string) => D(demo.filesRead(rel)),
  /* No git and no disk here, so there is nothing to write a ref's copy out of.
     Said rather than answered with a path that does not exist: the caller opens
     an editor on whatever comes back. */
  filesTemp: (_r: string, _rel: string, _ref: string) =>
    D({ ok: false as const, error: "the demo has no checkout to read a branch from" }),
  filesFind: (_r: string, q: string) => D(demo.filesFind(q)),
  filesExist: (_r: string, rels: string[]) => D({ ok: true, here: rels }),
  filesRefs: (_r: string) => D({ ok: true, local: ["main", "feat/checkout-rewrite"], remote: ["origin/main", "origin/release"], head: "main" }),
  filesGrep: (_r: string, _q: string) => D({ ok: false, hits: [], files: 0, truncated: false, via: "", error: "not available in the demo" }),
};

export const api = IS_DEMO ? demoApi : realApi;

/*
 * Two interfaces stood here and both are gone, for unrelated reasons.
 *
 * `PushDevice` described a Web Push subscription. That whole path was removed
 * — a service worker needs a secure context the phone never had — so there is
 * no device list left to type.
 *
 * `UsageWindow`/`UsageScopedWindow`/`UsagePayload` were not deleted but MOVED
 * and renamed: they are `QuotaWindow` and `ProviderUsage` in shared/types.ts
 * now, because the server and the panel both need them and a type the web
 * owned alone could not be shared. See the note there, which keeps the old
 * name reserved so a future `UsageWindow` cannot silently collide.
 */
