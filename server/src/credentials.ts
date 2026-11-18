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

/** Every provider this store may hold, the same list as `ProviderId`. A top-level
 *  key of an old flat file is a provider only if it is one of these. */
export const CREDENTIAL_PROVIDERS = ["github", "gitlab", "taskwarrior", "clickup", "jira"] as const satisfies readonly ProviderId[];
const isProvider = (k: string): k is ProviderId => (CREDENTIAL_PROVIDERS as readonly string[]).includes(k);

/** The name of one stored account: `work`, `personal`. Not the identity the
 *  service reports (`Credential.account`), which is a different thing. */
export const ACCOUNT_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** The reserved key: migration and the first connect on a clean provider create it. */
export const PRIMARY = "primary";

/*
 * v2 on disk: { version: 2, accounts: { <provider>: { <accountKey>: Credential } },
 * defaults: { <provider>: <accountKey> } }. A file is v2 when `accounts` is an
 * object; `version` is not consulted, because an older build's keyring switch
 * rewrites it to `{}` and the file must still be read. Anything else is the flat
 * file this module used to write, one Credential per provider, and is read as
 * account `primary` of each provider. Loading never writes: the v2 file appears
 * on the next save.
 */
interface Store {
  accounts: Partial<Record<ProviderId, Record<string, Credential>>>;
  /** The default pointer: what an omitted account means. Nothing else is called "default". */
  defaults: Partial<Record<ProviderId, string>>;
  /** Top-level keys that are not ours, written back as they were. */
  extra: Record<string, unknown>;
  /** v2 account entries this build cannot read (a name it does not allow, a token
   *  that is not a string), kept so a save never deletes what a person typed. */
  rejected: Record<string, Record<string, unknown>>;
}

let cache: Store | undefined;

const isCred = (v: unknown): v is Credential => !!v && typeof v === "object" && typeof (v as Credential).token === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parse(raw: unknown): Store {
  const st: Store = { accounts: {}, defaults: {}, extra: {}, rejected: {} };
  if (!isObj(raw)) return st;
  const v2 = isObj(raw.accounts);
  if (v2) {
    for (const [p, byKey] of Object.entries(raw.accounts as Record<string, unknown>)) {
      if (!isProvider(p) || !isObj(byKey)) continue;
      const kept: Record<string, Credential> = {};
      for (const [k, c] of Object.entries(byKey)) {
        if (ACCOUNT_KEY.test(k) && isCred(c)) kept[k] = c;
        else {
          (st.rejected[p] ??= {})[k] = c;
          // The name only, never the value.
          console.warn(`credentials: keeping an unreadable "${p}" account "${k}" as it is; fix its name or token by hand`);
        }
      }
      if (Object.keys(kept).length) st.accounts[p] = kept;
    }
    if (isObj(raw.defaults)) {
      for (const [p, k] of Object.entries(raw.defaults)) {
        if (isProvider(p) && typeof k === "string" && st.accounts[p]?.[k]) st.defaults[p] = k;
      }
    }
  }
  for (const [k, c] of Object.entries(raw)) {
    if (k === "version" || k === "accounts" || k === "defaults") continue;
    if (!isProvider(k)) { st.extra[k] = c; continue; }
    if (!isCred(c)) { st.extra[k] = c; continue; }
    if (!st.accounts[k]) { st.accounts[k] = { [PRIMARY]: c }; st.defaults[k] = PRIMARY; }
    else console.warn(`credentials: ignoring a flat "${k}" token left beside its accounts; it is removed on the next save`);
  }
  return st;
}

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    cache = parse(existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {});
  } catch {
    // A corrupt file is treated as empty rather than fatal: the app must still
    // start, and the fix is to connect again — which overwrites it.
    cache = parse({});
  }
  return cache!;
}

/*
 * Writers read `load()` and call `save()` with no `await` between them, and that
 * is the whole of their safety: `save` is not inside `exclusive()`, which wraps
 * only the two writers that wait on the keyring. A writer that awaits between
 * its read and its save (storeCredential does) reads AFTER the await.
 * Wrapping the synchronous writers in `exclusive` would change nearly every caller.
 *
 * Never writes a flat provider key: a migrated or ignored one must not stay on
 * disk, or a cleared account would come back from it.
 */
