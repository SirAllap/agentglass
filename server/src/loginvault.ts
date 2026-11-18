/**
 * The login vault: where imported logins live, sealed, until something pulls
 * one site of them into a browser lane.
 *
 * One vault per source browser profile and container (`zen:abcd1234/1`): two
 * containers of one profile are two sets of logins, and merging them is how a
 * work account and a personal one end up in the same jar. A site that appears
 * in several vaults is never merged either (the pull asks which).
 *
 * The rules, each one a way to leak a login:
 *
 *   1. AES-256-GCM, a fresh random 12-byte IV on every write, the vault id as
 *      additional data — a file renamed onto another vault's name fails to
 *      open rather than opening as the wrong vault.
 *   2. The key lives in the system key store (Secret Service on Linux, the
 *      login Keychain on macOS). Neither answering means no vault: there is
 *      NO plain fallback and no key on disk, ever. Locked means "locked",
 *      said, and the vault stays shut. Nothing here prompts.
 *   3. Files are 0600 in a 0700 directory; a file's name is sha256(vault id),
 *      so the directory listing names no browser and no container.
 *      `index.json` maps ids to file names and carries counts — never a site
 *      name, a cookie name or a value.
 *   4. Values exist only inside the one-shot process that reads or writes a
 *      vault (cookieread.ts). This module has no HTTP route in front of it
 *      and must never get one.
 *
 * Pulling a site into a lane is plan part C: `pullSite` runs only inside the
 * one-shot vault helper that Electron main spawns for one pull (decision F3).
 * It opens the vaults, picks one (F5) and hands one site's values back on the
 * helper's stdout pipe, to main and nobody else.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportedCookie, PartitionKey } from "./cookieimport.ts";
import { keyringAvailability, keyringGet, keyringPut } from "./secretservice.ts";
import { runChild } from "./broker/brokerRun.ts";

/* ------------------------------------------------------------------ errors */

export type VaultErrorCode = "locked" | "unavailable" | "unsupported" | "no-key" | "corrupt" | "missing" | "ambiguous" | "none" | "expired" | "no-copy";

/** Every refusal carries a code for the UI and a sentence for the person. */
export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) { super(message); }
}

/* --------------------------------------------------------------- the shape */

export type { PartitionKey };

/** A cookie as the vault keeps it. No `expirationDate` means a session cookie;
 *  `partitionKey` means it is set through CDP, never `cookies.set`. */
export type VaultCookie = ImportedCookie;

/** Per-site storage blobs (plan cause 7), keyed by origin. Opt-in per site. */
export interface VaultStorage { origin: string; local: Record<string, string> }

export interface VaultSource {
  /** The browser profile id the picker knows (`zen:abcd1234`). */
  profile: string;
  /** Firefox `userContextId`; "0" for no container (and always for Chromium). */
  container: string;
  label: string;
}

export interface VaultData {
  v: 1;
  id: string;
  source: VaultSource;
  /** Seconds since the epoch. */
  importedAt: number;
  cookies: VaultCookie[];
  storage: Record<string, VaultStorage[]>;
}

/** What `index.json` holds per vault: enough to list it without the key. */
export interface VaultIndexEntry {
  file: string;
  label: string;
  profile: string;
  container: string;
  updatedAt: number;
  sites: number;
  cookies: number;
  sessionCookies: number;
}

/** The label a session cookie carries in the UI (Preflight decision F9). */
export const SESSION_LABEL = "Session login, copied. Lasts until you remove it or the site ends it.";

export const vaultIdOf = (profile: string, container = "0"): string => `${profile}/${container || "0"}`;

/** The file name for a vault: sha256(id), hex (decision F10). */
export const vaultFileName = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");

/* ------------------------------------------------------------ the key store */

export type KeyStoreState = "ready" | "locked" | "unavailable" | "unsupported";

export interface VaultKeyStore {
  state(): Promise<KeyStoreState>;
  /** The stored key text, or null when no key was ever stored. */
  get(): Promise<string | null>;
  put(value: string): Promise<void>;
}

