import type { ServerWebSocket } from "bun";
import type { IngestBody, WsFrame } from "../../shared/types.ts";
import { normalize, detectError } from "./ingest.ts";
import { db } from "./db.ts";
import {
  insertEvent,
  getRecent,
  openToolCalls,
  getFilterOptions,
  getSessions,
  statsSummary,
  exportRows,
  pruneOldRows,
  RETENTION_DAYS,
  getChanges,
  getSession,
  searchEvents,
  ftsText,
  providerOf,
} from "./db.ts";
import { maybeAlert } from "./alerts.ts";
import { getSkills, catalogMarkdown, catalogCsv } from "./skills.ts";
import { getInsights } from "./insights.ts";
import { getUsage } from "./usage.ts";
import { submitGate, decideGate, pendingGates, GATE_MAX_MS } from "./gate.ts";
import { otlpTracesToEvents, otlpLogsToEvents } from "./otlp.ts";
import { decodeOtlpTraces, decodeOtlpLogs } from "./otlp_pb.ts";
import { statusForPaths, commit as gitCommit, COMMIT_ENABLED } from "./git.ts";
import {
  workingTree, discoverRepos, stage, unstage, stageAll, unstageAll, discard,
  commitStaged, push as gitPush, pull as gitPull, fetch as gitFetch,
  branches as gitBranches, checkout as gitCheckout, createBranch, deleteBranch,
  log as gitLog, commitDiff, stashList, stashPush, stashApply, stashPop, stashDrop,
  applyHunk, logGraph, mergeBranch, rebaseBranch, renameBranch, resetTo,
  worktrees as gitWorktrees, addWorktree, removeWorktree, startAutoFetch,
  remotes as gitRemotes, tags as gitTags, reflog as gitReflog,
} from "./gitwork.ts";
import { recent as gitCommandLog } from "./gitlog.ts";
import { openInEditor, editorTarget, editorCapability, HAS_NVIM } from "./editor.ts";
import { syncTheme, snippetStatus, SNIPPETS } from "./themesync.ts";
import { completePath, FS_BROWSE_ENABLED } from "./fsbrowse.ts";
import {
  overview as dockerOverview, stats as dockerStats, logs as dockerLogs,
  startContainer, stopContainer, restartContainer, removeContainer,
} from "./docker.ts";
import { generateWalkthrough, WALKTHROUGH_ENABLED } from "./walkthrough.ts";
import { ptyOpen, ptyMessage, ptyClose, projectCommands, shutdownTerminals, TERMINAL_ENABLED, type PtyWsData } from "./terminal.ts";
import { chatStream, CHAT_ENABLED, CHAT_BYPASS_ALLOWED } from "./chat.ts";
import { startScanner, ownsSession, knownProjects, resyncScope, SCAN_ENABLED } from "./transcripts.ts";
import { workspaceRoot, setWorkspaceRoot, inScope, CONFIG_PATH } from "./config.ts";
import { privateHost } from "./net.ts";
import { resolveToken, tokenOk, isIntake, isAuthExempt } from "./auth.ts";
import { rateOk } from "./ratelimit.ts";
import { parseWindowMs } from "./params.ts";
import { serveWeb, serveIndex, WEB_UI_ENABLED } from "./webui.ts";
import { notifyCapability, subscribeNotifications, notifyWatching, openNote } from "./notifications.ts";

const PORT = Number(process.env.AGENTGLASS_PORT || 4000);
/** When this process came up. /stats ships it so the dashboard's uptime is
 *  the server's, not the age of the oldest event in the database. */
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
/**
 * Loopback unless told otherwise.
 *
 * This server hands out a shell, git write access and docker control, with no
 * authentication of any kind — binding every interface put all of that in
 * reach of anyone sharing a café or office network. Exposing it is now a
 * deliberate act: set AGENTGLASS_BIND=0.0.0.0 (and understand what that means).
 */
const BIND = process.env.AGENTGLASS_BIND || "127.0.0.1";
const LOOPBACK_ONLY = BIND === "127.0.0.1" || BIND === "::1" || BIND === "localhost";
// RFC1918 addresses are trusted as origins/hosts only when this is set. Off by
// default: a shell-granting server should trust loopback alone unless exposing
// it to a LAN is a deliberate choice (paired with a token — see below).
const TRUST_LAN = process.env.AGENTGLASS_TRUST_LAN === "1";
// Optional shared-secret auth. Null on a loopback-only box with no token set
// (unchanged zero-config UX); required otherwise. Exposing without a token
// mints and prints one rather than running unauthenticated.
const AUTH = resolveToken(LOOPBACK_ONLY);
const AUTH_TOKEN = AUTH.token;
/** One socket, three roles: the live event stream, PTY terminal shells, and
 *  the desktop-notification mirror. */
