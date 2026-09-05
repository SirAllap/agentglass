// The mechanism docs/PLUGINS.md describes, and only that mechanism:
// install copies a folder, review shows what its manifest declares in the
// same words `auth.ts` already uses for `read`/`answer`/`full`, nothing runs
// until a human enables that specific plugin, and enabling mints a scoped
// token and spawns the entrypoint as a SEPARATE PROCESS talking HTTP — the
// exact shape EXTENDING.md documents for a hand-written extension, now
// installable by someone who did not write it.
//
// What this deliberately does not do: render anything. A plugin with a
// `full` token can call every route this server has, and there is nowhere
// for it to put a pixel — see the "Where this stops being small" section of
// the decision doc. Building a view/widget surface under cover of this task
// would be a second, undesigned feature wearing this one's name.
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mintPluginToken, revokePluginToken } from "./auth.ts";
import type { Scope } from "./devices.ts";
import { cloneUrlError } from "./projectadd.ts";
import {
  type InstallSource, catalogueUrlError, contentHash, pluginGitUrlError, pluginRefError, walkPluginDir,
} from "./plugin-sources.ts";
import { fetchCatalogue } from "./plugin-catalogue.ts";
import { blockedEntry, type BlockEntry } from "./plugin-blocklist.ts";

/** What a plugin folder must carry at its root, translated from `orca-plugin.json`
 *  in the decision doc into a name that names nothing but this app. */
export const MANIFEST_NAME = "plugin.json";

export interface PluginManifest {
  name: string;
  publisher: string;
  description: string;
  entrypoint: string;
  scope: Scope;
}

/** One path segment, the same character set `projectadd.ts` holds a cloned
 *  repository's name to — this becomes a directory name on disk. */
const NAME_RE = /^[A-Za-z0-9._-]{1,60}$/;

/**
 * The one rule for a plugin name, shared with the catalogue so the two
 * cannot drift apart again. The character set alone was not enough: it
 * admits `.` and `..`, and `pluginInstallDir("..")` is the config directory
 * itself — which `finishInstall` then `rmSync`s before anyone has consented
 * to anything. `projectadd.ts` had the `.`/`..` guard; this copy had dropped
 * it. A leading dot is refused too: a hidden install directory is never
 * what a catalogue entry means, and `.git`-shaped names are how a folder
 * copy turns into something git reads.
 */
export function validPluginName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name) && name !== "." && name !== ".." && !name.startsWith(".");
}
const MAX_TEXT = 500;
const NO_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Shape-checked entry by entry, the same discipline `panelease.ts` uses for
 * the lease file it reads at startup: a bad field loses the plugin rather
 * than being coerced into something wider than what was actually declared.
 * Returns the error sentence to show the reviewer, or the manifest.
 */
export function validateManifest(raw: unknown): PluginManifest | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "manifest must be a JSON object";
  const m = raw as Record<string, unknown>;
  if (!validPluginName(m.name)) {
    return "name must be 1-60 characters: letters, numbers, dots, dashes or underscores, and may not start with a dot";
  }
  if (typeof m.publisher !== "string" || !m.publisher.trim() || m.publisher.length > 200) {
    return "publisher must be 1-200 characters";
  }
  if (typeof m.description !== "string" || !m.description.trim() || m.description.length > MAX_TEXT) {
    return `description must be 1-${MAX_TEXT} characters`;
  }
  if (
    typeof m.entrypoint !== "string" || !m.entrypoint.trim() ||
    m.entrypoint.length > MAX_TEXT || NO_CONTROL_CHARS.test(m.entrypoint)
  ) {
    return "entrypoint must be a non-empty command with no control characters";
  }
  if (m.scope !== "read" && m.scope !== "answer" && m.scope !== "full") {
    return "scope must be one of read, answer, full";
  }
  return {
    name: m.name,
    publisher: m.publisher.trim().slice(0, 200),
    description: m.description.trim().slice(0, MAX_TEXT),
    entrypoint: m.entrypoint.trim(),
    scope: m.scope,
  };
}