const KEY_ATTRS = { application: "agentglass", id: "vault/key" };
const MAC_SERVICE = "agentglass vault";
const MAC_ACCOUNT = "agentglass";

/** Linux: the same Secret Service path as "Keep secrets in the system keyring". */
const secretServiceStore: VaultKeyStore = {
  state: () => keyringAvailability(),
  get: () => keyringGet(KEY_ATTRS),
  put: (value) => keyringPut(KEY_ATTRS, "agentglass login vault key", value),
};

/**
 * macOS: the login Keychain through `security`. The write goes through
 * `security -i` on stdin so the key never sits in a process argument list.
 * `security` exits 44 for "no such item" and 36 / 51 when the keychain is
 * locked or will not ask the person. Each runs on the spawn broker
 * (`runChild`), not forked from the server: the methods are async already.
 */
/** The keychain may ask the person to unlock it: room for that, not forever. */
const KEYCHAIN_MS = 60_000;

const keychainStore: VaultKeyStore = {
  async state() {
    const r = await runChild(["security", "show-keychain-info"], { timeoutMs: KEYCHAIN_MS, read: true });
    if (r.error) return "unavailable";
    if (r.code === 36 || r.code === 51) return "locked";
    return r.code === 0 ? "ready" : "unavailable";
  },
  async get() {
    const r = await runChild(["security", "find-generic-password", "-s", MAC_SERVICE, "-a", MAC_ACCOUNT, "-w"], { timeoutMs: KEYCHAIN_MS, read: true });
    if (r.code === 44) return null;
    if (r.code === 36 || r.code === 51) throw new VaultError("locked", "the login keychain is locked");
    if (r.code !== 0) throw new VaultError("unavailable", "the login keychain did not answer");
    return r.stdout.trim();
  },
  async put(value) {
    const r = await runChild(["security", "-i"], {
      stdin: `add-generic-password -U -s "${MAC_SERVICE}" -a "${MAC_ACCOUNT}" -w "${value}"\n`,
      timeoutMs: KEYCHAIN_MS,
    });
    if (r.code !== 0) throw new VaultError("unavailable", "the login keychain would not keep the vault key");
  },
};

const unsupportedStore: VaultKeyStore = {
  state: async () => "unsupported",
  get: async () => null,
  put: async () => { throw new VaultError("unsupported", "the login vault is not supported on this system"); },
};

let storeOverride: VaultKeyStore | null = null;
/** Test seam: a fake key store. A suite must never touch the developer's own. */
export function __setVaultKeyStore(s: VaultKeyStore | null): void { storeOverride = s; }

export function keyStore(platform: string = process.platform): VaultKeyStore {
  if (storeOverride) return storeOverride;
  if (platform === "linux") return secretServiceStore;
  if (platform === "darwin") return keychainStore;
  return unsupportedStore;
}

const WHY: Record<Exclude<KeyStoreState, "ready">, string> = {
  locked: "The system keyring is locked. Unlock it, then try again.",
  unavailable: "No system keyring answered, so the vault cannot keep its key. It will not store logins without one.",
  unsupported: "The login vault is not supported on this system yet (Linux and macOS only).",
};

/** The 32-byte vault key. Creates it only when `create` and the store is ready. */
let keyChain: Promise<unknown> = Promise.resolve();
export function vaultKey(create: boolean): Promise<Buffer> {
  if (!create) return loadKey(false);
  /* One creation at a time: a second first-time import then finds the key the first one made. */
  const run = keyChain.then(() => loadKey(true), () => loadKey(true));
  keyChain = run.catch(() => undefined);
  return run;
}

async function loadKey(create: boolean): Promise<Buffer> {
  const store = keyStore();
  let state: KeyStoreState;
  try { state = await store.state(); } catch { state = "unavailable"; }
  if (state !== "ready") throw new VaultError(state, WHY[state]);
  const stored = await store.get();
  if (stored) {
    const key = Buffer.from(stored, "base64");
    if (key.length !== 32) throw new VaultError("corrupt", "the vault key in the keyring is not a vault key");
    return key;
  }
  if (!create) throw new VaultError("no-key", "There is no vault key yet. Import logins to create one.");
  const fresh = randomBytes(32);
  await store.put(fresh.toString("base64"));
  // Read back before anything is sealed with it: a key the store did not keep
  // would seal a vault nobody can open again.
  const back = await store.get();
  const got = back ? Buffer.from(back, "base64") : null;
  if (!got || got.length !== fresh.length || !timingSafeEqual(got, fresh)) {
    throw new VaultError("unavailable", "the keyring did not keep the vault key, so nothing was stored");
  }
  return fresh;
}

