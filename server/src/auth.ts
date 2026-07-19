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

const TOKEN_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "token"
);

// Append-only telemetry sinks + health. Everything else — reads, shell,
// git/docker writes, gate decisions — is behind the token when one is set.
const INTAKE = new Set([
  "/health",
  "/ingest",
  "/gate",
  "/v1/traces",
  "/otlp/v1/traces",
  "/v1/logs",
  "/otlp/v1/logs",
]);

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
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || url.searchParams.get("token") || "";
  return !!provided && eq(provided, token);
}