type WsData = { kind: "events" } | { kind: "notify" } | PtyWsData;
const clients = new Set<ServerWebSocket<WsData>>();
/** Notification sockets, each holding the unsubscribe that keeps the D-Bus
 *  monitor alive. Empty map => no monitor process. */
const notifySubs = new Map<ServerWebSocket<WsData>, () => void>();

// Reflect the caller's Origin instead of a blanket `*`. Foreign origins are
// already turned away by localOrigin() before any body is served, so the old
// wildcard leaked nothing — but reflecting is honest, pairs with `Vary: Origin`,
// and permits the Authorization header the token flow now sends.
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
  };
}

/**
 * Is this request's Origin a machine we're willing to be driven by?
 *
 * The host is parsed as an IP address rather than pattern-matched. Matching the
 * hostname string against `/^10\./` also matches `10.evil.com` — a domain
 * anyone can register and point at 127.0.0.1, turning "private network" into
 * "any website", with a shell on the other end. A name is only ever accepted
 * when it is literally localhost; everything else has to *be* an address in a
 * private range, not merely look like one.
 */
const isPrivate = (h: string): boolean => privateHost(h, TRUST_LAN);

// Block drive-by cross-site writes: a request carrying an Origin from a real
// website is rejected. A request with NO Origin is not a browser, so it can't
// be a drive-by — but it also can't be vouched for, which is why the routes
// that hand out real capability check ORIGIN_REQUIRED instead.
/**
 * The desktop shell serves its renderer from its own scheme, not a loopback
 * port — a port is assigned fresh on every launch, and localStorage is keyed
 * by origin, so the app used to lose every preference each time it started.
 *
 * Trusting this origin is no weaker than trusting 127.0.0.1: nothing on the
 * web can be served under a scheme that only exists inside the packaged app,
 * and a page cannot forge an Origin header. Both origin gates below defer to
 * it, so the two can never drift apart — which they did once already, and the
 * app came up unable to reach its own API.
 */
const DESKTOP_ORIGIN_SCHEME = "agentglass:";
function fromDesktopShell(origin: string): boolean {
  try { return new URL(origin).protocol === DESKTOP_ORIGIN_SCHEME; } catch { return false; }
}

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  if (fromDesktopShell(o)) return true;
  try {
    return isPrivate(new URL(o).hostname);
  } catch { return false; }
}

/**
 * A stricter gate for the routes that grant execution: a shell, an agent, or
 * anything that can change the machine.
 *
 * Here a missing Origin is refused rather than trusted. Nothing but a browser
 * omits it, and every browser client of this server is same-origin, so the only
 * callers it turns away are the non-browser ones — which is exactly the
 * `websocat ws://host:4000/terminal/pty` case that otherwise hands a login
 * shell to anyone who can reach the port.
 */
function trustedCaller(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return LOOPBACK_ONLY; // no origin is only safe when nobody remote can connect
  if (fromDesktopShell(o)) return true;
  try {
    return isPrivate(new URL(o).hostname);
  } catch { return false; }
}

/**
 * DNS-rebinding guard: the Host header must name an address that is plausibly
 * this machine.
 *
 * The Origin gate above can't see one attack: a site the user visits points
 * its *own* domain's DNS at 127.0.0.1, and from then on the browser talks to
 * this server as if it were that site — same-origin, so plain GETs carry no
 * Origin header at all and would sail through as "non-browser callers". What
 * that page CAN'T forge is the Host header, which still names the attacker's
 * domain. Refusing any Host that isn't localhost or a private address closes
 * the door; a reverse-proxy name can be allowed explicitly.
 */
const ALLOWED_HOSTS = new Set(
  (process.env.AGENTGLASS_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);
const trustedHost = (url: URL) => isPrivate(url.hostname) || ALLOWED_HOSTS.has(url.hostname.toLowerCase());

function broadcast(frame: WsFrame) {
  const msg = JSON.stringify(frame);
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      clients.delete(ws);
    }
  }
}