/* ---------------------------------------------------------------- the files */

export function vaultDir(): string {
  if (process.env.AGX_VAULT_DIR) return process.env.AGX_VAULT_DIR;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "agentglass", "vaults");
}

function ensureDir(): string {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Write via a temp file and a rename, 0600 from the first byte. */
function writePrivate(path: string, data: Buffer | string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const MAGIC = Buffer.from("AGXVLT01", "latin1");
const IV_LEN = 12;
const TAG_LEN = 16;

/** Seal one vault: magic, IV, tag, ciphertext. Exported for the tests. */
export function seal(key: Buffer, id: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(id, "utf8"));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function unseal(key: Buffer, id: string, file: Buffer): Buffer {
  if (file.length < MAGIC.length + IV_LEN + TAG_LEN || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new VaultError("corrupt", "this is not a vault file");
  }
  const iv = file.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = file.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(id, "utf8"));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(file.subarray(MAGIC.length + IV_LEN + TAG_LEN)), d.final()]);
  } catch {
    throw new VaultError("corrupt", "the vault would not open with this key — it was changed, or sealed with another key");
  }
}

type Index = { v: 1; vaults: Record<string, VaultIndexEntry>; settingsWritten?: true };

export function readIndex(): Index {
  const path = join(vaultDir(), "index.json");
  if (!existsSync(path)) return { v: 1, vaults: {} };
  /* Never read a torn index as empty: the next write would save it and drop every other vault from the list. */
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Index;
    if (parsed && typeof parsed.vaults === "object" && parsed.vaults) return parsed;
  } catch { /* falls through */ }
  throw new VaultError("corrupt", "the vault index is damaged, so nothing was changed");
}

function writeIndex(index: Index): void {
  writePrivate(join(ensureDir(), "index.json"), JSON.stringify(index, null, 2) + "\n");
}

/* `.github.com` and `github.com` are one site: the leading dot only says the
   cookie also goes to subdomains, so it never counts as a second site. */
const siteCount = (d: VaultData, siteOf: (host: string) => string): number =>
  new Set(d.cookies.map((c) => siteOf(hostOfCookie(c)))).size;

/** Store one vault, replacing what was there. Creates the key on first use. */
export async function writeVault(data: VaultData, siteOf: (host: string) => string): Promise<VaultIndexEntry> {
  const key = await vaultKey(true);
  const dir = ensureDir();
  const file = vaultFileName(data.id);
  writePrivate(join(dir, file), seal(key, data.id, Buffer.from(JSON.stringify(data), "utf8")));
  const entry: VaultIndexEntry = {
    file, label: data.source.label, profile: data.source.profile, container: data.source.container,
    updatedAt: data.importedAt, sites: siteCount(data, siteOf), cookies: data.cookies.length,
    sessionCookies: data.cookies.filter((c) => c.expirationDate === undefined).length,
  };
  const index = readIndex();
  index.vaults[data.id] = entry;
  writeIndex(index);
  return entry;
}

/** Open one vault. Never creates a key: no key means nothing to open. */
export async function readVault(id: string): Promise<VaultData> {
  const entry = readIndex().vaults[id];
  const path = join(vaultDir(), entry?.file ?? vaultFileName(id));
  if (!existsSync(path)) throw new VaultError("missing", `there is no vault called ${id}`);
  const key = await vaultKey(false);
  const data = JSON.parse(unseal(key, id, readFileSync(path)).toString("utf8")) as VaultData;
  if (data.id !== id) throw new VaultError("corrupt", "the vault file holds a different vault");
  return data;
}