/** The accounts to write: the readable ones, over the ones kept as they were. */
function withRejected(st: Store): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of new Set([...Object.keys(st.rejected), ...Object.keys(st.accounts)])) {
    out[p] = { ...st.rejected[p as ProviderId], ...st.accounts[p as ProviderId] };
  }
  return out;
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
    writeSync(fd, JSON.stringify({ ...store.extra, version: 2, accounts: withRejected(store), defaults: store.defaults }, null, 2) + "\n");
    // On disk before the rename: otherwise a power cut can leave the new name
    // over bytes that never landed, and the token is gone with the old file.
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, p);
  fsyncDir(dirname(p));
  cache = store;
}

/** The account an omitted key means: the default pointer if it names a stored
 *  account, else the only stored account, else none. Never guesses between several. */
function resolve(st: Store, id: ProviderId, key?: string): string | null {
  const by = st.accounts[id];
  if (key !== undefined) return by?.[key] ? key : null;
  if (!by) return null;
  const d = st.defaults[id];
  if (d && by[d]) return d;
  const keys = Object.keys(by);
  return keys.length === 1 ? keys[0]! : null;
}

/** The key a write goes to. Throws one sentence when it cannot be decided. */
function writeKey(st: Store, id: ProviderId, key?: string): string {
  if (key !== undefined) {
    if (!ACCOUNT_KEY.test(key)) throw new Error("an account name is lowercase letters, digits, - and _, up to 32");
    // `primary` is the migration's name for the old single token. Naming a new
    // account that would put its token where that old item lives is refused.
    const names = Object.keys(st.accounts[id] ?? {});
    if (key === PRIMARY && names.length && !names.includes(PRIMARY)) throw new Error(`"${PRIMARY}" is reserved: choose another account name`);
    return key;
  }
  const r = resolve(st, id);
  if (r) return r;
  const names = Object.keys(st.accounts[id] ?? {});
  if (!names.length) return PRIMARY;
  throw new Error(`${id} has several accounts (${names.join(", ")}) and no default: name the account`);
}

const noAccount = (st: Store, id: ProviderId): Error =>
  new Error(`${id} has several accounts (${Object.keys(st.accounts[id] ?? {}).join(", ")}) and no default: name the account`);

/** `st` with `c` stored as `key`. The pointer is taken here, at save time, so a
 *  write that waited on the keyring does not claim it over one that saved first. */
function withAccount(st: Store, id: ProviderId, key: string, c: Credential): Store {
  const accounts = { ...st.accounts, [id]: { ...st.accounts[id], [key]: c } };
  const d = st.defaults[id];
  const defaults = d && st.accounts[id]?.[d] ? st.defaults : { ...st.defaults, [id]: key };
  return { ...st, accounts, defaults };
}

/** The secret, for the server's own outbound call. Never hand the result to
 *  anything that serialises. */
export function secretFor(id: ProviderId, accountKey?: string): string | null {
  const st = load();
  const k = resolve(st, id, accountKey);
  const t = k === null ? undefined : st.accounts[id]?.[k]?.token;
  return t === undefined ? null : unsealed(credentialId(id, k!), t);
}

/** Everything about a credential EXCEPT the secret — the shape a route may
 *  return and a log may print. */
export const redacted = (id: ProviderId): Omit<Credential, "token"> & { present: boolean } | null => redacted2(id, resolve(load(), id));

/** `redacted` plus the key of the account it is about. */
export function redactedAccount(id: ProviderId, accountKey?: string): (Omit<Credential, "token"> & { present: boolean; accountKey: string }) | null {
  const k = resolve(load(), id, accountKey);
  const r = redacted2(id, k);
  return r && k !== null ? { ...r, accountKey: k } : null;
}
function redacted2(id: ProviderId, k: string | null): (Omit<Credential, "token"> & { present: boolean }) | null {
  const c = k === null ? undefined : load().accounts[id]?.[k];
  if (!c) return null;
  const { token: _token, ...rest } = c;
  return { ...rest, present: true };
}

