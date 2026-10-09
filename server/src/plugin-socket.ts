/*
 * Slice 3: the one extra listener a boxed `network: "agentglass"` plugin
 * talks through instead of the internet — a unix socket, opened lazily the
 * first time such a plugin actually boxes, and stopped from
 * `stopAllPluginsSync` in plugins.ts.
 *
 * Kept free of any import from index.ts or plugins.ts on purpose: plugins.ts
 * already imports this module (to start and stop the listener), and index.ts
 * imports plugins.ts, so this module importing either one back would make a
 * cycle the bundler has broken on before (see AGENTS.md, "Editing"). Instead
 * index.ts hands over its own request handler once, at boot, through
 * `setPluginSocketHandler` — the same shape `fetch` in `Bun.serve` always
 * had, just injected rather than imported.
 *
 * The handler itself never learns it is being called from here: every
 * request this module lets through arrives already scrubbed to look exactly
 * like a request from somewhere off this machine (see `fakeServer` below),
 * so the ordinary gate in index.ts — no tokenless sink, no isSelf, no
 * device-panel privilege — applies to a boxed plugin exactly as it would to
 * a stranger on the tailnet. The plugin-token check below is a SECOND,
 * narrower gate in front of that: only a plugin's own credential may use
 * this socket at all, checked here rather than left to the general gate,
 * because the general gate's job is "who is this", not "is this socket for
 * you" — a device or a machine token is a real credential, just never one
 * this socket exists for.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pluginOfRequest, presented } from "./auth.ts";

/**
 * Loose on purpose: the real type is `(req: Request, srv: Bun.Server<WsData>)
 * => Promise<Response>` in index.ts, where `WsData` is private to that
 * module. Widening it here — rather than exporting `WsData` and importing it,
 * which would cost nothing today but invites the next person to import
 * index.ts itself for some OTHER type and build the cycle this file is
 * structured to avoid — is the one deliberate `any` in this file: index.ts's
 * own call to `setPluginSocketHandler` casts across it, and every other line
 * here is fully typed.
 */
export type SocketRequestHandler = (req: Request, srv: any) => Promise<Response>;

let handler: SocketRequestHandler | null = null;

/** Called once, from index.ts, right after its own `fetch` handler is
 *  defined — before any plugin could possibly have started. */
export function setPluginSocketHandler(h: SocketRequestHandler): void {
  handler = h;
}

/** Mirrors `pluginsConfigDir()` in plugins.ts and plugin-sandbox.ts.
 *  Re-derived rather than imported for the same reason those two do it: this
 *  module must stay import-free of anything that imports it back. */
function pluginsConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}

/** A private directory next to `plugin-data`, isolated by the same
 *  `XDG_CONFIG_HOME` override a test — or a second instance — already gets
 *  everything else in `pluginsConfigDir()` with. Mode 0700 even if it
 *  pre-existed looser, the same belt-and-braces `persist()` in auth.ts uses
 *  for the machine token file. */