/** Every vault, from the index alone: no key, no values. */
export function listVaults(): ({ id: string } & VaultIndexEntry)[] {
  return Object.entries(readIndex().vaults).map(([id, e]) => ({ id, ...e }));
}

/* A vault name as a person types it: case, spaces and the dash they could
   type ("-") instead of the one Settings shows ("—", "–") do not matter. */
const looseName = (name: string): string =>
  name.normalize("NFKC").toLowerCase().replace(/[\u2010-\u2015\u2212-]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Find the vault a name means: its id, or the label Settings shows for it,
 * in any case and with any dash. Undefined when no vault has that name, or
 * when two vaults share the label (then only the id names one).
 */
export function resolveVaultName(name: string, vaults: Record<string, { label: string }> = readIndex().vaults): string | undefined {
  const hits = vaultsNamed(name, vaults);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Every vault a name could mean. An exact id beats another vault's loose id,
 * but not another vault's label: one vault's id that is a second vault's
 * label means both, and then the name picks neither.
 */
export function vaultsNamed(name: string, vaults: Record<string, { label: string }> = readIndex().vaults): string[] {
  const want = looseName(name);
  const byLabel = (id: string) => looseName(vaults[id]!.label ?? "") === want;
  if (vaults[name]) return [name, ...Object.keys(vaults).filter((id) => id !== name && byLabel(id))];
  return Object.keys(vaults).filter((id) => looseName(id) === want || byLabel(id));
}

/**
 * The name to show for each vault, exactly as `--vault` takes it back: the
 * label Settings shows, or the id when two vaults share that label.
 */
export function vaultChoiceNames(vaults: { id: string; label: string }[], all: { id: string; label: string }[] = vaults): string[] {
  /* A label is a name only when no other vault has it as label or as id:
     the id `--vault` would take first otherwise means a different vault. */
  return vaults.map((v) => {
    const want = looseName(v.label ?? "");
    const unique = !!v.label && all.every((o) => o.id === v.id || (looseName(o.label ?? "") !== want && looseName(o.id) !== want));
    return unique ? v.label : v.id;
  });
}

/** Delete one vault. Sweeping agent lanes that hold its logins is part D. */
export function removeVault(id: string): boolean {
  const index = readIndex();
  const entry = index.vaults[id];
  const path = join(vaultDir(), entry?.file ?? vaultFileName(id));
  const had = existsSync(path) || !!entry;
  rmSync(path, { force: true });
  if (entry) { delete index.vaults[id]; writeIndex(index); }
  return had;
}

/**
 * Take one site out of one vault: its cookies and its site storage. The rest
 * of the vault stays sealed as it was. A vault left with no site is removed.
 * False when the vault does not hold that site.
 */
export async function removeSite(id: string, site: string, siteOf: (host: string) => string): Promise<boolean> {
  const want = site.trim().toLowerCase();
  const data = await readVault(id);
  const cookies = data.cookies.filter((c) => siteOf(hostOfCookie(c)) !== want);
  if (cookies.length === data.cookies.length && !data.storage[want]) return false;
  const storage = { ...data.storage };
  delete storage[want];
  if (!cookies.length) { removeVault(id); return true; }
  await writeVault({ ...data, cookies, storage }, siteOf);
  return true;
}

/** Delete every vault and the index — orphan vault files too, not only the
 *  ones the index names. The key stays, and so do the person's settings
 *  (sensitive marks, defaults): Empty takes the logins out, not the choices
 *  about them, so a site marked sensitive still asks after a new import. */
export function emptyVaults(): number {
  let ids: string[] = [];
  try { ids = Object.keys(readIndex().vaults); } catch { /* a torn index is swept with the rest */ }
  const dir = vaultDir();
  const keep = vaultFileName(SETTINGS_ID);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* no vault dir yet */ }
  for (const name of names) {
    if (name === keep) continue;
    if (/^[0-9a-f]{64}$/.test(name) || /^[0-9a-f]{64}\.[0-9a-f]+\.tmp$/.test(name)) rmSync(join(dir, name), { force: true });
  }
  rmSync(join(dir, "index.json"), { force: true });
  return ids.length;
}

/* ------------------------------------------------------------------ */
/* Settings: per-site default vault, sensitive marks, storage opt-in.   */
/* Sealed like a vault, because it names sites.                         */
/* ------------------------------------------------------------------ */

export interface VaultSettings {
  v: 1;
  /** site -> vault id the person chose for it (decision F5). */
  defaults: Record<string, string>;
  /** The vault id the person chose for every site that is in several vaults
   *  and has no choice of its own in `defaults`. Only the person sets it. */
  defaultVault?: string;
  /** site -> true when the person confirmed it is sensitive (decision 3). */
  sensitive: Record<string, true>;
  /** site -> true when the person said it "needs storage" (cause 7). */
  storage: Record<string, true>;
  /** Sign agents out when their task ends. On unless the person turns it off. */
  signOutAtEnd: boolean;
  /** Sign agents in on their first visit to a site in a new ephemeral lane.
   *  On unless the person turns it off (an old file has no key: on). Never
   *  for a sensitive site, never outside an agent's ephemeral lane. */
  signInOnVisit: boolean;
  /** site -> the person's own "never copy" choice, true or false. A site with
   *  no key here takes the built-in default (`noCopyDefault`). */
  noCopy: Record<string, boolean>;
}

const SETTINGS_ID = "agx:settings";
const emptySettings = (): VaultSettings => ({ v: 1, defaults: {}, sensitive: {}, storage: {}, signOutAtEnd: true, signInOnVisit: true, noCopy: {} });

export async function readSettings(): Promise<VaultSettings> {
  const path = join(vaultDir(), vaultFileName(SETTINGS_ID));
  if (!existsSync(path)) return emptySettings();
  const key = await vaultKey(false);
  const got = JSON.parse(unseal(key, SETTINGS_ID, readFileSync(path)).toString("utf8")) as Partial<VaultSettings>;
  return { ...emptySettings(), ...got, v: 1 };
}

export async function writeSettings(next: VaultSettings): Promise<void> {
  const key = await vaultKey(true);
  /* Read the index first: a torn one throws, and it must not throw after the file already landed. */
  const index = readIndex();
  writePrivate(join(ensureDir(), vaultFileName(SETTINGS_ID)), seal(key, SETTINGS_ID, Buffer.from(JSON.stringify(next), "utf8")));
  /* Remember that settings were saved once: only then is a missing file a loss, not a fresh install. */
  if (!index.settingsWritten) { index.settingsWritten = true; writeIndex(index); }
}

/**
 * Words in a host that suggest a sensitive site. A suggestion only: the person
 * confirms each one by hand (decision 3), so this list is never the gate.
 */
const SENSITIVE_WORDS = ["admin", "bank", "banking", "billing", "prod", "console", "payroll", "finance"];
export function suggestSensitive(host: string): boolean {
  const words = host.toLowerCase().split(/[.\-_]+/);
  return words.some((w) => SENSITIVE_WORDS.includes(w));
}

/**
 * Sites whose login must never be copied out of the person's browser. Some
 * sites bind a session to one browser and end it, server side, when the same
 * tokens show up in another: copying it into a lane signs the person out in
 * their own browser too (measured with a social network's login). The
 * defaults are such sites and the bank-like hosts the sensitive words flag;
 * the person can mark or unmark any site (VaultSettings.noCopy).
 */
export const NO_COPY_SITES: readonly string[] = ["linkedin.com", "google.com", "youtube.com"];
/* One Google login is also set on its country sites (google.es, google.co.uk,
   google.com.br), each its own site to siteOf, with the same bound cookies. */
const GOOGLE_COUNTRY = /(^|\.)google\.(com|co|[a-z]{2})(\.[a-z]{2})?$/;
const NO_COPY_WORDS = ["bank", "banking", "payroll", "finance"];
export function noCopyDefault(site: string): boolean {
  const s = site.trim().toLowerCase().replace(/^\./, "");
  if (NO_COPY_SITES.some((d) => s === d || s.endsWith(`.${d}`))) return true;
  if (GOOGLE_COUNTRY.test(s)) return true;
  /* A bank's name is often one word with "bank" at an end: mybank, bankofamerica. */
  return s.split(/[.\-_]+/).some((w) => NO_COPY_WORDS.includes(w) || w.startsWith("bank") || w.endsWith("bank"));
}
/** The person's choice for `site`, else the default. */
export function isNoCopy(site: string, settings: Pick<VaultSettings, "noCopy">): boolean {
  const own = settings.noCopy?.[site];
  return typeof own === "boolean" ? own : noCopyDefault(site);
}
/** The one sentence an agent gets for a "never copy" site. */
export const noCopyLine = (site: string): string =>
  `${site} logs you out elsewhere when its login is copied. Ask the person to sign in once inside agentglass's own browser.`;

/**
 * Words that put a site on the "looks sensitive" list shown before sign-in on
 * visit is turned on: host words, and brands whose login reaches far. Split
 * like `suggestSensitive`, so `github.com` matches and `auth0.com` does not.
 * Its own list: the table's "Suggested sensitive" chip is unchanged.
 */
export const VISIT_SENSITIVE_WORDS: readonly string[] = [
  "mail", "auth", "login", "admin", "console", "billing", "bank", "pay",
  "slack", "atlassian", "google", "github", "claude", "openai",
];
export function visitSuggestSensitive(site: string): boolean {
  return site.toLowerCase().split(/[.\-_]+/).some((w) => VISIT_SENSITIVE_WORDS.includes(w));
}

/** The `n` vault sites with the most cookies, across every vault (a site in
 *  two vaults counts both), most first, then by name. Pure. */
export function mostUsedSites(vaults: readonly { sites: readonly { site: string; cookies: number }[] }[], n = 10): string[] {
  const by = new Map<string, number>();
  for (const v of vaults) for (const s of v.sites) by.set(s.site, (by.get(s.site) ?? 0) + s.cookies);
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([site]) => site);
}