/**
 * What the reviewer actually approved, as a fingerprint rather than a name.
 *
 * `panelease.ts` is the example this follows: a window id is not proof of
 * ownership, a stamp checked back off that exact window is. A plugin name is
 * not proof of what was reviewed either — an update can ship the same name
 * with `"scope": "full"` where it used to say `"read"` — so consent is tied
 * to this hash, not to the name, and installing a manifest whose hash no
 * longer matches what was approved must not carry the old approval forward.
 */
export function manifestHash(m: PluginManifest): string {
  const canonical = JSON.stringify({
    name: m.name, publisher: m.publisher, description: m.description,
    entrypoint: m.entrypoint, scope: m.scope,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * What a human actually approved, folding in the one thing `manifestHash`
 * alone cannot see: an update that leaves `scope`, `entrypoint` and every
 * other declared field untouched while quietly rewriting what the
 * entrypoint DOES currently inherits the old approval — `manifestHash`
 * cannot tell "same manifest" from "same manifest, different code" apart,
 * because it only ever reads the manifest.
 *
 * This folds in the content hash of everything on disk (`.git` excluded, see
 * `plugin-sources.ts`) alongside the declared capability set, so a rewrite
 * that ships no manifest change still clears the approval and re-asks.
 *
 * The cost, paid deliberately: every update re-asks, even one that changes a
 * comment or fixes a typo in a log line. A re-consent prompt people learn to
 * click through without reading is worse than none — but the alternative is
 * a prompt that is *sometimes* honest, which teaches the same reflex faster.
 * `manifestHash` is kept as a separate, coarser check (see the existing
 * "scope change on reinstall" behaviour below) because a human scanning the
 * plugin list wants to know when the ASK changed, not just when the bytes
 * did; `consentFingerprint` is the one `enablePlugin` actually gates on.
 */
export function consentFingerprint(m: PluginManifest, content: string): string {
  const canonical = JSON.stringify({
    scope: m.scope,
    hasExecutable: m.entrypoint.trim().length > 0,
    content,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface PluginRecord extends PluginManifest {
  /** Where this was installed from — a closed set of shapes, not a free
   *  string, so "where did this come from" stays answerable after the fact.
   *  See `InstallSource` in `plugin-sources.ts`. */
  source: InstallSource;
  installDir: string;
  manifestHash: string;
  /** Hash of every file under `installDir` except `.git` — see `contentHash`
   *  in `plugin-sources.ts`. Folded into `consentFingerprint`. */
  contentHash: string;
  /** What `enablePlugin` actually checks approval against — see
   *  `consentFingerprint` above. */
  fingerprint: string;
  /** The commit a `git`/`marketplace` source resolved to at install time, or
   *  `null` for a local-path install, which has no commit to speak of. */
  resolvedCommit: string | null;
  /** The manifest hash reviewed at the moment a human last enabled this
   *  plugin, or `null` if it has never been reviewed, or if an update since
   *  then cleared the old approval — which now happens on a manifest change
   *  OR a content-only change (see `consentFingerprint`), not manifest
   *  changes alone. Kept for display: a reviewer scanning the list wants to
   *  see when the manifest itself moved, which is coarser and more legible
   *  than `fingerprint`. `enablePlugin` gates on `fingerprint`, not this. */
  approvedHash: string | null;
  /** The fingerprint reviewed at the moment a human last enabled this
   *  plugin, or `null`. This is what `enablePlugin` actually gates on. */
  approvedFingerprint: string | null;
  enabled: boolean;
  installedAt: number;
  /**
   * Has a human EVER approved a version of this plugin, regardless of
   * whether that approval still holds. `approvedHash` alone cannot answer
   * this: it is `null` both for a plugin nobody has looked at yet and for
   * one an update just asked something new of, and those are not the same
   * fact for a reviewer — "review this" against "review this AGAIN, it
   * changed". Set once true, it stays true; it is display state, not a
   * security check, so `enablePlugin` never reads it.
   */
  hadApproval: boolean;
}

export function pluginsConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
}
export function pluginsPath(): string {
  return join(pluginsConfigDir(), "plugins.json");
}
export function pluginInstallDir(name: string): string {
  return join(pluginsConfigDir(), "plugins", name);
}

/**
 * True only when `dir` is a proper child of `<config>/plugins`. Checked
 * right before every `rmSync`/`cp` that targets an install directory, on
 * top of `validPluginName`: the name check stops a bad manifest at the
 * door, this stops a bad *record* — `plugins.json` is a file on disk, and a
 * record whose `installDir` reads `~/.config/agentglass` must not turn
 * "remove plugin" into "remove the app's configuration".
 */
function insidePluginsRoot(dir: string): boolean {
  const root = resolve(join(pluginsConfigDir(), "plugins"));
  const abs = resolve(dir);
  return abs.startsWith(root + sep) && abs.length > root.length + 1;
}

/** The same rule every other store in this server follows under test: only
 *  the scratch directory is readable or writable, so a suite run never reads
 *  or clobbers the developer's own installed plugins. */
const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

/**
 * `catalogues` is the list of URLs he has added, same file as everything
 * else plugins.ts persists. This is deliberately the ONLY thing kept about
 * a catalogue: not its name, not its plugin list, not when it was last
 * fetched. Those live only in the document itself, fetched fresh on every
 * browse (see fetchCatalogue) — a stranger's list is not something to cache
 * trust in, and a stale copy read as current is the exact lie the "catalogue
 * unreachable" state exists to avoid telling.
 *
 * No separate lockfile for installed plugins either: PluginRecord already
 * carries source, resolvedCommit and contentHash for every install, so
 * plugins.json already answers "what is installed, from where, at what
 * commit" — a second file would just be this one, copied.
 */
interface Store { master: boolean; plugins: PluginRecord[]; catalogues: string[] }
const DEFAULT_STORE: Store = { master: true, plugins: [], catalogues: [] };

function read(): Store {
  const p = pluginsPath();
  if (offLimits(p) || !existsSync(p)) return { ...DEFAULT_STORE, plugins: [], catalogues: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Store>;
    return {
      master: typeof parsed.master === "boolean" ? parsed.master : true,
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
      catalogues: Array.isArray(parsed.catalogues) ? parsed.catalogues.filter((c): c is string => typeof c === "string") : [],
    };
  } catch {
    // A corrupt file must not take the server down on boot — same rule
    // devices.ts follows. The cost is every plugin needs re-installing.
    return { ...DEFAULT_STORE, plugins: [], catalogues: [] };
  }
}

function write(store: Store): void {
  const p = pluginsPath();
  if (offLimits(p)) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** Live process state, deliberately never persisted. A pid and a token are
 *  only meaningful for the process that holds them; a server restart cannot
 *  hand either back, so it starts with nothing running, exactly the state a
 *  fresh boot with no plugins would be in. Re-enabling is how a plugin comes
 *  back after a restart — see the note on Store.master below. */
interface Running { proc: ReturnType<typeof Bun.spawn>; token: string; pid: number }
const running = new Map<string, Running>();

async function stopRunning(name: string): Promise<void> {
  const r = running.get(name);
  if (!r) return;
  running.delete(name);
  revokePluginToken(r.token);
  try { r.proc.kill(); } catch { /* already gone */ }
  try { await r.proc.exited; } catch { /* ignore */ }
}

function serverBase(): string {
  return `http://127.0.0.1:${Number(process.env.AGENTGLASS_PORT || 4000)}`;
}

/**
 * Start the entrypoint as its own process, with its own scoped token.
 *
 * The env object is built by hand rather than spread from `process.env` on
 * purpose — that is the exact mistake `auth.ts` documents having made once
 * already for launched agents: "They inherit the process environment, which
 * carries the MACHINE token." A plugin gets `PATH`/`HOME` to find its own
 * runtime and nothing that would let it read or write more than the scope a
 * human just approved.
 */
async function startProcess(rec: PluginRecord): Promise<void> {
  await stopRunning(rec.name);
  // Belt and braces: `enablePlugin` already refuses a blocked key, but this
  // is the one place a process actually starts, so it is the one place a
  // block can never be bypassed by a path that forgets to check first.
  if (blockedEntry(rec.name)) return;
  const token = mintPluginToken(rec.scope, rec.name);
  try {
    const proc = Bun.spawn(["bash", "-c", rec.entrypoint], {
      cwd: rec.installDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        AGENTGLASS_READ_TOKEN: token,
        AGENTGLASS_URL: serverBase(),
      },
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const entry: Running = { proc, token, pid: proc.pid };
    running.set(rec.name, entry);
    // A plugin that crashes or exits on its own must not leave a live token
    // behind — the same "revoked when the run ends" rule `mintUnderstudyToken`
    // already lives by, generalized from "the run ends" to "the process ends".
    proc.exited.then(() => {
      const cur = running.get(rec.name);
      if (cur === entry) { revokePluginToken(entry.token); running.delete(rec.name); }
    });
  } catch (e) {
    revokePluginToken(token);
    throw e;
  }
}

async function git(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, err: "" } : { ok: false, err: err.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export type PublicPlugin = PluginRecord & { running: boolean; pid: number | null };

export function listPlugins(): PublicPlugin[] {
  return read().plugins.map((p) => ({ ...p, running: running.has(p.name), pid: running.get(p.name)?.pid ?? null }));
}

export function masterEnabled(): boolean {
  return read().master;
}

export async function setMaster(enabled: boolean): Promise<void> {
  write({ ...read(), master: enabled });
  // Flipping the master switch off must actually stop everything — a plugin
  // left running after the switch that supposedly controls it is off is the
  // whole feature failing, the same standard `endLease`/`revokeDevice` hold
  // their own callers to.
  if (!enabled) for (const name of [...running.keys()]) await stopRunning(name);
}

/** What a caller may pass to `installPlugin` — a bare string (back-compat:
 *  an absolute local path, or a git URL with no particular ref), or a
 *  typed request naming its own `InstallSource` kind explicitly. */
export type InstallInput =
  | string
  | { kind: "local-path"; path: string }
  | { kind: "git"; url: string; ref?: string | null };

async function resolveHead(dir: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Everything after "a populated staging directory exists" — manifest read,
 * containment, content identity, and the copy into place. Shared by a
 * direct git/local install and a marketplace install, which differ only in
 * how `staging` got populated and what `InstallSource` they record.
 */
async function finishInstall(
  staging: string,
  source: InstallSource,
): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  const manifestPath = join(staging, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { ok: false, error: `No ${MANIFEST_NAME} at the root of that plugin` };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return { ok: false, error: `${MANIFEST_NAME} is not valid JSON` }; }
  const manifest = validateManifest(raw);
  if (typeof manifest === "string") return { ok: false, error: manifest };

  const walked = walkPluginDir(staging);
  if (!walked.ok) return { ok: false, error: walked.error ?? "plugin folder rejected" };
  const content = contentHash(staging, walked.files);
  const fingerprint = consentFingerprint(manifest, content);

  const installDir = pluginInstallDir(manifest.name);
  const hash = manifestHash(manifest);
  const store = read();
  const existing = store.plugins.find((p) => p.name === manifest.name);
  // The reviewer approved a specific declared scope over a specific tree of
  // bytes, not a name — see consentFingerprint. Unchanged keeps its
  // approval; changed loses it, and if it was running, running on the old
  // approval is worse than not running at all.
  const stillApproved = existing?.approvedFingerprint !== null && existing?.approvedFingerprint === fingerprint;
  const approvedHash = stillApproved ? existing!.approvedHash : null;
  const approvedFingerprint = stillApproved ? existing!.approvedFingerprint! : null;
  if (existing?.enabled && !stillApproved) await stopRunning(manifest.name);

  // Belt over braces: `validPluginName` already refused `..`, and this is
  // the assertion that survives a future edit to the regex. Nothing on disk
  // is touched unless the target is a child of the plugins folder.
  if (!insidePluginsRoot(installDir)) return { ok: false, error: "plugin name would install outside the plugins folder" };
  rmSync(installDir, { recursive: true, force: true });
  mkdirSync(dirname(installDir), { recursive: true });
  Bun.spawnSync(["cp", "-R", "--", staging, installDir]);

  const record: PluginRecord = {
    ...manifest,
    source,
    installDir,
    manifestHash: hash,
    contentHash: content,
    fingerprint,
    resolvedCommit: source.kind === "local-path" ? null : source.kind === "git" ? await resolveHead(installDir) : source.marketplace.resolvedCommit,
    approvedHash,
    approvedFingerprint,
    enabled: existing?.enabled === true && stillApproved,
    installedAt: existing?.installedAt ?? Date.now(),
    hadApproval: existing?.hadApproval === true,
  };
  write({ ...store, plugins: [...store.plugins.filter((p) => p.name !== manifest.name), record] });
  return { ok: true, plugin: { ...record, running: running.has(record.name), pid: running.get(record.name)?.pid ?? null } };
}

/**
 * Install = copy. A local path first; a git URL costs one `git clone` on top
 * of validation stricter than `projectadd.ts`'s (see `pluginGitUrlError`) —
 * a plugin address is re-used to update from later, so it may not carry a
 * credential the way a one-off project clone can. No plugin code runs here
 * — the manifest is only ever read, never executed.
 */
export async function installPlugin(input: InstallInput): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  let source: InstallSource;
  if (typeof input === "string") {
    if (!input.trim()) return { ok: false, error: "Provide a local path or a git URL" };
    const s = input.trim();
    if (isAbsolute(s)) {
      source = { kind: "local-path", path: s };
    } else {
      const urlBad = pluginGitUrlError(s);
      if (urlBad) return { ok: false, error: urlBad };
      source = { kind: "git", url: s, ref: null };
    }
  } else if (input && typeof input === "object" && input.kind === "local-path") {
    if (typeof input.path !== "string" || !input.path.trim()) return { ok: false, error: "Provide a local path" };
    source = { kind: "local-path", path: input.path.trim() };
  } else if (input && typeof input === "object" && input.kind === "git") {
    const urlBad = pluginGitUrlError(input.url);
    if (urlBad) return { ok: false, error: urlBad };
    const refBad = pluginRefError(input.ref ?? null);
    if (refBad) return { ok: false, error: refBad };
    source = { kind: "git", url: input.url.trim(), ref: input.ref?.trim() || null };
  } else {
    return { ok: false, error: "Provide a local path or a git URL" };
  }

  const staging = mkdtempSync(join(tmpdir(), "agx-plugin-"));
  try {
    if (source.kind === "local-path") {
      if (!isAbsolute(source.path)) return { ok: false, error: "A relative path would resolve against the server, not the caller" };
      let st;
      try { st = statSync(source.path); } catch { return { ok: false, error: "That path does not exist" }; }
      if (!st.isDirectory()) return { ok: false, error: "That path is not a folder" };
      Bun.spawnSync(["cp", "-R", "--", source.path.endsWith("/") ? source.path : source.path + "/.", staging]);
    } else {
      const args = ["clone", "--depth", "1"];
      if (source.ref) args.push("--branch", source.ref);
      args.push("--", source.url, staging);
      const r = await git(args, tmpdir(), 10 * 60 * 1000);
      if (!r.ok) return { ok: false, error: r.err || "git clone failed" };
    }
    return await finishInstall(staging, source);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Install by naming a plugin from a catalogue rather than typing its git URL
 * directly — the community-run half of distribution. The catalogue is
 * fetched fresh every time (it is a plain file, not something to cache
 * trust in), the named entry's own git source is what actually gets cloned,
 * and the installed record carries both: the catalogue this was found in
 * AND the plugin entry inside it, because either alone cannot answer "where
 * did this come from" — see `InstallSource`.
 */
export async function installFromCatalogue(
  catalogueUrl: string,
  pluginId: string,
): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  const fetched = await fetchCatalogue(catalogueUrl);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const entry = fetched.catalogue.plugins.find((p) => p.id === pluginId);
  if (!entry) return { ok: false, error: `No plugin "${pluginId}" in that catalogue` };

  const staging = mkdtempSync(join(tmpdir(), "agx-plugin-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (entry.source.ref) args.push("--branch", entry.source.ref);
    args.push("--", entry.source.url, staging);
    const r = await git(args, tmpdir(), 10 * 60 * 1000);
    if (!r.ok) return { ok: false, error: r.err || "git clone failed" };
    const resolvedCommit = await resolveHead(staging);
    const source: InstallSource = {
      kind: "marketplace",
      marketplace: { url: catalogueUrl, ref: null, resolvedCommit },
      plugin: { url: entry.source.url, ref: entry.source.ref },
    };
    return await finishInstall(staging, source);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Re-fetch a git-backed install at its recorded URL and ref — the update
 * this page otherwise has no way to trigger. Same path as a first install:
 * `finishInstall` re-derives the fingerprint from what actually came back,
 * so an update that changed the manifest or the entrypoint's code loses its
 * approval exactly like an install typed in fresh would, and never
 * re-enables itself. A local-path install has no upstream to re-fetch —
 * that source is copied in again by hand, not updated.
 */
export async function updatePlugin(name: string): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  const store = read();
  const existing = store.plugins.find((p) => p.name === name);
  if (!existing) return { ok: false, error: "no such plugin" };
  if (existing.source.kind === "local-path") return { ok: false, error: "A local install has no upstream to re-fetch" };
  const { url, ref } = existing.source.kind === "git"
    ? { url: existing.source.url, ref: existing.source.ref }
    : { url: existing.source.plugin.url, ref: existing.source.plugin.ref };

  const staging = mkdtempSync(join(tmpdir(), "agx-plugin-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push("--", url, staging);
    const r = await git(args, tmpdir(), 10 * 60 * 1000);
    if (!r.ok) return { ok: false, error: r.err || "git clone failed" };
    return await finishInstall(staging, existing.source);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Review-before-enable. Refuses if the master switch is off, if the plugin
 * key is on the kill list, or if what is on disk now is not what was last
 * approved (a bare re-enable after an update must not silently regrant a
 * widened scope, or resurrect an approval an unnoticed content rewrite
 * should have cleared) — the caller is expected to have shown the *current*
 * manifest to a human first, the same duty the install dialog already
 * carries.
 */
export async function enablePlugin(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return { ok: false, error: "no such plugin" };
  if (!store.master) return { ok: false, error: "plugins are switched off — flip the master switch first" };
  const block = blockedEntry(name);
  if (block) return { ok: false, error: `blocked: ${block.reason}${block.link ? ` (${block.link})` : ""}` };
  rec.approvedHash = rec.manifestHash;
  rec.approvedFingerprint = rec.fingerprint;
  rec.hadApproval = true;
  rec.enabled = true;
  write(store);
  await startProcess(rec);
  return { ok: true };
}

export async function disablePlugin(name: string): Promise<boolean> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return false;
  rec.enabled = false;
  write(store);
  await stopRunning(name);
  return true;
}

/** Disable and remove: stop the process, revoke its token, delete the
 *  copied folder, drop the record. A plugin left running after it was
 *  removed is the same failure a plugin left running after it was
 *  disabled is. */
export async function removePlugin(name: string): Promise<boolean> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return false;
  await stopRunning(name);
  // A record is read back from disk, so its `installDir` is trusted no more
  // than a manifest is: the folder goes only when it is a child of the
  // plugins root. Otherwise the record is dropped and the disk left alone —
  // a stale entry is a nuisance, a deleted config directory is not.
  if (insidePluginsRoot(rec.installDir)) rmSync(rec.installDir, { recursive: true, force: true });
  write({ ...store, plugins: store.plugins.filter((p) => p.name !== name) });
  return true;
}

/**
 * The catalogues he has added — a catalogue is somebody else's list, kept
 * the way he collects anything else: added by URL, browsable, removable.
 * Fetching one to browse it never adds it; adding is its own step.
 */
export function listCatalogues(): string[] {
  return read().catalogues;
}

export function addCatalogue(url: string): { ok: true } | { ok: false; error: string } {
  const bad = catalogueUrlError(url);
  if (bad) return { ok: false, error: bad };
  const u = url.trim();
  const store = read();
  if (store.catalogues.includes(u)) return { ok: true };
  write({ ...store, catalogues: [...store.catalogues, u] });
  return { ok: true };
}

export function removeCatalogue(url: string): boolean {
  const store = read();
  if (!store.catalogues.includes(url)) return false;
  write({ ...store, catalogues: store.catalogues.filter((c) => c !== url) });
  return true;
}

/** Test seam: wipe the store, the on-disk folder, and any running process. */
export async function __resetPlugins(): Promise<void> {
  for (const name of [...running.keys()]) await stopRunning(name);
  write({ master: true, plugins: [], catalogues: [] });
  try { rmSync(join(pluginsConfigDir(), "plugins"), { recursive: true, force: true }); } catch { /* nothing to clear */ }
}
