// The mechanism docs/PLUGINS.md describes, and only that mechanism:
// install copies a folder, review shows what its manifest declares in the
// same words `auth.ts` already uses for `read`/`answer`/`full`, nothing runs
// until a human enables that specific plugin, and enabling mints a scoped
// token and spawns the entrypoint as a SEPARATE PROCESS talking HTTP — the
// exact shape EXTENDING.md documents for a hand-written extension, now
// installable by someone who did not write it.
//
// Drawing is a separate module: a plugin may declare panels, a settings page
// and notes on pull requests in its manifest (`contributes`), and send what to
// show as data. plugin-ui.ts keeps it and the window draws it with its own
// components, so no plugin code ever runs in the window — see "Drawing in the
// app" in docs/PLUGINS.md. Declaring is part of what gets reviewed: the
// contributions are in `manifestHash`, so a plugin that starts drawing
// somewhere new asks again.
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mintPluginToken, revokePluginToken } from "./auth.ts";
import type { Scope } from "./devices.ts";
import { cloneUrlError } from "./projectadd.ts";
import {
  type InstallSource, FULL_COMMIT, contentHash, pluginGitUrlError, pluginRefError, walkPluginDir,
} from "./plugin-sources.ts";
import { fetchCatalogue } from "./plugin-catalogue.ts";
import type { GuardedFetchOptions } from "./net.ts";
import { blockedEntry, type BlockEntry } from "./plugin-blocklist.ts";
import { type Contributes, validateContributes } from "../../shared/pluginUi.ts";
import { coerceSettings, dropNotesOf, fieldsWithOptions, forgetPlugin, pushEvent, resolveSettings, setLivenessCheck } from "./plugin-ui.ts";

/** What a plugin folder must carry at its root, translated from `orca-plugin.json`
 *  in the decision doc into a name that names nothing but this app. */
export const MANIFEST_NAME = "plugin.json";

export interface PluginManifest {
  name: string;
  publisher: string;
  description: string;
  entrypoint: string;
  scope: Scope;
  /** Where it may draw. Optional in the file; always present once read, so
   *  a manifest from before drawing existed reads as "draws nowhere". */
  contributes: Contributes;
  /** Its own mark: a file in its folder (svg, png or webp) and a colour. Both
   *  optional and both only ever shown — the icon is served as an image, never
   *  inlined, so an SVG's scripts have nowhere to run. */
  icon?: string;
  color?: string;
  /** The oldest agentglass this plugin works on, as `major.minor.patch`.
   *  Checked at install rather than at enable: a plugin that needs a surface
   *  this app does not draw should not be sitting in the list waiting to be
   *  switched on. */
  minApp?: string;
}

/**
 * Is `have` at least `want`? Both `major.minor.patch`, missing parts are zero.
 *
 * Nothing more: a plugin says the oldest version it works on and the app says
 * whether it is that old. Ranges, carets and pre-release ordering are a
 * dependency solver's problem, and this is one number against another.
 */
/**
 * This app's version, for a plugin that says which one it needs.
 *
 * `build-info.json` is what an installed app carries; a checkout has none, and
 * package.json beside the source is the honest answer there. Overridable for
 * the tests, which need to be older and newer than a manifest on purpose.
 */
export function appVersion(): string {
  if (process.env.AGENTGLASS_VERSION) return process.env.AGENTGLASS_VERSION;
  for (const p of [
    join(dirname(process.execPath), "build-info.json"),
    new URL("../../package.json", import.meta.url).pathname,
  ]) {
    try {
      const v = JSON.parse(readFileSync(p, "utf8"))?.version;
      if (typeof v === "string" && v) return v;
    } catch { /* the next one, or the floor below */ }
  }
  return "0.0.0";
}

export function versionAtLeast(have: string, want: string): boolean {
  const parts = (v: string) => v.trim().split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [h, w] = [parts(have), parts(want)];
  for (let i = 0; i < 3; i++) {
    if ((h[i] ?? 0) !== (w[i] ?? 0)) return (h[i] ?? 0) > (w[i] ?? 0);
  }
  return true;
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
  const contributes = validateContributes(m.contributes);
  if (!contributes.ok) return contributes.error;
  if (m.icon !== undefined && (typeof m.icon !== "string" || !ICON_RE.test(m.icon) || m.icon.split("/").includes(".."))) {
    return "icon must be a relative path to an .svg, .png or .webp file in the plugin folder";
  }
  if (m.color !== undefined && (typeof m.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(m.color))) {
    return "color must be a hex colour like #7c5cf5";
  }
  if (m.minApp !== undefined && (typeof m.minApp !== "string" || !/^\d{1,4}(\.\d{1,4}){0,2}$/.test(m.minApp))) {
    return "minApp must be a version like 0.18.0";
  }
  return {
    name: m.name,
    publisher: m.publisher.trim().slice(0, 200),
    description: m.description.trim().slice(0, MAX_TEXT),
    entrypoint: m.entrypoint.trim(),
    scope: m.scope,
    contributes: contributes.value,
    ...(typeof m.icon === "string" ? { icon: m.icon } : {}),
    ...(typeof m.color === "string" ? { color: m.color.toLowerCase() } : {}),
    ...(typeof m.minApp === "string" ? { minApp: m.minApp } : {}),
  };
}