/* ------------------------------------------------------------------ */
/* Pull: one site, one vault, into one ephemeral lane.                  */
/* ------------------------------------------------------------------ */

const hostOfCookie = (c: VaultCookie): string => (c.domain ?? new URL(c.url).hostname).replace(/^\./, "");

export type PullAnswer =
  | { ok: true; vault: string; label: string; site: string; sensitive: boolean; signOutAtEnd: boolean; cookies: VaultCookie[]; storage: VaultStorage[] }
  | { ok: false; code: "ambiguous"; error: string; vaults: { id: string; label: string }[] }
  | { ok: false; code: Exclude<VaultErrorCode, "ambiguous">; error: string };

/**
 * Find the one vault to pull `site` from, and that site's values.
 *
 * Runs in the one-shot helper only (decision F3). Never merges vaults (F5):
 * a named vault wins, then the person's default for the site, then their
 * default vault, then the only vault that has it; several and no default is `ambiguous`, with the names.
 */
export async function pullSite(
  req: { site: string; vault?: string },
  siteOf: (host: string) => string,
  now = Date.now() / 1000,
): Promise<PullAnswer> {
  const site = req.site.trim().toLowerCase();
  if (!site) return { ok: false, code: "none", error: "name a site to sign in to" };
  const index = readIndex().vaults;
  const named = req.vault ? resolveVaultName(req.vault, index) : undefined;
  if (req.vault && !named) {
    const both = vaultsNamed(req.vault, index);
    if (both.length > 1) return { ok: false, code: "missing", error: `${req.vault} names more than one vault: pass one of these ids: ${both.join(", ")}` };
    const all = Object.entries(index).map(([id, e]) => ({ id, label: e.label }));
    return { ok: false, code: "missing", error: `there is no vault called ${req.vault}: the vaults are ${vaultChoiceNames(all).join(", ") || "none"}` };
  }
  const settings = await readSettings();
  /* Settings were saved once and the sealed file is gone while vaults exist: the sensitive marks are lost, so they are unknown, and unknown asks. */
  const marksLost = Object.keys(index).length > 0 && readIndex().settingsWritten === true && !existsSync(join(vaultDir(), vaultFileName(SETTINGS_ID)));
  /* Before any vault is opened: a "never copy" site leaves no vault at all. */
  if (isNoCopy(site, settings)) return { ok: false, code: "no-copy", error: noCopyLine(site) };
  const ids = named ? [named] : Object.keys(index).sort();
  const matches: { data: VaultData; cookies: VaultCookie[] }[] = [];
  for (const id of ids) {
    const data = await readVault(id);
    const cookies = data.cookies.filter((c) => siteOf(hostOfCookie(c)) === site);
    if (cookies.length) matches.push({ data, cookies });
  }
  const chosen = matches.length === 1 ? matches[0]
    : matches.find((m) => m.data.id === settings.defaults[site])
      ?? (settings.defaultVault ? matches.find((m) => m.data.id === settings.defaultVault) : undefined);
  if (!chosen) {
    if (matches.length > 1) {
      return {
        ok: false, code: "ambiguous",
        error: `${site} is in ${matches.length} vaults; ask the person which one, then name it`,
        vaults: matches.map((m) => ({ id: m.data.id, label: m.data.source.label })),
      };
    }
    return { ok: false, code: "none", error: named ? `the vault ${index[named]!.label || named} holds no login for ${site}` : `no vault holds a login for ${site}` };
  }
  /* Every cookie past its date: nothing to sign in with. The person is asked
     to import again (mockup state 6); an agent can never refresh it (decision 2). */
  if (chosen.cookies.every((c) => c.expirationDate !== undefined && c.expirationDate <= now)) {
    return { ok: false, code: "expired", error: `the vault login for ${site} has expired: ask the person to import it again (Settings ▸ Browser ▸ Login vault)` };
  }
  return {
    ok: true, vault: chosen.data.id, label: chosen.data.source.label, site,
    sensitive: marksLost || settings.sensitive[site] === true,
    signOutAtEnd: settings.signOutAtEnd,
    cookies: chosen.cookies,
    storage: settings.storage[site] ? (chosen.data.storage[site] ?? []) : [],
  };
}

