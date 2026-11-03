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
 *
 * The one exception is the person's own choice: with the system keyring switched
 * on (keyring.ts) the token is not in this file at all, and `token` holds a mark
 * that `secretFor` resolves. The file then has nothing to back up.
 */
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fsyncDir } from "./fsyncDir.ts";
import type { ProviderId } from "../../shared/providers.ts";
import { KEYRING_MARK, credentialId, dropValue, exclusive, keyringEnabled, missingSecretWhy, priorValue, putBack, sealValue, unsealed } from "./keyring.ts";

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
  /** The address the account signs in with, where the service authenticates by
   *  it as well as by the token (Jira: Basic email:token). Not a secret. */
  email?: string;
  /** The service's per-customer site: a host, with a port and context path
   *  where it has them (Jira: `acme.atlassian.net`, `jira.example.com:8443/jira`). */
  site?: string;
  /** How the token is presented: `basic` (account + token) or `bearer`. */
  auth?: "basic" | "bearer";
  /** The REST generation detected when connecting (Jira: 3 on Cloud, 2 on Data Center). */
  api?: 2 | 3;
  /** Jira Cloud: the site's id, kept when only the api.atlassian.com gateway accepts the token (a scoped one). */
  cloudId?: string;
  /** What the service said it is running as (Jira: `cloud` or `server`). */
  deployment?: "cloud" | "server";
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
  // Beside the file and renamed over it: a crash half way leaves the old file
  // whole, where a truncating write left JSON `load` reads as "no credentials".
  const tmp = `${p}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    // Enforced separately: `mode` on open does nothing to a file that already
    // exists (a stale temp file can), and the final file must be 0600 whatever it was.
    fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify(store, null, 2) + "\n");
    // On disk before the rename: otherwise a power cut can leave the new name
    // over bytes that never landed, and the token is gone with the old file.
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, p);
  fsyncDir(dirname(p));
  cache = store;
}

/** The secret, for the server's own outbound call. Never hand the result to
 *  anything that serialises. */
export function secretFor(id: ProviderId): string | null {
  const t = load()[id]?.token;
  return t === undefined ? null : unsealed(credentialId(id), t);
}

/** Everything about a credential EXCEPT the secret — the shape a route may
 *  return and a log may print. */
export function redacted(id: ProviderId): Omit<Credential, "token"> & { present: boolean } | null {
  const c = load()[id];
  if (!c) return null;
  const { token: _token, ...rest } = c;
  return { ...rest, present: true };
}

/** What a feature says when it has no token: `text`, and the keyring's reason
 *  when the token is there but the keyring cannot hand it over. */
export function notConnected(id: ProviderId, text: string): string {
  const why = load()[id]?.token === KEYRING_MARK ? missingSecretWhy() : null;
  return why && secretFor(id) === null ? `${text} (${why})` : text;
}

export const hasCredential = (id: ProviderId): boolean => !!secretFor(id);

/** Whether the file holds a token for `id`, a keyring mark included: true while
 *  the keyring is locked, when `hasCredential` cannot know. */
export const hasStoredCredential = (id: ProviderId): boolean => !!load()[id]?.token;

/** The plain write. With the keyring on it would put the token in the file, so
 *  it refuses: `storeCredential` is the one that knows where the token goes. */
export function setCredential(id: ProviderId, c: Credential): void {
  if (keyringEnabled()) throw new Error("the keyring is on: a token is stored with storeCredential");
  save({ ...load(), [id]: c });
}

/** Store a token where the person chose: the keyring first (read back, then the
 *  file carries a mark), or the file as before. Throws, and changes nothing,
 *  when the keyring cannot keep it. */
export function storeCredential(id: ProviderId, c: Credential): Promise<void> {
  return exclusive(async () => {
    // The keyring first; the file is read only after, so a change made while
    // waiting for it is not written over.
    const item = credentialId(id);
    const prior = keyringEnabled() ? await priorValue(item) : null;
    const token = await sealValue(item, c.token);
    try {
      save({ ...load(), [id]: { ...c, token } });
    } catch (e) {
      // The file refused: the keyring goes back to what the file still points
      // at, or the new token sits there with nothing referring to it.
      if (token === KEYRING_MARK) await putBack(item, prior);
      throw e;
    }
  });
}

/** Take the token out of the keyring before the file forgets it, so a failure
 *  leaves both. A no-op while the keyring is off. */
export const dropCredentialSecret = (id: ProviderId): Promise<void> =>
  exclusive(async () => {
    const token = load()[id]?.token;
    if (token) await dropValue(credentialId(id), token);
  });

/** What the migration needs: each token as the file holds it (a mark or the token). */
export function secretSlots(): { id: string; value: string }[] {
  return Object.entries(load()).flatMap(([p, c]) => (c?.token ? [{ id: credentialId(p), value: c.token }] : []));
}

/** Replace tokens in the file by id and read the file back to see they landed.
 *  False leaves the file as it was. */
export function rewriteSecrets(by: ReadonlyMap<string, string>): boolean {
  const before = load();
  const next: Store = {};
  for (const [p, c] of Object.entries(before) as [ProviderId, Credential][]) next[p] = { ...c, token: by.get(credentialId(p)) ?? c.token };
  try {
    save(next);
    cache = undefined;
    const back = load();
    if (Object.entries(next).every(([p, c]) => back[p as ProviderId]?.token === c!.token)) return true;
  } catch { /* fall through to put it back */ }
  try { save(before); } catch { /* the caller reads the file again */ }
  cache = undefined;
  return false;
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