/** The accounts stored for `id`, and which one the default pointer names (or
 *  would resolve to). */
export function accountsOf(id: ProviderId): { accountKey: string; isDefault: boolean }[] {
  const st = load();
  const d = resolve(st, id);
  return Object.keys(st.accounts[id] ?? {}).map((accountKey) => ({ accountKey, isDefault: accountKey === d }));
}

/** Point the default at a stored account. The only writer of the pointer besides a first save. */
export function setDefaultAccount(id: ProviderId, accountKey: string): void {
  const st = load();
  if (!st.accounts[id]?.[accountKey]) throw new Error(`${id} has no account called ${accountKey}`);
  save({ ...st, defaults: { ...st.defaults, [id]: accountKey } });
}

/** What a feature says when it has no token: `text`, and the keyring's reason
 *  when the token is there but the keyring cannot hand it over. */
export function notConnected(id: ProviderId, text: string, accountKey?: string): string {
  const st = load();
  const k = resolve(st, id, accountKey);
  const why = k !== null && st.accounts[id]?.[k]?.token === KEYRING_MARK ? missingSecretWhy() : null;
  return why && secretFor(id, accountKey) === null ? `${text} (${why})` : text;
}

export const hasCredential = (id: ProviderId, accountKey?: string): boolean => !!secretFor(id, accountKey);

/** Whether any stored account of `id` gives up a token. Resolves secrets like
 *  `hasCredential`: a locked keyring reads false, not true. */
export const hasAnyCredential = (id: ProviderId): boolean =>
  Object.keys(load().accounts[id] ?? {}).some((k) => !!secretFor(id, k));

/** Whether the file holds a token for `id`, a keyring mark included: true while
 *  the keyring is locked, when `hasCredential` cannot know. */
export function hasStoredCredential(id: ProviderId, accountKey?: string): boolean {
  const st = load();
  const k = resolve(st, id, accountKey);
  return k !== null && !!st.accounts[id]?.[k]?.token;
}

/** The plain write. With the keyring on it would put the token in the file, so
 *  it refuses: `storeCredential` is the one that knows where the token goes. */
export function setCredential(id: ProviderId, c: Credential, accountKey?: string): void {
  if (keyringEnabled()) throw new Error("the keyring is on: a token is stored with storeCredential");
  const st = load();
  save(withAccount(st, id, writeKey(st, id, accountKey), c));
}

/** Store a token where the person chose: the keyring first (read back, then the
 *  file carries a mark), or the file as before. Throws, and changes nothing,
 *  when the keyring cannot keep it. */
export function storeCredential(id: ProviderId, c: Credential, accountKey?: string): Promise<void> {
  // Resolved once, before the first await: this is the account the whole call
  // is about, whatever the pointer does while the keyring answers.
  const start = load();
  const key = writeKey(start, id, accountKey);
  const existed = !!start.accounts[id]?.[key];
  return exclusive(async () => {
    // The keyring first; the file is read only after, so a change made while
    // waiting for it is not written over.
    const item = credentialId(id, key);
    const prior = keyringEnabled() ? await priorValue(item) : null;
    const token = await sealValue(item, c.token);
    try {
      const st = load();
      if (existed && !st.accounts[id]?.[key]) throw new Error("account removed while saving");
      save(withAccount(st, id, key, { ...c, token }));
    } catch (e) {
      // The file refused: the keyring goes back to what the file still points
      // at, or the new token sits there with nothing referring to it.
      if (token === KEYRING_MARK) await putBack(item, prior);
      throw e;
    }
  });
}

/** Take the token out of the keyring before the file forgets it, so a failure
 *  leaves both. A no-op while the keyring is off. Returns the account it resolved. */
