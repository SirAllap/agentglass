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
// Intake routes stay tokenless on purpose (see INTAKE): local hooks and OTel
// exporters have no way to carry a secret, and they can only *append* events.
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

// Routes that never require the token: append-only telemetry sinks + health.
// A local hook or OTel exporter has no way to carry a secret and can only
// *append* events, so these stay open even when a token is configured.
//
// Note: /gate is deliberately NOT here. It's the control plane — a POST creates
// an operator-facing approval prompt with caller-controlled text — so when a
// token is set the gate hook must authenticate (it runs on the same machine and
// can read AGENTGLASS_TOKEN from the env). With no token configured the whole
// auth check is skipped anyway, so /gate keeps its zero-config tokenless UX.
const AUTH_EXEMPT = new Set([
  "/health",
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

/** True for routes that bypass the shared-secret gate even when a token is set. */
export const isAuthExempt = (pathname: string) => AUTH_EXEMPT.has(pathname) || isPairing(pathname);

// Rate-limited intake sinks (flood protection). /gate is included: even though
// it authenticates when a token is set, a burst of gate posts shouldn't be
// unbounded. This set governs throttling only, not auth exemption.
// `/pair/claim` is here for the same reason: it takes no credential, so the
// only thing standing between it and a script is the five-guess cap on one
// ticket. That cap is the real defence; this stops the noise before it.
const INTAKE = new Set([...AUTH_EXEMPT, "/gate", "/pair/claim"]);

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
const FULL_GET = new Set(["/terminal/pty"]);

/**
 * What a phone is for.
 *
 * `/gate/decide` is the reason the companion exists: an agent is stopped and a
 * person says go. The chat routes are the same act by other means — replying to
 * a session that is already running, which is what "answer" means. Starting new
 * sessions, the terminal, git write and docker are not here.
 *
 * `/push/*` is a device managing its own notifications, which is the mechanism
 * that tells it there is something to answer at all.
 */
const ANSWER_POST = new Set([
  "/gate/decide",
  "/chat/send",
  "/chat/pane/key",
  "/push/subscribe",
  "/push/unsubscribe",
  "/push/test",
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