const ICON_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,99}\.(svg|png|webp)$/;
const ICON_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", webp: "image/webp" };
const ICON_MAX_BYTES = 256 * 1024;

/**
 * A plugin's icon as bytes and a type, or null. The path came from its
 * manifest and is checked again here against the folder it was installed to:
 * resolved, it must still be inside, and it must not be a link out of it.
 */
export function pluginIcon(name: string): { bytes: Uint8Array; type: string } | null {
  const rec = read().plugins.find((p) => p.name === name);
  if (!rec?.icon || !ICON_RE.test(rec.icon) || !insidePluginsRoot(rec.installDir)) return null;
  const root = resolve(rec.installDir);
  const file = resolve(root, rec.icon);
  if (!file.startsWith(root + sep)) return null;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > ICON_MAX_BYTES) return null;
    return { bytes: new Uint8Array(readFileSync(file)), type: ICON_TYPES[file.slice(file.lastIndexOf(".") + 1)]! };
  } catch {
    return null;
  }
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
    // Only when present, so a plugin that draws nothing keeps the hash it had
    // before drawing existed and its approval is not cleared by an upgrade of
    // this app.
    ...(Object.keys(m.contributes ?? {}).length ? { contributes: m.contributes } : {}),
    // Its look is part of what was approved too, so a plugin cannot take on
    // another's face after the fact; absent keeps the old hash.
    ...(m.icon ? { icon: m.icon } : {}),
    ...(m.color ? { color: m.color } : {}),
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
  /** What the person chose on the plugin's settings page, coerced to the
   *  declared fields. Survives updates; a field an update removed is simply
   *  never read again. */
  settings?: Record<string, unknown>;
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
 * Nothing is kept about the market: not its name, not its plugin list, not
 * when it was last fetched. That document lives on the site and is fetched
 * fresh on every read (see fetchCatalogue) — a stale copy read as current is
 * the exact lie the "did not answer" state exists to avoid telling. The list
 * of URLs that used to be here went with the screen that added them: there
 * is one market, and it is named in web/src/components/plugins/Market.tsx.
 *
 * No separate lockfile for installed plugins either: PluginRecord already
 * carries source, resolvedCommit and contentHash for every install, so
 * plugins.json already answers "what is installed, from where, at what
 * commit" — a second file would just be this one, copied.
 */
interface Store { master: boolean; plugins: PluginRecord[] }
const DEFAULT_STORE: Store = { master: true, plugins: [] };

function read(): Store {
  const p = pluginsPath();
  if (offLimits(p) || !existsSync(p)) return { ...DEFAULT_STORE, plugins: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Store>;
    return {
      master: typeof parsed.master === "boolean" ? parsed.master : true,
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    };
  } catch {
    // A corrupt file must not take the server down on boot — same rule
    // devices.ts follows. The cost is every plugin needs re-installing.
    return { ...DEFAULT_STORE, plugins: [] };
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
 *  hand either back, so it starts with nothing running and
 *  `resumeEnabledPlugins` starts each enabled plugin again with a new token. */
interface Running { proc: ReturnType<typeof Bun.spawn>; token: string; pid: number }
const running = new Map<string, Running>();
setLivenessCheck((name) => running.has(name));

/** The whole group: the entrypoint runs as `bash -c`, and what it started
 *  (an interpreter, a caged agent) is a grandchild that a kill of the bash
 *  pid alone leaves running. Each plugin is spawned as its own group. */
function killGroup(pid: number, sig: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(-pid, sig); } catch { /* already gone */ }
}

async function stopRunning(name: string): Promise<void> {
  const r = running.get(name);
  if (!r) return;
  running.delete(name);
  revokePluginToken(r.token);
  forgetPlugin(name);
  killGroup(r.pid);
  try { await r.proc.exited; } catch { /* ignore */ }
}

/**
 * On the way out of the server, synchronous because `process.exit` does not
 * wait. Without it a restart left every plugin running with a dead token —
 * measured: a Bun child outlives a parent that exits on SIGTERM — and resuming
 * on boot then started a second copy beside it, one more per restart.
 */
export function stopAllPluginsSync(): void {
  for (const [name, r] of [...running.entries()]) {
    running.delete(name);
    revokePluginToken(r.token);
    killGroup(r.pid);
  }
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
      // Its own process group, so stopping it stops everything it started.
      detached: true,
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
      if (cur === entry) { revokePluginToken(entry.token); running.delete(rec.name); forgetPlugin(rec.name); }
    });
  } catch (e) {
    revokePluginToken(token);
    throw e;
  }
}