function pluginRuntimeDir(): string {
  const dir = join(pluginsConfigDir(), "plugin-runtime");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

/** The one shared socket every boxed `network: "agentglass"` plugin's bridge
 *  dials — the token in the request is what tells them apart, so a second
 *  plugin process never needs a second listener. Ceiling: every boxed plugin
 *  shares this one process's accept queue and this one process's memory; a
 *  plugin that opens many connections and never closes them costs every
 *  other boxed plugin the same fds. */
export function pluginSocketPath(): string {
  return join(pluginRuntimeDir(), "plugin.sock");
}

let socketServer: { stop(force?: boolean): void } | null = null;
let socketServerPath: string | null = null;

/** Marks the exact `Request` object handed to the main handler as having come
 *  in through this socket — a `WeakSet` rather than a header or a property on
 *  the request, so nothing forwarded, replayed, or forged on the wire (a
 *  request built from scratch, or `scrub`'s own `new Request(req, …)` copy of
 *  someone else's) can ever set it. Only `socketFetch`, right here, ever adds
 *  to it. See `viaPluginSocket` — the index.ts zero-config gate is the one
 *  caller today, but the same guarantee ("this exact request object, not a
 *  claim inside it") is why this lives here rather than as a plain boolean
 *  field on a widened `Request`. */
const socketRequests = new WeakSet<Request>();

/** True only for the exact `Request` object `socketFetch` built and handed to
 *  the main handler for THIS call — never true for a request that merely
 *  carries a valid plugin token over the real TCP port. A plugin token is a
 *  real credential either way (`pluginOfRequest` still checks it), but the
 *  zero-config gate in index.ts exempts a plugin ONLY when it also proves it
 *  came in over the socket, not just that it holds a token that could have
 *  leaked (`?token=` query strings travel). */
export function viaPluginSocket(req: Request): boolean {
  return socketRequests.has(req);
}

/** A request wearing an `Upgrade` header, refused before it reaches the main
 *  handler's own `srv.upgrade` at all. Plugins long-poll `/plugin/self/events`
 *  instead of holding a socket open, so there is nothing here that needs a
 *  duplex connection — and the main handler's `srv.upgrade` would have no
 *  sensible thing to do with the fake `Server` below regardless. */
function isUpgradeRequest(req: Request): boolean {
  return (req.headers.get("upgrade") || "").toLowerCase() === "websocket";
}

/** Headers that could, on some OTHER code path added later, be read directly
 *  instead of through `resolvePeer`/`proxiedByTailscaled` — both of which
 *  already treat this socket as remote on their own, because `fakeServer`'s
 *  `requestIP` returns null and `proxiedByTailscaled` refuses a null-address
 *  peer outright (see net.ts, remote.ts). Stripped anyway: the guarantee
 *  this socket makes ("never treated as local") should not depend on nobody
 *  ever adding a header-reading shortcut around those two functions. */
const FORGEABLE_HEADERS = ["x-forwarded-for", "tailscale-headers-info", "tailscale-user-login"];

function scrub(req: Request): Request {
  const headers = new Headers(req.headers);
  for (const h of FORGEABLE_HEADERS) headers.delete(h);
  return new Request(req, { headers });
}

/** What the main handler sees as `srv`: no address (so `resolvePeer` and
 *  every `isLoopback`/`isSelf` check downstream of it reads "not this
 *  machine"), no real port, and an `upgrade` that always fails — belt and
 *  braces alongside the `isUpgradeRequest` refusal above, in case the main
 *  handler is ever reordered to check something before that refusal runs. */
function fakeServer(): { requestIP(): null; port: undefined; upgrade(): false } {
  return {
    requestIP: () => null,
    port: undefined,
    upgrade: () => false,
  };
}

async function socketFetch(req: Request): Promise<Response> {
  if (isUpgradeRequest(req)) {
    return new Response(JSON.stringify({ ok: false, error: "the plugin socket has no WebSocket upgrade" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  // A device or a machine token is a real credential, and 403 (not 401) says
  // so: it is refused for what it is, not for being absent. Checked before
  // `pluginOfRequest` would matter either way, since `presented` is what
  // both are reading, but computing it once and branching on it says the
  // intent straight rather than making a reader infer it from two lookups.
  const token = presented(req, url);
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized — the plugin socket needs a plugin's own token" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  if (!pluginOfRequest(req, url)) {
    return new Response(JSON.stringify({ ok: false, error: "only a plugin token may use this socket" }), {
      status: 403, headers: { "content-type": "application/json" },
    });
  }
  if (!handler) {
    return new Response(JSON.stringify({ ok: false, error: "the plugin socket has no server behind it yet" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
  const scrubbed = scrub(req);
  socketRequests.add(scrubbed);
  return handler(scrubbed, fakeServer());
}

/**
 * True when something is actually listening at `path` right now — a real
 * connect, not just "the inode still exists", because a crashed process
 * leaves exactly that inode behind and a stale one is the common case this
 * whole function exists to clear. A short timeout either way: nothing on
 * the other end answers instantly, so waiting longer only delays every
 * plugin's first start on the ordinary (nobody home) path.
 */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (live: boolean) => {
      if (done) return;
      done = true;
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), 300);
    Bun.connect({
      unix: path,
      socket: {
        open(sock) {
          // `finish` BEFORE `end()`: ending the socket fires this same
          // handler set's own `close` synchronously, re-entering `finish`
          // with `false` while `done` is still unset — measured losing the
          // race this way, `open` never got to report `true` at all.
          clearTimeout(timer);
          finish(true);
          try { sock.end(); } catch { /* fine */ }
        },
        error() {
          clearTimeout(timer);
          finish(false);
        },
        close() {
          clearTimeout(timer);
          finish(false);
        },
        data() { /* never expected before we close it ourselves */ },
      },
    }).catch(() => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

/**
 * Starts the listener the first time a boxed `network: "agentglass"` plugin
 * starts; a no-op on every start after that. Called from `buildBoxArgv` in
 * plugins.ts, before the box's own argv is built — so the socket exists
 * before bwrap ever tries to bind-mount it.
 *
 * Two installs (or a dev server next to an installed app) can share the same
 * `XDG_CONFIG_HOME`, and an unconditional `rmSync` used to delete whichever
 * one started second's LIVE socket out from under it — the first instance's
 * new boxes then bind the second's freshly recreated path and get 403 from
 * a server that never minted their tokens, and the second instance's own
 * `stop` deletes a path that is now the first instance's. Connecting first
 * tells a live server from a stale file; only a stale file gets removed.
 * The smaller of two ways to close this (a per-instance socket name would
 * also need the box side and every test fixture that hardcodes
 * `PLUGIN_SOCKET_BOX_PATH.../plugin.sock` to learn the new name) — the
 * ceiling this leaves is that a SECOND instance under the same config dir
 * simply never gets a plugin socket of its own: its `network: "agentglass"`
 * plugins fall back to whatever `buildBoxArgv`'s caller does when this
 * throws (today: the start fails loudly, not silently through someone
 * else's socket).
 */
// The in-flight attempt, shared by every concurrent caller until it settles
// either way — not a lock that stays held, just memoisation of the one
// promise already running. Cleared in `finally` so the NEXT call (there is
// always one: `socketServer` is still null after a failed attempt) starts a
// fresh attempt rather than replaying a stale rejection forever.
let inFlight: Promise<void> | null = null;

/** See the doc comment above; this just adds "don't start a second attempt
 *  while one is already running". Two enables (or an enable racing the boot
 *  resume) used to both see a stale socket file and both run `rmSync` +
 *  `Bun.serve`, unlinking each other's fresh socket — measured with `ss
 *  -xlp` leaking a listener per extra concurrent call, none of which
 *  `stopPluginSocketServer` could ever reach again. */
export function ensurePluginSocketServer(): Promise<void> {
  if (socketServer) return Promise.resolve();
  if (!inFlight) {
    inFlight = ensurePluginSocketServerOnce().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function ensurePluginSocketServerOnce(): Promise<void> {
  if (socketServer) return;
  const path = pluginSocketPath();
  if (existsSync(path) && (await socketIsLive(path))) {
    throw new Error(
      `plugin socket at ${path} is already live (another agentglass instance owns it) — refusing to steal it`,
    );
  }
  try {
    rmSync(path, { force: true });
  } catch {
    /* nothing stale to remove */
  }
  // Same body ceiling as the main port (Bun default 128 MB). `idleTimeout`
  // is missing from `UnixServeOptions`'s own type (commit 80357561 read
  // that as "not settable on a unix listener"), but measured on 1.3.9 the
  // default 10 s idle timeout applies here same as any other listener and
  // cuts /plugin/self/events' 25 s long-poll in half; `server.timeout(req,
  // 0)` from inside `fetch` does NOT reach it for a unix listener (tried
  // first, measured doing nothing), but the option below does. Cast past
  // the type gap since the runtime accepts it. All plugins share one rate
  // bucket here (the token names the plugin, the bucket does not): one
  // noisy plugin can rate-limit another's open intake.
  socketServer = Bun.serve({
    unix: path, fetch: socketFetch, maxRequestBodySize: 32 * 1024 * 1024,
    idleTimeout: 255,
  } as Bun.ServeOptions & { unix: string; idleTimeout: number });
  socketServerPath = path;
  try {
    chmodSync(path, 0o600);
  } catch {
    /* the containing directory (0700) is the real fence */
  }
}

/** Called from `stopAllPluginsSync`. Also the test seam: a test that changed
 *  `XDG_CONFIG_HOME` between runs needs the SINGLETON above to forget the
 *  stale path it started on, not just the file removed. */
export function stopPluginSocketServer(): void {
  if (socketServer) {
    try {
      socketServer.stop(true);
    } catch {
      /* already gone */
    }
    socketServer = null;
  }
  if (socketServerPath) {
    try {
      rmSync(socketServerPath, { force: true });
    } catch {
      /* fine */
    }
    socketServerPath = null;
  }
}