/** Normalize → persist → broadcast → alert. Shared by /ingest and /v1/traces. */
function ingestBody(body: IngestBody) {
  const n = normalize(body);
  const { event, session } = insertEvent(n);
  broadcast({ type: "event", data: event });
  broadcast({ type: "session", data: session });
  maybeAlert(event);
  return event;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: BIND,
  // A frame is a control message or a keystroke; nothing legitimate is large.
  // Unset, Bun allows 16MB per frame, which is a cheap way to exhaust memory.
  maxRequestBodySize: 32 * 1024 * 1024,
  // Bun closes a connection that has been quiet for `idleTimeout` seconds, and
  // the default is 10 — which counts the gaps *inside* a streaming response, not
  // just an idle socket. A chat turn is silent for as long as the model thinks
  // or a tool runs, so the default cut `/chat/send` off mid-turn and the browser
  // reported only a generic fetch failure. 255 is the maximum Bun accepts; it is
  // still not long enough on its own for a slow turn, so `chat.ts` also sends a
  // periodic keepalive to keep the gaps under it.
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Per-request response helpers: `cors` reflects this caller's Origin, so it
    // has to be built here rather than shared as a module constant.
    const cors = corsFor(req);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors } });
    const csrfBlocked = () => json({ ok: false, error: "cross-origin write blocked" }, 403);
    const rebindBlocked = () =>
      json({ ok: false, error: "request Host is not a local or private address (DNS-rebinding guard — set AGENTGLASS_ALLOWED_HOSTS for a reverse-proxy name)" }, 403);

    // Before anything else — including OPTIONS and WS upgrades: a request that
    // arrived under a foreign Host is a rebinding attempt, whatever it asks.
    if (!trustedHost(url)) return rebindBlocked();

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // One gate for the whole surface — reads included. Without it, CORS let any
    // site the user visited read /export, /search and the rest from loopback. A
    // missing Origin is a non-browser caller (curl, the hooks), not a drive-by,
    // so it's allowed; a foreign website is turned away here.
    if (!localOrigin(req)) return csrfBlocked();

    // --- built web UI (single-port mode) ---
    // Exact files only, GET/HEAD only, and ahead of the token gate: the bundle
    // is the same public code that ships in the repo, and the ?token= flow
    // needs index.html and its assets to load before the app can pick the
    // token up and attach it — every data route below stays gated. API paths
    // never collide here: none of them maps to a real file under web/dist, so
    // for them this falls straight through to the routes.
    if (req.method === "GET" || req.method === "HEAD") {
      const asset = serveWeb(pathname, cors);
      if (asset) return asset;
    }

    // Shared-secret gate. When a token is configured, every route but the
    // append-only intake sinks needs it — this is what closes the door on other
    // local processes and makes a non-loopback bind safe. WS upgrades carry it
    // as ?token= (a browser can't set a header on them); fetch uses Bearer.
    // /gate is NOT exempt here: it's the control plane, and its hook carries the
    // token when one is set (see auth.ts / gate_event.py).
    if (AUTH_TOKEN && !isAuthExempt(pathname) && !tokenOk(req, url, AUTH_TOKEN)) {
      return json({ ok: false, error: "unauthorized — pass ?token= or Authorization: Bearer" }, 401);
    }

    // Throttle the unauthenticated intake sinks so a runaway client can't flood
    // the DB and the broadcast fan-out. Keyed by source address + route.
    if (req.method === "POST" && isIntake(pathname)) {
      const ip = srv.requestIP(req)?.address || "local";
      if (!rateOk(`${ip} ${pathname}`)) return json({ ok: false, error: "rate limited" }, 429);
    }

    // --- WebSocket upgrade ---
    // Origin-checked like the mutating routes. WebSockets are exempt from CORS,
    // so without this any page in the user's browser could open a socket to
    // localhost and read the whole fleet's prompts, paths and errors as they
    // stream — a read this feed is not meant to give to the open web.
    if (pathname === "/stream") {
      if (!trustedCaller(req)) return csrfBlocked();
      if (srv.upgrade(req, { data: { kind: "events" } })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- in-browser terminal: a real PTY shell over a WebSocket ---
    if (pathname === "/terminal/pty") {
      if (!trustedCaller(req)) return csrfBlocked();
      if (!TERMINAL_ENABLED) return json({ error: "terminal is disabled (AGENTGLASS_TERMINAL_DISABLED=1)" }, 403);
      const data: PtyWsData = {
        kind: "pty",
        root: url.searchParams.get("root") || "",
        cols: Number(url.searchParams.get("cols") || 80),
        rows: Number(url.searchParams.get("rows") || 24),
      };
      if (srv.upgrade(req, { data })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- desktop notifications mirrored onto the notch ---
    //
    // The monitor runs only while a socket is open here, and the UI only opens
    // one when the user has switched the feature on. Off means nothing is
    // spawned and nothing is read — not "read it and don't show it".
    if (pathname === "/notifications/capability") return json(notifyCapability());
    if (pathname === "/notifications/open" && req.method === "POST") {
      if (!trustedCaller(req)) return csrfBlocked();
      let body: { id?: unknown };
      try { body = (await req.json()) as { id?: unknown }; } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const r = openNote(body?.id);
      return json(r, r.ok ? 200 : 404);
    }
    if (pathname === "/notifications") {
      if (!trustedCaller(req)) return csrfBlocked();
      const cap = notifyCapability();
      if (!cap.supported) return json({ error: cap.reason ?? "unsupported" }, 501);
      if (srv.upgrade(req, { data: { kind: "notify" } })) return undefined as unknown as Response;
      return new Response("upgrade failed", { status: 426 });
    }

    // --- health ---
    if (pathname === "/health") return json({ ok: true, clients: clients.size, notifyWatching: notifyWatching() });

    // --- ingest ---
    if (pathname === "/ingest" && req.method === "POST") {
      let body: IngestBody;
      try {
        body = (await req.json()) as IngestBody;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body?.source_app || !body?.session_id || !body?.hook_event_type) {
        return json({ error: "source_app, session_id, hook_event_type required" }, 400);
      }
      // A Claude Code session with a transcript on disk is already covered by
      // the scanner, which reads the same turns in richer form. Taking the hook
      // copy too would count every tool call and every token twice.
      if (ownsSession(body.session_id)) return json({ ok: true, skipped: "scanner owns this session" });
      const event = ingestBody(body);
      return json({ ok: true, id: event.id });
    }

    // --- OpenTelemetry OTLP/HTTP (JSON) trace receiver ---
    // Maps GenAI (`gen_ai.*`) spans → events, so ANY OTel-instrumented provider
    // feeds the dashboard. OTel HTTP exporters POST the traces signal here.
    if ((pathname === "/v1/traces" || pathname === "/otlp/v1/traces") && req.method === "POST") {
      // Accept both OTLP/HTTP encodings: JSON and protobuf (the SDK default). No
      // Collector needed — point any exporter's http endpoint straight here.
      const ct = req.headers.get("content-type") || "";
      let body: unknown;
      try {
        body = ct.includes("protobuf") ? decodeOtlpTraces(await req.arrayBuffer()) : await req.json();
      } catch {
        return json({ error: "could not parse OTLP body (send application/json or application/x-protobuf)" }, 400);
      }
      let accepted = 0;
      let rejected = 0;
      for (const b of otlpTracesToEvents(body)) {
        if (!b.source_app || !b.session_id || !b.hook_event_type) { rejected++; continue; }
        ingestBody(b);
        accepted++;
      }
      // OTLP ExportTraceServiceResponse: empty {} = full success.
      return json(rejected ? { partialSuccess: { rejectedSpans: rejected, errorMessage: "spans without gen_ai.* were ignored" } } : {});
    }

    // --- OTLP/HTTP (JSON or protobuf) LOG receiver ---
    // For agents that export OpenTelemetry *logs* instead of traces (OpenAI
    // Codex CLI). Each GenAI-ish log record → an event.
    if ((pathname === "/v1/logs" || pathname === "/otlp/v1/logs") && req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      let body: unknown;
      try {
        body = ct.includes("protobuf") ? decodeOtlpLogs(await req.arrayBuffer()) : await req.json();
      } catch {
        return json({ error: "could not parse OTLP body (send application/json or application/x-protobuf)" }, 400);
      }
      for (const b of otlpLogsToEvents(body)) {
        if (b.source_app && b.session_id && b.hook_event_type) ingestBody(b);
      }
      return json({}); // ExportLogsServiceResponse: {} = success
    }

    // --- reads ---
    if (pathname === "/events/recent") {
      const limit = Math.min(2000, Number(url.searchParams.get("limit") || 300));
      return json(getRecent(limit, url.searchParams.get("provider") || undefined));
    }
    if (pathname === "/events/filter-options") return json(getFilterOptions());
    // Every project the scanner has seen, with the real folder it lives in —
    // this is what the folder filter lists.
    if (pathname === "/projects") {
      // Scoped instance → scoped project list. The DB may hold other projects
      // from an earlier machine-wide run; they're not this cockpit's business.
      // inScope rather than a prefix test, so a cockpit opened *on* a linked
      // worktree still lists the project its sessions roll up to.
      const ws = workspaceRoot();
      const projects = knownProjects().filter((p) => inScope(p.path, ws));
      return json({ projects, scanning: SCAN_ENABLED, workspace: ws });
    }
    // Pick the project this cockpit is about (or null → the whole machine).
    // Applied live and persisted for the next launch.
    if (pathname === "/workspace" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = setWorkspaceRoot(b.root == null ? null : String(b.root));
      // Catch the scanner up under the new scope BEFORE answering — silently,
      // so widening doesn't replay months of backfill as live events. The
      // client reloads on this response; answering earlier would show it a
      // dashboard the backfill hasn't reached yet.
      if (res.ok) await resyncScope();
      return json(res, res.ok ? 200 : 400);
    }
    if (pathname === "/insights") return json({ insights: getInsights() });
    if (pathname === "/usage") return json(await getUsage()); // Anthropic plan-limit windows (only meaningful for Claude)

    // --- control plane: gate ---
    if (pathname === "/gate" && req.method === "POST") {
      let b: any = {};
      try { b = await req.json(); } catch { return json({ decision: "allow", reason: "bad request" }); }
      const ti = b.tool_input ?? {};
      const summary = String(ti.command || ti.file_path || ti.path || ti.pattern || ti.query || ti.description || b.tool_name || "").slice(0, 300);
      const decision = await submitGate(
        { source_app: String(b.source_app || "unknown"), session_id: String(b.session_id || "unknown"), tool_name: String(b.tool_name || "?"), summary },
        Math.min(GATE_MAX_MS, Number(b.timeout_ms) || 60_000)
      );
      return json(decision);
    }
    if (pathname === "/gate/pending") return json({ gates: pendingGates() });
    if (pathname === "/gate/decide" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false }); }
      const ok = decideGate(String(b.id), b.decision === "deny" ? "deny" : "allow", String(b.reason || ""));
      return json({ ok });
    }
    if (pathname === "/search") {
      const q = url.searchParams.get("q") || "";
      const limit = Math.min(200, Number(url.searchParams.get("limit") || 60));
      return json({ hits: q.trim() ? searchEvents(q, limit) : [] });
    }
    if (pathname === "/changes") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));
      return json({ changes: getChanges(limit) });
    }

    // --- commit composer: live git working-tree status + commit ---
    if (pathname === "/git/status" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string").slice(0, 500) : [];
      return json({ repos: statusForPaths(paths), commitEnabled: COMMIT_ENABLED });
    }
    if (pathname === "/git/commit" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const res = gitCommit(String(b.root || ""), Array.isArray(b.files) ? b.files : [], String(b.title || ""), String(b.body || ""));
      return json(res, res.ok ? 200 : 400);
    }

    // --- live git panel (lazygit-style working tree) ---
    if (pathname === "/git/repos") {
      const paths = getChanges(300).map((c) => c.file_path);
      // `all=1` is the project picker: it needs the whole machine even when the
      // cockpit is currently scoped to one project, or there'd be no way out.
      const ignoreScope = url.searchParams.get("all") === "1";
      return json({ repos: await discoverRepos(paths, knownProjects().map((p) => p.path), { ignoreScope }) });
    }
    // Directory completion for the project picker's free-text path input. A
    // plain read, so the surface-wide origin/rebinding/token gate above is the
    // whole authorisation story — same as /git/repos. See fsbrowse.ts for why
    // it isn't confined to the configured repoDirs.
    if (pathname === "/fs/complete") {
      // Its own switch, not the terminal's: an operator who disabled the shell
      // gave up filesystem reach on purpose, and this must not hand it back.
      if (!FS_BROWSE_ENABLED) return json({ error: "directory browsing is disabled (AGENTGLASS_FS_BROWSE_DISABLED=1)" }, 403);
      return json(completePath(url.searchParams.get("prefix") || ""));
    }
    if (pathname === "/git/tree") {
      const root = url.searchParams.get("root") || "";
      return json(workingTree(root));
    }
    if (pathname === "/git/branches") return json(gitBranches(url.searchParams.get("root") || ""));
    if (pathname === "/git/graph") return json(logGraph(url.searchParams.get("root") || "", Number(url.searchParams.get("limit") || 400)));
    if (pathname === "/git/worktrees") return json({ worktrees: gitWorktrees(url.searchParams.get("root") || "") });
    if (pathname === "/git/log") return json({ commits: gitLog(url.searchParams.get("root") || "", Number(url.searchParams.get("limit") || 100)) });
    if (pathname === "/git/commit-diff") return json({ changes: commitDiff(url.searchParams.get("root") || "", url.searchParams.get("hash") || "") });
    if (pathname === "/git/stashes") return json({ stashes: stashList(url.searchParams.get("root") || "") });
    // Every git command this server has run — the command log panel.
    if (pathname === "/git/commandlog") return json({ entries: gitCommandLog(Number(url.searchParams.get("since") || 0)) });
    // Open a file at a line in the editor the user already has running.
    if (pathname === "/editor/target") return json({ ...(await editorTarget(url.searchParams.get("path") || "")), hasNvim: HAS_NVIM });
    if (pathname === "/git/remotes") return json({ remotes: gitRemotes(url.searchParams.get("root") || "") });
    if (pathname === "/git/tags") return json({ tags: gitTags(url.searchParams.get("root") || "") });
    if (pathname === "/git/reflog") return json({ entries: gitReflog(url.searchParams.get("root") || "", Number(url.searchParams.get("limit") || 200)) });
    // Carry the cockpit's palette out to tmux and nvim — see themesync.ts.
    if (pathname === "/editor/capability") return json(editorCapability());
    if (pathname === "/theme/status") return json({ ...snippetStatus(), snippets: SNIPPETS });
    if (pathname === "/theme/sync" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await syncTheme(b.vars ?? {}, String(b.name ?? "custom")));
    }

    if (pathname === "/editor/open" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      return json(await openInEditor(b.path, b.line));
    }

    if (pathname.startsWith("/git/") && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const root = String(b.root || "");
      const paths = Array.isArray(b.paths) ? b.paths : [];
      let res;
      switch (pathname) {
        case "/git/stage": res = stage(root, paths); break;
        case "/git/unstage": res = unstage(root, paths); break;
        case "/git/stage-all": res = stageAll(root); break;
        case "/git/unstage-all": res = unstageAll(root); break;
        case "/git/discard": res = discard(root, paths); break;
        case "/git/commit-staged": res = commitStaged(root, String(b.title || ""), String(b.body || "")); break;
        case "/git/push": res = gitPush(root); break;
        case "/git/pull": res = gitPull(root); break;
        case "/git/fetch": res = gitFetch(root); break;
        case "/git/checkout": res = gitCheckout(root, String(b.name || "")); break;
        case "/git/branch-create": res = createBranch(root, String(b.name || "")); break;
        case "/git/branch-delete": res = deleteBranch(root, String(b.name || ""), !!b.force); break;
        case "/git/stash-push": res = stashPush(root, String(b.message || "")); break;
        case "/git/stash-apply": res = stashApply(root, Number(b.index)); break;
        case "/git/stash-pop": res = stashPop(root, Number(b.index)); break;
        case "/git/stash-drop": res = stashDrop(root, Number(b.index)); break;
        case "/git/apply-hunk": res = applyHunk(root, b.path, !!b.staged, b.action, b.hunk); break;
        case "/git/merge": res = mergeBranch(root, String(b.name || "")); break;
        case "/git/rebase": res = rebaseBranch(root, String(b.name || "")); break;
        case "/git/branch-rename": res = renameBranch(root, String(b.name || ""), String(b.to || "")); break;
        case "/git/reset": res = resetTo(root, String(b.ref || ""), b.mode); break;
        case "/git/worktree-add": res = addWorktree(root, b.path, String(b.branch || ""), !!b.newBranch); break;
        case "/git/worktree-remove": res = removeWorktree(root, b.path, !!b.force); break;
        default: res = null;
      }
      if (res) return json(res, res.ok ? 200 : 400);
    }

    // --- live docker panel (lazydocker-style) ---
    if (pathname === "/docker/overview") return json(await dockerOverview());
    if (pathname === "/docker/stats") return json({ stats: await dockerStats() });
    if (pathname === "/docker/logs") {
      const id = url.searchParams.get("id") || "";
      const tail = Number(url.searchParams.get("tail") || 400);
      return json(dockerLogs(id, tail));
    }
    if (pathname.startsWith("/docker/") && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
      const id = String(b.id || "");
      let res;
      switch (pathname) {
        case "/docker/start": res = startContainer(id); break;
        case "/docker/stop": res = stopContainer(id); break;
        case "/docker/restart": res = restartContainer(id); break;
        case "/docker/rm": res = removeContainer(id); break;
        default: res = null;
      }
      if (res) return json(res, res.ok ? 200 : 400);
    }

    // --- in-browser terminal: ready-to-run project commands (make + scripts) ---
    if (pathname === "/terminal/commands") return json(projectCommands(url.searchParams.get("root") || ""));

    // --- multi-chat: drive claude sessions from the browser ---
    // `bypass` rides along so the mode picker can stop offering a mode the
    // server would silently downgrade — the downgrade itself stays server-side.
    if (pathname === "/chat/enabled") return json({ enabled: CHAT_ENABLED, bypass: CHAT_BYPASS_ALLOWED });
    if (pathname === "/chat/send" && req.method === "POST") {
      if (!localOrigin(req)) return csrfBlocked();
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      return chatStream(b.cwd, b.message, b.model, b.resumeId, b.mode, b.allowedTools, b.images);
    }

    // --- LLM walkthrough: AI-authored review itinerary for the changes ---
    if (pathname === "/walkthrough" && req.method === "POST") {
      let b: any = {};
      try { b = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
      if (!WALKTHROUGH_ENABLED) {
        return json({ available: false, reviewFocus: "", files: [], error: "no local `claude` CLI and no ANTHROPIC_API_KEY — install Claude Code or set a key" });
      }
      try {
        return json(await generateWalkthrough(Array.isArray(b.files) ? b.files : []));
      } catch (e: any) {
        return json({ available: true, reviewFocus: "", files: [], error: String(e?.message || e) });
      }
    }
    if (pathname === "/session") {
      const id = url.searchParams.get("id") || "";
      const detail = id ? getSession(id) : null;
      return detail ? json(detail) : json({ error: "not found" }, 404);
    }
    if (pathname === "/skills") return json({ skills: getSkills(), generated_at: Date.now() });
    if (pathname === "/skills/export") {
      const fmt = url.searchParams.get("format") || "md";
      const dl = (body: string, type: string, name: string) =>
        new Response(body, {
          headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"`, ...cors },
        });
      if (fmt === "json") return dl(JSON.stringify(getSkills(), null, 2), "application/json", "skills-catalog.json");
      if (fmt === "csv") return dl(catalogCsv(), "text/csv", "skills-catalog.csv");
      return dl(catalogMarkdown(), "text/markdown", "skills-catalog.md");
    }
    if (pathname === "/sessions") {
      const limit = Math.min(1000, Number(url.searchParams.get("limit") || 100));
      return json(getSessions(limit, url.searchParams.get("provider") || undefined));
    }
    if (pathname === "/stats") {
      const windowMs = parseWindowMs(url.searchParams.get("window"));
      return json({ ...statsSummary(windowMs, url.searchParams.get("provider") || undefined), server_started_at: STARTED_AT });
    }

    // --- export ---
    if (pathname === "/export") {
      const fmt = url.searchParams.get("format") || "json";
      const rows = exportRows();
      if (fmt === "csv") {
        const cols = [
          "id", "timestamp", "source_app", "session_id", "hook_event_type",
          "tool_name", "model_name", "is_error", "duration_ms",
          "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
          "cost_usd", "error_text",
        ];
        const lines = [cols.join(",")];
        for (const r of rows) lines.push(cols.map((c) => csvEscape((r as any)[c])).join(","));
        return new Response(lines.join("\n"), {
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="agentglass-events.csv"',
            ...cors,
          },
        });
      }
      return new Response(JSON.stringify(rows, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="agentglass-events.json"',
          ...cors,
        },
      });
    }

    // --- SPA fallback ---
    // Every API route above has declined by now. A GET that asks for html is a
    // browser navigating to a UI deep-link (or a bookmark of one) — hand it
    // index.html and let the bundle take it from there. Anything else — curl,
    // fetch, an exporter probing a bad path — still gets the JSON 404.
    if (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html")) {
      const page = serveIndex(cors);
      if (page) return page;
    }

    return json({ error: "not found" }, 404);
  },

  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      if (ws.data?.kind === "pty") { ptyOpen(ws); return; }
      if (ws.data?.kind === "notify") {
        notifySubs.set(ws, subscribeNotifications((n) => {
          try { ws.send(JSON.stringify(n)); } catch { /* closing */ }
        }));
        return;
      }
      clients.add(ws);
      // openTools seeds the client's "running" state for tools whose PreToolUse
      // predates the 300-event initial slice — otherwise a long job in flight
      // when the page loads shows as idle (or missing) until its Post arrives.
      const frame: WsFrame = { type: "initial", data: getRecent(300), openTools: openToolCalls() };
      ws.send(JSON.stringify(frame));
    },
    close(ws: ServerWebSocket<WsData>) {
      if (ws.data?.kind === "pty") { ptyClose(ws); return; }
      if (ws.data?.kind === "notify") {
        // Unsubscribing is what stops the monitor process once the last
        // listener goes, so this must run on every close path.
        notifySubs.get(ws)?.();
        notifySubs.delete(ws);
        return;
      }
      clients.delete(ws);
    },
    message(ws: ServerWebSocket<WsData>, msg) {
      if (ws.data?.kind === "pty") ptyMessage(ws, msg as string | Buffer);
      /* event-stream clients are read-only */
    },
  },
});