/**
 * The environment of every git a plugin install runs. It asks nobody for a
 * password: the server is not somebody at a terminal, and a repository that
 * answered 401 left an install waiting on a prompt in whatever terminal the
 * server was started from. And it fetches nothing through Git LFS, where the
 * user has it: a plugin's own .lfsconfig names the LFS host, so installing a
 * plugin made this machine talk to a server the plugin chose. A plugin that
 * keeps files in LFS installs with the pointers, which is also what the
 * catalogue's runner hashes.
 */
const pluginGitEnv = (): Record<string, string | undefined> => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" });

/**
 * Every git a plugin install runs. The line endings are pinned because a
 * catalogue's hash is taken over the bytes a checkout writes: Git for Windows
 * installs with core.autocrlf on, and a checkout that turned every text file
 * to CRLF hashed to something no catalogue had listed. A plugin's own
 * `.gitattributes` still decides, the same way on every machine.
 */
async function git(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  try {
    const p = Bun.spawn(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], { cwd, env: pluginGitEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, err: "" } : { ok: false, err: err.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export type PublicPlugin = PluginRecord & { running: boolean; pid: number | null };

/** A record from before `contributes` existed has none on disk. */
function withContributes(p: PluginRecord): PluginRecord {
  return p.contributes ? p : { ...p, contributes: {} };
}

/** `settings` stays out: what a person typed into one plugin's settings (a
 *  key, a private repository) is not for every read-scope caller of /plugins
 *  — another plugin, a paired phone — to see. It is served on its own, at
 *  `full`, and to the plugin itself over its own token. */
export function listPlugins(): PublicPlugin[] {
  return read().plugins.map(({ settings: _s, ...p }) => ({ ...withContributes(p), running: running.has(p.name), pid: running.get(p.name)?.pid ?? null }));
}

/** What a plugin declared, for the routes that check a draw against it. */
export function contributesOf(name: string): Contributes {
  return read().plugins.find((p) => p.name === name)?.contributes ?? {};
}

export function isRunning(name: string): boolean {
  return running.has(name);
}

export function pluginSettings(name: string): { fields: ReturnType<typeof fieldsWithOptions>; values: Record<string, unknown> } | null {
  const rec = read().plugins.find((p) => p.name === name);
  if (!rec) return null;
  return { fields: fieldsWithOptions(name, rec.contributes?.settings), values: resolveSettings(rec.contributes?.settings, rec.settings) };
}

/**
 * Save what the person chose, typed by the manifest, and tell the plugin.
 * Merged over what was there, so a form that only shows some fields cannot
 * erase the rest.
 */
export function setPluginSettings(name: string, raw: unknown): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return { ok: false, error: "no such plugin" };
  const fields = rec.contributes?.settings;
  if (!fields?.length) return { ok: false, error: "this plugin has no settings" };
  rec.settings = { ...(rec.settings ?? {}), ...coerceSettings(fields, raw) };
  write(store);
  const values = resolveSettings(fields, rec.settings);
  pushEvent(name, { type: "settings", settings: values, at: Date.now() });
  return { ok: true, values };
}

/**
 * Bring back what was running before the server went down.
 *
 * A token cannot survive a restart (they live in memory, on purpose), but the
 * person's decision can: `enabled` with an approval that still matches the
 * fingerprint recorded at install. Everything `enablePlugin` refuses is
 * refused here too — master off, blocked, or an install whose fingerprint is
 * not the approved one — and a plugin that fails to start stays off rather
 * than stopping the boot. What is on disk is not re-hashed here: installing
 * and updating are the only writers of that folder, and both re-derive it.
 */
export async function resumeEnabledPlugins(): Promise<string[]> {
  const store = read();
  if (!store.master) return [];
  const started: string[] = [];
  for (const rec of store.plugins) {
    if (!rec.enabled || !rec.approvedFingerprint || rec.approvedFingerprint !== rec.fingerprint) continue;
    if (blockedEntry(rec.name)) continue;
    try {
      await startProcess(withContributes(rec));
      started.push(rec.name);
    } catch {
      /* one bad plugin must not keep the others down */
    }
  }
  return started;
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
    const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, env: pluginGitEnv(), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Put `url` at `ref` into `staging`, an empty directory.
 *
 * A branch, a tag or nothing is a shallow clone, as it always was. A full
 * commit id is fetched by id — `git clone --branch` refuses one, so before
 * this no entry could be pinned to a commit at all — and the result is
 * checked to be that commit, because a fetch that quietly landed somewhere
 * else would install something nobody named.
 *
 * `sha256`, when a catalogue gave one, is then compared with the tree's
 * content hash by the same walk `finishInstall` does, and a mismatch is
 * refused before anything is copied or recorded.
 */
async function fetchInto(staging: string, url: string, ref: string | null, sha256?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const TEN_MINUTES = 10 * 60 * 1000;
  if (ref && FULL_COMMIT.test(ref)) {
    for (const args of [["init", "-q"], ["fetch", "-q", "--depth", "1", "--", url, ref], ["checkout", "-q", "--detach", "FETCH_HEAD"]]) {
      const r = await git(args, staging, TEN_MINUTES);
      if (!r.ok) return { ok: false, error: r.err || `git ${args[0]} failed` };
    }
    const head = await resolveHead(staging);
    if (head !== ref) return { ok: false, error: `asked for ${ref} and the fetch resolved to ${head ?? "nothing"}` };
  } else {
    const args = ["clone", "--depth", "1"];
    if (ref) args.push("--branch", ref);
    args.push("--", url, staging);
    const r = await git(args, tmpdir(), TEN_MINUTES);
    if (!r.ok) return { ok: false, error: r.err || "git clone failed" };
  }
  if (sha256) {
    const walked = walkPluginDir(staging);
    if (!walked.ok) return { ok: false, error: walked.error ?? "plugin folder rejected" };
    const got = contentHash(staging, walked.files);
    if (got !== sha256) {
      return { ok: false, error: `not what the catalogue listed: the files at ${ref ?? "the default branch"} hash to ${got.slice(0, 12)}…, the catalogue says ${sha256.slice(0, 12)}…` };
    }
  }
  return { ok: true };
}

/** What the copy into place carries: files, folders and links, the entries
 *  the walk reads. A socket or a pipe in a folder in use is left behind, as
 *  the walk leaves it, rather than failing the copy the way `cpSync` does. */
function copied(src: string): boolean {
  try {
    const st = lstatSync(src);
    return st.isFile() || st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
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
  /** The name somebody chose — a catalogue entry's id — which the manifest
   *  that arrived must carry, and which names the folder. Without it the
   *  folder was named by the manifest alone, so a listed entry whose
   *  repository said another plugin's name installed over that plugin. */
  expectName?: string,
): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  const manifestPath = join(staging, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { ok: false, error: `No ${MANIFEST_NAME} at the root of that plugin` };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return { ok: false, error: `${MANIFEST_NAME} is not valid JSON` }; }
  const manifest = validateManifest(raw);
  if (typeof manifest === "string") return { ok: false, error: manifest };
  if (expectName !== undefined && manifest.name !== expectName) {
    return { ok: false, error: `the catalogue lists "${expectName}" and the plugin it fetched is named "${manifest.name}"; nothing was installed` };
  }
  /*
   * A plugin that needs a newer app is refused here rather than installed and
   * left off. Half of what a plugin declares is where it draws, and a surface
   * this app does not have is not a setting somebody can switch on — it is a
   * panel that never appears, with nothing saying why.
   */
  if (manifest.minApp && !versionAtLeast(appVersion(), manifest.minApp)) {
    return { ok: false, error: `${manifest.name} needs agentglass ${manifest.minApp} or newer, and this is ${appVersion()}` };
  }

  const walked = walkPluginDir(staging);
  if (!walked.ok) return { ok: false, error: walked.error ?? "plugin folder rejected" };
  const content = contentHash(staging, walked.files);
  const fingerprint = consentFingerprint(manifest, content);

  const installDir = pluginInstallDir(expectName ?? manifest.name);
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
  // The app's own copy, not `cp`, which Windows does not have; a link is
  // copied as the link it is, not rewritten to where it pointed in staging.
  try { cpSync(staging, installDir, { recursive: true, verbatimSymlinks: true, filter: copied }); } catch (e) {
    rmSync(installDir, { recursive: true, force: true });
    return { ok: false, error: `could not copy the plugin into place: ${e instanceof Error ? e.message : String(e)}` };
  }

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
    ...(existing?.settings ? { settings: existing.settings } : {}),
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
      // The folder's contents, through a link if the path is one, as
      // `cp -R path/.` did before the copy stopped needing `cp`.
      try { cpSync(realpathSync(source.path), staging, { recursive: true, verbatimSymlinks: true, filter: copied }); } catch (e) {
        return { ok: false, error: `could not copy that folder: ${e instanceof Error ? e.message : String(e)}` };
      }
    } else {
      const r = await fetchInto(staging, source.url, source.ref);
      if (!r.ok) return r;
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
  /** For the test, which serves the catalogue itself — see fetchCatalogue. */
  guard: GuardedFetchOptions = {},
): Promise<{ ok: true; plugin: PublicPlugin } | { ok: false; error: string }> {
  const fetched = await fetchCatalogue(catalogueUrl, guard);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const entry = fetched.catalogue.plugins.find((p) => p.id === pluginId);
  if (!entry) return { ok: false, error: `No plugin "${pluginId}" in that catalogue` };
  // The id names the folder, so it is held to a plugin name's rule before a
  // byte is fetched: a catalogue id may be 120 characters of anything.
  if (!validPluginName(entry.id)) return { ok: false, error: `"${pluginId.slice(0, 60)}" is not a name a plugin can be installed under` };

  const staging = mkdtempSync(join(tmpdir(), "agx-plugin-"));
  try {
    const r = await fetchInto(staging, entry.source.url, entry.source.ref, entry.sha256);
    if (!r.ok) return r;
    const resolvedCommit = await resolveHead(staging);
    const source: InstallSource = {
      kind: "marketplace",
      marketplace: { url: catalogueUrl, ref: null, resolvedCommit },
      plugin: { url: entry.source.url, ref: entry.source.ref, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) },
    };
    return await finishInstall(staging, source, entry.id);
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
  const { url, ref, sha256 } = existing.source.kind === "git"
    ? { url: existing.source.url, ref: existing.source.ref, sha256: undefined }
    : { url: existing.source.plugin.url, ref: existing.source.plugin.ref, sha256: existing.source.plugin.sha256 };

  const staging = mkdtempSync(join(tmpdir(), "agx-plugin-"));
  try {
    const r = await fetchInto(staging, url, ref, sha256);
    if (!r.ok) return r;
    // Updated in place: whatever arrives must still be the plugin that is
    // installed here, or it would land in another plugin's folder.
    return await finishInstall(staging, existing.source, existing.name);
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
/**
 * Switch a plugin on, which is also the act of approving what it declares.
 *
 * `approved` is the caller saying it has SHOWN the declaration to somebody.
 * The window has: the card lists the scope and every place the plugin draws,
 * and an update that changes any of it turns the switch into a confirm that
 * names what changed. A terminal has not — `agentglass-plugin enable` was a
 * one-line way to grant a new manifest's scope with nobody having read it,
 * which is the whole gate this system rests on, opened from outside the room
 * it was built in.
 *
 * So: a plugin whose declaration has never been approved, or whose
 * declaration changed since it was, is refused unless the caller says it
 * showed it. The window passes true because it did; the CLI passes it only
 * for `--approve`, which prints the declaration first.
 */
export async function enablePlugin(name: string, approved = true): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return { ok: false, error: "no such plugin" };
  if (!store.master) return { ok: false, error: "plugins are switched off — flip the master switch first" };
  const block = blockedEntry(name);
  if (block) return { ok: false, error: `blocked: ${block.reason}${block.link ? ` (${block.link})` : ""}` };
  if (!approved && rec.approvedFingerprint !== rec.fingerprint) {
    return {
      ok: false,
      error: rec.hadApproval
        ? "what this plugin declares has changed since you approved it — read it and enable it again with --approve, or switch it on in Settings ▸ Plugins"
        : "switching it on approves the scope and the places it draws — read them and enable it with --approve, or switch it on in Settings ▸ Plugins",
    };
  }
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
  dropNotesOf(name);
  // Also when it was not running: a plugin installed later under the same
  // name must not inherit a queue of this one's events.
  forgetPlugin(name);
  return true;
}

/** Test seam: wipe the store, the on-disk folder, and any running process. */
export async function __resetPlugins(): Promise<void> {
  for (const name of [...running.keys()]) await stopRunning(name);
  write({ master: true, plugins: [] });
  try { rmSync(join(pluginsConfigDir(), "plugins"), { recursive: true, force: true }); } catch { /* nothing to clear */ }
}