export const dropCredentialSecret = (id: ProviderId, accountKey?: string): Promise<string | null> =>
  exclusive(async () => {
    const st = load();
    const k = resolve(st, id, accountKey);
    if (k === null) {
      // Nothing stored is nothing to drop; several accounts and no default is a question.
      if (accountKey === undefined && Object.keys(st.accounts[id] ?? {}).length) throw noAccount(st, id);
      return null;
    }
    const token = st.accounts[id]?.[k]?.token;
    if (token) await dropValue(credentialId(id, k), token);
    // The account this call dropped: hand it to `clearCredential`, so the pair
    // is about one account even if the pointer moves in between.
    return k;
  });

/** What the migration needs: each token as the file holds it (a mark or the token). */
export function secretSlots(): { id: string; value: string }[] {
  return Object.entries(load().accounts).flatMap(([p, by]) =>
    Object.entries(by ?? {}).flatMap(([k, c]) => (c.token ? [{ id: credentialId(p, k), value: c.token }] : [])));
}

/** Put the file back to `raw` byte for byte (or remove it if there was none), by the same
 *  temp file, fsync and rename a save uses. */
function restoreBytes(raw: Buffer | null): void {
  const p = path();
  if (raw === null) { unlinkSync(p); return; }
  const tmp = `${p}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
  fsyncDir(dirname(p));
}

/** Replace tokens in the file by id and read the file back to see they landed.
 *  False leaves the file as it was. */
export function rewriteSecrets(by: ReadonlyMap<string, string>): boolean {
  const before = load();
  // The bytes as they are now: a failed rewrite puts these back, not a re-render
  // of the parsed store (which would turn an old flat file into v2).
  let raw: Buffer | null = null;
  try { raw = existsSync(path()) ? readFileSync(path()) : null; } catch { return false; }
  const accounts: Store["accounts"] = {};
  for (const [p, byKey] of Object.entries(before.accounts) as [ProviderId, Record<string, Credential>][]) {
    accounts[p] = Object.fromEntries(Object.entries(byKey).map(([k, c]) => [k, { ...c, token: by.get(credentialId(p, k)) ?? c.token }]));
  }
  const next: Store = { ...before, accounts };
  try {
    save(next);
    cache = undefined;
    const back = load();
    if ((Object.entries(next.accounts) as [ProviderId, Record<string, Credential>][]).every(([p, byKey]) =>
      Object.entries(byKey).every(([k, c]) => back.accounts[p]?.[k]?.token === c.token))) return true;
  } catch { /* fall through to put it back */ }
  try { restoreBytes(raw); } catch { /* the caller reads the file again */ }
  cache = undefined;
  return false;
}

/** Update the notes on a credential without touching the secret — used after a
 *  re-check confirms who the token belongs to. */
export function annotate(id: ProviderId, patch: Omit<Partial<Credential>, "token">, accountKey?: string): void {
  const st = load();
  const k = resolve(st, id, accountKey);
  const cur = k === null ? undefined : st.accounts[id]?.[k];
  if (!cur || k === null) return;
  save({ ...st, accounts: { ...st.accounts, [id]: { ...st.accounts[id], [k]: { ...cur, ...patch } } } });
}

export function clearCredential(id: ProviderId, accountKey?: string): void {
  const st = load();
  const k = resolve(st, id, accountKey);
  if (k === null) {
    if (accountKey === undefined && Object.keys(st.accounts[id] ?? {}).length) throw noAccount(st, id);
    // Nothing to remove, but the file is still rewritten, as it always was: it
    // drops any flat key a v2 file carried and keeps the permissions ours.
    save(st);
    return;
  }
  const rest = { ...st.accounts[id] };
  delete rest[k];
  const accounts = { ...st.accounts };
  const defaults = { ...st.defaults };
  const left = Object.keys(rest);
  if (left.length) {
    accounts[id] = rest;
    if (defaults[id] === k || !defaults[id]) { if (left.length === 1) defaults[id] = left[0]!; else delete defaults[id]; }
  } else { delete accounts[id]; delete defaults[id]; }
  // The file is rewritten rather than deleted even when it empties, so the
  // permissions stay ours. A file we delete is a file the next writer creates
  // with whatever umask happens to be in force.
  save({ ...st, accounts, defaults });
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