// One-shot backfill: earlier builds never detected tool_response errors, so
// historical rows are all is_error=0. Re-evaluate them once (guarded by the
// schema version) so analytics/health reflect real failures immediately.
function backfillErrors() {
  const VER = 2;
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;
  const rows = db
    .query<{ id: number; hook_event_type: string; payload: string }, []>(
      "SELECT id, hook_event_type, payload FROM events WHERE is_error = 0 AND payload LIKE '%tool_response%'"
    )
    .all();
  const upd = db.query("UPDATE events SET is_error = 1, error_text = COALESCE(error_text, $t) WHERE id = $id");
  let fixed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload); } catch { continue; }
      const { is_error, error_text } = detectError(r.hook_event_type, payload);
      if (is_error) { upd.run({ $id: r.id, $t: error_text }); fixed++; }
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (fixed) console.log(`🔧 backfilled ${fixed} error events (of ${rows.length} scanned)`);
}
backfillErrors();

// Populate the full-text index from history once (guarded separately).
function backfillFts() {
  const VER = 3;
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;
  const rows = db.query<{ id: number; source_app: string; session_id: string; hook_event_type: string; tool_name: string | null; error_text: string | null; payload: string }, []>(
    "SELECT id, source_app, session_id, hook_event_type, tool_name, error_text, payload FROM events WHERE id NOT IN (SELECT rowid FROM events_fts)"
  ).all();
  const ins = db.query("INSERT INTO events_fts(rowid, text) VALUES ($id, $text)");
  const tx = db.transaction(() => {
    for (const r of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload); } catch { /* skip */ }
      ins.run({ $id: r.id, $text: ftsText({ ...r, payload }) });
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (rows.length) console.log(`🔎 indexed ${rows.length} events for full-text search`);
}
backfillFts();

// Backfill the sessions.provider column (added for the provider filter) from
// each session's model_name — so the filter works over existing history too.
function backfillProvider() {
  const VER = 4;
  const cur = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (cur >= VER) return;
  const rows = db.query<{ session_id: string; model_name: string | null }, []>(
    "SELECT session_id, model_name FROM sessions WHERE provider IS NULL AND model_name IS NOT NULL"
  ).all();
  const upd = db.query("UPDATE sessions SET provider = $p WHERE session_id = $sid");
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const p = providerOf(r.model_name);
      if (p) { upd.run({ $p: p, $sid: r.session_id }); n++; }
    }
  });
  tx();
  db.exec(`PRAGMA user_version = ${VER}`);
  if (n) console.log(`🏷  tagged ${n} sessions with a provider`);
}
backfillProvider();