/** Every site a vault holds, with counts and expiry: no names, no values. */
export async function vaultSites(siteOf: (host: string) => string): Promise<{
  vault: string; label: string; sites: { site: string; cookies: number; session: number; expires: number | null; storage: boolean }[];
}[]> {
  const out = [];
  for (const id of Object.keys(readIndex().vaults).sort()) {
    const data = await readVault(id);
    const by = new Map<string, { site: string; cookies: number; session: number; expires: number | null; storage: boolean }>();
    for (const c of data.cookies) {
      const site = siteOf(hostOfCookie(c));
      const row = by.get(site) ?? { site, cookies: 0, session: 0, expires: null, storage: !!data.storage[site]?.length };
      row.cookies += 1;
      if (c.expirationDate === undefined) row.session += 1;
      else row.expires = Math.max(row.expires ?? 0, c.expirationDate);
      by.set(site, row);
    }
    out.push({ vault: id, label: data.source.label, sites: [...by.values()].sort((a, b) => a.site.localeCompare(b.site)) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pull log: site, agent, lane, time, count. Never a name or a value.   */
/* Electron main appends it (electron/vault-pull.js); this reads it.    */
/* ------------------------------------------------------------------ */

export interface PullLogEntry {
  at: number;
  event: "pull" | "refused" | "signout";
  site: string;
  agent: string;
  lane: string;
  vault?: string;
  count: number;
  why?: string;
  /** What started the pull: a first visit, or the `vault` verb. Old lines
   *  have none: read them as "verb". */
  cause?: "visit" | "verb";
}

export const pullLogPath = (): string => join(vaultDir(), "pulls.jsonl");

export function readPullLog(site?: string, limit = 500): PullLogEntry[] {
  let text = "";
  try { text = readFileSync(pullLogPath(), "utf8"); } catch { return []; }
  const rows: PullLogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as PullLogEntry;
      if (!site || e.site === site) rows.push(e);
    } catch { /* a torn last line from a crash: skip it */ }
  }
  return rows.slice(-limit);
}
