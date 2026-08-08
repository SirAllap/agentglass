/*
 * Credentials for services that have no CLI to hold them.
 *
 * `gh` keeps its token in the system keyring and we never see it, which is the
 * arrangement to prefer wherever it exists. ClickUp has no such tool, so a
 * personal token has to live somewhere, and this is that somewhere: one file,
 * mode 0600, beside the app's own token — the same place and the same mode
 * `auth.ts` already established for exactly this reason.
 *
 * Three rules, and they are the whole module:
 *
 *   1. It is written 0600 at creation AND chmod'd afterwards. Creating with
 *      `mode` does not fix a file that already existed with looser permissions,
 *      and the interesting case is precisely the second write.
 *   2. Nothing here ever returns a secret to a caller that could serialise it.
 *      `secretFor` is for the server's own fetch; `redacted` is what a route
 *      may send. Two functions rather than a flag, because a flag defaulting
 *      the wrong way is one typo away from putting a token in a JSON response.
 *   3. A token is never logged, not even truncated. A prefix plus a length is
 *      enough to find one in a leak.
 *
 * Not encrypted, and that is a deliberate limit rather than an oversight: any
 * key this process could read unattended would sit next to the thing it
 * protects. 0600 stops another user on this machine. It does NOT stop a backup
 * of your home directory, which is the honest thing to say out loud — and is
 * said out loud, in SECURITY.md.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ProviderId } from "../../shared/providers.ts";

const CRED_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "credentials.json",
);

/** Test seam: point the store somewhere disposable. A suite must never read or
 *  write the developer's real credentials, and a suite that forgot to would
 *  pass — which is the failure mode this exists to remove. */
let overridePath: string | null = null;
export function __setCredentialsPath(p: string | null): void { overridePath = p; cache = undefined; }
const path = (): string => overridePath ?? CRED_PATH;
/** The file, for the page that says where secrets are kept. The path, never a
 *  token: this is exported so somebody can go and look, not so the browser
 *  can. */
export const credentialsPath = (): string => path();

/** What is kept per provider. Only `token` is a secret; the rest is what the
 *  service told us about the token, so a card can say who you are without a
 *  round trip on every render. */
export interface Credential {
  token: string;
  /** Who this token belongs to, as the service reports it. */
  account?: string;
  /** The provider's own id for that account — what its API filters by. */
  accountId?: string;
  /** The workspace/team this is scoped to, where a service has them. */
  workspace?: string;
  workspaceId?: string;
  /** When it was last accepted by the service. */
  verifiedAt?: number;
}

type Store = Partial<Record<ProviderId, Credential>>;

let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    cache = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Store) : {};
  } catch {
    // A corrupt file is treated as empty rather than fatal: the app must still
    // start, and the fix is to connect again — which overwrites it.
    cache = {};
  }
  return cache!;
}

function save(store: Store): void {
  const p = path();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  // Enforced separately: `mode` on write does nothing to a file that already
  // exists, and a file that already exists is the normal case here.
  chmodSync(p, 0o600);
  cache = store;
}

/** The secret, for the server's own outbound call. Never hand the result to
 *  anything that serialises. */
export function secretFor(id: ProviderId): string | null {
  return load()[id]?.token ?? null;
}

/** Everything about a credential EXCEPT the secret — the shape a route may
 *  return and a log may print. */
export function redacted(id: ProviderId): Omit<Credential, "token"> & { present: boolean } | null {
  const c = load()[id];
  if (!c) return null;
  const { token: _token, ...rest } = c;
  return { ...rest, present: true };
}

export const hasCredential = (id: ProviderId): boolean => !!load()[id]?.token;

export function setCredential(id: ProviderId, c: Credential): void {
  save({ ...load(), [id]: c });
}

/** Update the notes on a credential without touching the secret — used after a
 *  re-check confirms who the token belongs to. */
export function annotate(id: ProviderId, patch: Omit<Partial<Credential>, "token">): void {
  const cur = load()[id];
  if (!cur) return;
  save({ ...load(), [id]: { ...cur, ...patch } });
}

export function clearCredential(id: ProviderId): void {
  const store = { ...load() };
  delete store[id];
  // The file is rewritten rather than deleted even when it empties, so the
  // permissions stay ours. A file we delete is a file the next writer creates
  // with whatever umask happens to be in force.
  save(store);
}

/** Everything on disk, wiped. For a test's own teardown. */
export function __clearAll(): void {
  try { const p = path(); if (existsSync(p)) unlinkSync(p); } catch { /* nothing to clear */ }
  cache = undefined;
}

/**
 * A token as it may appear in a log or an error.
 *
 * Never the middle, never a suffix. A ClickUp token is `pk_` plus digits plus a
 * long random tail, and the tail is the part worth having — so the prefix and a
 * length are what gets printed, which is enough to tell two tokens apart and
 * useless to anybody who finds it.
 */
export const fingerprint = (token: string): string =>
  token ? `${token.slice(0, 3)}…(${token.length})` : "(none)";