// Retention: prune at boot and hourly so the DB stays lean but the 7d window
// always has full history (see AGENTGLASS_RETENTION_DAYS in db.ts).
function prune() {
  const { events, sessions } = pruneOldRows();
  if (events || sessions) {
    console.log(`🧹 pruned ${events} events / ${sessions} sessions older than ${RETENTION_DAYS}d`);
  }
}
prune();
setInterval(prune, 3_600_000);

// Read every Claude Code session on this machine from ~/.claude/projects, then
// keep watching. This is what makes the dashboard cover all projects at once
// instead of only the directory agentglass happens to run from.
startScanner(({ event, session }) => {
  broadcast({ type: "event", data: event });
  broadcast({ type: "session", data: session });
  maybeAlert(event);
});

// Hang up shells and clean temp dirs on the way out — a bare kill leaves them
// orphaned. Re-raise so the default disposition still terminates the process.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { shutdownTerminals(); process.exit(0); });
}

console.log(`🛰  agentglass server on http://${LOOPBACK_ONLY ? "localhost" : BIND}:${server.port}`);
if (!LOOPBACK_ONLY) {
  const posture = AUTH_TOKEN ? "token-protected" : "UNAUTHENTICATED";
  console.warn(`⚠  bound to ${BIND} — this exposes a shell, git write access and docker control to the network (${posture})`);
  if (!TRUST_LAN) console.warn(`⚠  AGENTGLASS_TRUST_LAN is not set — LAN browsers will be refused as cross-origin; set it to allow them`);
}
if (AUTH_TOKEN) {
  if (AUTH.source === "generated") {
    console.log(`🔑 auth token (generated, saved ${AUTH.path} — keep it):`);
    console.log(`     ${AUTH_TOKEN}`);
    console.log(`     open the dashboard as  <url>/?token=${AUTH_TOKEN}`);
  } else if (AUTH.source === "file") {
    console.log(`🔑 auth token loaded from ${AUTH.path} — clients must pass ?token= or Authorization: Bearer`);
  } else {
    console.log(`🔑 AGENTGLASS_TOKEN set — clients must pass ?token= or Authorization: Bearer`);
  }
}
if (WEB_UI_ENABLED) console.log(`   Web UI      → http://localhost:${server.port}/ (serving web/dist)`);
console.log(`   POST events → http://localhost:${server.port}/ingest`);
console.log(`   WebSocket   → ws://localhost:${server.port}/stream`);
console.log(`   Stats API   → http://localhost:${server.port}/stats`);
console.log(`   Retention   → ${RETENTION_DAYS ? `${RETENTION_DAYS} days` : "unlimited"}`);
const ws = workspaceRoot();
console.log(ws ? `   Project     → ${ws} (this project only)` : "   Project     → every project on this machine");
// Only meaningful once a project is open — see startAutoFetch().
startAutoFetch();
