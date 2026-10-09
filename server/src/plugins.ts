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
  closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mintPluginToken, revokePluginToken } from "./auth.ts";
import { dropCanvases } from "./plugin-canvas.ts";
import type { Scope } from "./devices.ts";
import { cloneUrlError } from "./projectadd.ts";
import {
  type InstallSource, FULL_COMMIT, contentHash, expandHome, pluginGitUrlError, pluginRefError, walkPluginDir,
} from "./plugin-sources.ts";
import { pluginGitEnv, PLUGIN_GIT_CONFIG } from "./plugin-env.ts";
import { fetchCatalogue } from "./plugin-catalogue.ts";
import type { GuardedFetchOptions } from "./net.ts";
import { blockedEntry, type BlockEntry } from "./plugin-blocklist.ts";
import { type Contributes, type Field, RESERVED_KEYS, redactSecrets, validateContributes } from "../../shared/pluginUi.ts";
import { type PluginSandbox, validateSandbox } from "../../shared/pluginSandbox.ts";
import {
  hostResolvConfExtraRo, hostSystemPaths, openGrantFds, pluginDataDir, removePluginDataDir, resolveGrants,
  resolvePrograms, sandboxArgv, sandboxProbe, type SandboxProbe,
} from "./plugin-sandbox.ts";
import { ensurePluginSocketServer, pluginSocketPath, stopPluginSocketServer } from "./plugin-socket.ts";
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
  /** What it asks to be given inside a box. Absent means it asked for nothing
   *  and runs as it always did; a block, even an empty one, is a declaration
   *  the reviewer approves. Declared only: nothing enforces it yet. */
  sandbox?: PluginSandbox;
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
 * copy turns into something git reads. `__proto__`, `constructor` and
 * `prototype` are refused because the name is also a key of plain objects
 * (the store, the secrets), where the first is the object's prototype.
 */
export function validPluginName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name) && name !== "." && name !== ".." && !name.startsWith(".") && !RESERVED_KEYS.has(name);
}
const MAX_TEXT = 500;
const NO_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Shape-checked entry by entry, the same discipline `panelease.ts` uses for
 * the lease file it reads at startup: a bad field loses the plugin rather
 * than being coerced into something wider than what was actually declared.
 * Returns the error sentence to show the reviewer, or the manifest.
 */
/** The block a manifest runs under: its own, or the default box when it has
 *  none. Shared by the hash and the validator so the two cannot disagree about
 *  what an unboxed-looking manifest was approved as. */
function defaultedSandbox(raw: unknown): PluginSandbox {
  const r = validateSandbox(raw === undefined ? {} : raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

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
  // No block is the default box, not "no box": an author who says nothing gets
  // the plugin's own folder and the app's own address, and nothing else. It is
  // filled in HERE, before the hash, so the approval a plugin held before boxes
  // were the default no longer matches and is asked for again, with the grants
  // it now runs under shown. Ceiling: there is no per-plugin switch to run
  // outside the box on a host that HAS one; a host that cannot build one
  // refuses to start the plugin unless allowUnboxed consent (or the
  // machine-wide escape hatch) says otherwise — see startProcess.
  const r = validateSandbox(m.sandbox === undefined ? {} : m.sandbox);
  if (!r.ok) return r.error;
  const sandbox: PluginSandbox = r.value;
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
    sandbox,
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
    // What it asks to be given is what was approved, so a grant that grows
    // asks again. A manifest with no block is hashed as the default box, the
    // same as an empty one.
    sandbox: defaultedSandbox(m.sandbox),
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
  /**
   * Explicit, per-plugin, revocable consent to run WITHOUT the box on a host
   * that cannot build one. Declaring `sandbox` used to be decoration on such
   * a host: the plugin ran exactly as if it had never declared it, behind a
   * warning nobody had to read. Absent or `false` means the safer default —
   * refuse to start rather than widen the grant silently — and only a human
   * flipping this (or the machine-wide `AGENTGLASS_PLUGINS_UNBOXED=1`, for a
   * host where every plugin's install is already trusted) turns it back on.
   */
  allowUnboxed?: boolean;
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
interface Store {
  master: boolean;
  plugins: PluginRecord[];
  /** Settings of plugins that were uninstalled, by name and then by where
   *  the plugin came from, waiting for a reinstall to pick them up. What a person typed into a settings page is
   *  theirs, not the plugin's: removing a plugin to reinstall a fresh copy
   *  must not reset a prompt they spent an afternoon on. Dropped only when
   *  the removal asks for it.
   *
   *  The inner key is `sourceKey`. A name is not an identity — a different
   *  plugin from another repository can be installed under the same one, and
   *  it would read back whatever was typed for the first (a token field is a
   *  plausible key in both). Only a reinstall from the same place inherits
   *  them, and each source keeps its own: one entry per name let the second
   *  plugin's uninstall write its settings over the first's. */
  keptSettings?: Record<string, Record<string, Record<string, unknown>>>;
}
const DEFAULT_STORE: Store = { master: true, plugins: [] };

/** A record written before boxes were the default has no `sandbox`, and would
 *  otherwise go on running unboxed with the approval it already holds. It gets
 *  the default box and loses that approval, so it is asked for again with the
 *  grants it now runs under shown — the same thing a manifest with no block
 *  gets on install (see `validateManifest`). Idempotent: once saved it has a
 *  block and passes through untouched. */
function boxedByDefault(rec: PluginRecord): PluginRecord {
  return rec.sandbox ? rec : { ...rec, sandbox: defaultedSandbox(undefined), approvedFingerprint: null };
}

function read(): Store {
  const p = pluginsPath();
  if (offLimits(p) || !existsSync(p)) return { ...DEFAULT_STORE, plugins: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Store>;
    const kept = parsed.keptSettings;
    const store: Store = {
      master: typeof parsed.master === "boolean" ? parsed.master : true,
      // A record on disk is trusted no more than a manifest: one named for a
      // property every object has (a hand edit, a build before the rule) is left
      // out rather than let its name act as a property of another object.
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins.filter((r) => r && typeof r === "object" && typeof r.name === "string" && !RESERVED_KEYS.has(r.name)).map(boxedByDefault) : [],
      ...(kept && typeof kept === "object" && !Array.isArray(kept) ? { keptSettings: kept } : {}),
    };
    return moveSecretsOut(store);
  } catch {
    // A corrupt file must not take the server down on boot — same rule
    // devices.ts follows. The cost is every plugin needs re-installing.
    return { ...DEFAULT_STORE, plugins: [] };
  }
}

/**
 * One-time move of the keys an older build kept inside `plugins.json`, run on
 * every read and a no-op once nothing is left to move. `secrets.json` is
 * written first and read back, and only then does `plugins.json` lose the key,
 * so a failed write (a full disk, a path that is a directory) or a crash
 * between the two leaves the key in plugins.json or in both files, never in
 * neither; the store comes back unmigrated and the next read tries again.
 *
 * The copy in `plugins.json` wins over one `secrets.json` already holds. This
 * build never writes a key there, so one found there was put there by an older
 * build sharing the config folder (a downgrade, an installed app beside a dev
 * server), after this build moved the first one: the newer value. A crash
 * between the two writes leaves the same value in both, so nothing is lost
 * either way. Nothing about a value is logged.
 *
 * It never throws: `read()` takes a throw for "plugins.json is not JSON" and
 * returns an empty store that the next write would save over every plugin and
 * approval, so a record this cannot make sense of is a reason not to migrate.
 */
function moveSecretsOut(store: Store): Store {
  try { return migrate(store); } catch { return store; }
}

function migrate(store: Store): Store {
  const inRecord = (rec: PluginRecord): string[] => {
    const held = rec.settings;
    return held && typeof held === "object" ? secretKeysOf(rec.contributes?.settings).filter((k) => Object.hasOwn(held, k)) : [];
  };
  if (!store.plugins.some((rec) => inRecord(rec).length)) return store;
  const stripped = (rec: PluginRecord): PluginRecord => (inRecord(rec).length ? { ...rec, settings: withoutSecrets(rec.contributes?.settings, rec.settings) } : rec);
  // plugins.json could not be rewritten the last time: its copy is stale
  // (secrets.json may have moved on since), so it is neither moved again nor
  // trusted; the store goes out stripped and the strip is retried by a write.
  if (stripPending) return { ...store, plugins: store.plugins.map(stripped) };
  const secrets = loadSecrets();
  if (!secrets) return store; // a rewrite from a failed read would lose the other plugins' keys
  const moving: [string, string, string][] = [];
  const plugins = store.plugins.map((rec) => {
    for (const k of inRecord(rec)) {
      const v = rec.settings![k];
      if (typeof v === "string" && v !== "") { (secrets[rec.name] ??= table())[k] = v; moving.push([rec.name, k, v]); }
    }
    return stripped(rec);
  });
  if (moving.length) {
    if (!writeAtomic(secretsPath(), secrets)) return store;
    const back = readSecrets();
    if (!moving.every(([name, k, v]) => back[name]?.[k] === v)) return store;
  }
  const moved = { ...store, plugins };
  // The keys are in secrets.json and read back, so the store is right either
  // way; what a failed write leaves behind is a stale copy on disk (see above).
  if (!write(moved)) stripPending = true;
  return moved;
}

/** True from the moment a read moved a key into `secrets.json` and could not
 *  take it out of `plugins.json`, until a write of plugins.json lands. While it
 *  is set the old value is still on disk there, and the next start would take
 *  it back over whatever `secrets.json` holds by then: a key rotated or deleted
 *  in between would come back. So reads stop retrying (each retry rewrote and
 *  fsynced secrets.json), and nothing may change a key until the strip has
 *  been written (`settleStrip`, which every caller of `putSecrets` runs first).
 *
 *  The ceiling: the flag is in memory. A restart forgets it, which is safe only
 *  because both files hold the same value for as long as it was set; a key
 *  changed by another process meanwhile (an older build sharing the folder)
 *  is the case it does not cover. */
let stripPending = false;

function write(store: Store): boolean {
  const ok = writeAtomic(pluginsPath(), store);
  if (ok) stripPending = false;
  return ok;
}

/** The store a read hands out is already stripped of keys, so writing it IS the
 *  retry of a strip that failed. A caller about to change a key runs this
 *  first; false means plugins.json still holds the old value and the key must
 *  not be changed. */
function settleStrip(store: Store): boolean {
  return !stripPending || write(store);
}


/** Written beside the file and renamed over it: a crash half way leaves the old
 *  file whole, where truncate-then-write left invalid JSON that `read` takes for
 *  an empty store — every plugin, approval and secret gone on the next write.
 *  The mode is set on the file that is kept, not only when it is created: a
 *  file restored from a backup at 0644 would otherwise stay readable by
 *  everyone after a key is stored in it. Whether it worked is the answer: a
 *  caller that is about to delete the only other copy of a value needs to know. */
function writeAtomic(p: string, data: unknown): boolean {
  if (offLimits(p)) return false;
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    // A file or a link already at the temp name (left by a crash, or put there)
    // would keep its own mode while the key is written into it, or send the
    // key to wherever the link points. Removed first and created with `wx`
    // (O_EXCL, which never follows a link), so what is written is a new file
    // that is 0600 (umask only narrows it) before it holds anything.
    try { unlinkSync(tmp); } catch { /* none there */ }
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, JSON.stringify(data, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * Where the values of `secret` fields live: `secrets.json`, beside
 * `plugins.json`, `{ <plugin name>: { <field key>: <value> } }`.
 *
 * It exists so a secret has exactly one reader. `plugins.json` is the file the
 * approvals, fingerprints and settings live in, and more code reads it than
 * ever needs a key (the config browser, exports, a support paste); this one is
 * read by `pluginOwnSettings` and nothing else. A box never mounts the config
 * directory, so a boxed plugin cannot open either file, and the broker names
 * the plugin from its token, so plugin A cannot ask for B's.
 *
 * The ceiling: a plugin that runs unboxed, or any program running as the same
 * user, can still read this file. Moving the value out of `plugins.json` does
 * not stop a same-uid process; it stops every other reader of `plugins.json`.
 */
export function secretsPath(): string {
  return join(pluginsConfigDir(), "secrets.json");
}
type Secrets = Record<string, Record<string, string>>;

/** An object with no prototype, for a table keyed by names a plugin chose:
 *  `table["__proto__"]` is then an entry like any other. */
const table = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** null when the file is there and could not be read (EIO, EACCES, EMFILE):
 *  what it holds is unknown, which is not the same as nothing. A caller that
 *  decides about a key, or rewrites the file, stops on null; a plain read takes
 *  it for empty (`readSecrets`). A file that reads but is not JSON holds no key
 *  anyone can be served, so it stays empty; a rewrite then drops the others'
 *  keys, which is availability and not a leak. */
function loadSecrets(): Secrets | null {
  const p = secretsPath();
  if (offLimits(p)) return table();
  let text: string;
  try { text = readFileSync(p, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? table() : null; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return table();
    const out: Secrets = table();
    for (const [name, byKey] of Object.entries(parsed as Record<string, unknown>)) {
      if (!byKey || typeof byKey !== "object" || Array.isArray(byKey)) continue;
      const held = table<string>();
      for (const [k, v] of Object.entries(byKey as Record<string, unknown>)) if (typeof v === "string" && v !== "") held[k] = v;
      if (Object.keys(held).length) out[name] = held;
    }
    return out;
  } catch {
    return table();
  }
}

/** Unreadable is empty, as `read` does for plugins.json: the cost is each key
 *  is asked for again, never a crash on boot. */
const readSecrets = (): Secrets => loadSecrets() ?? table();

/** Set one plugin's keys (none drops its entry) and write the file. */
function putSecrets(all: Secrets, name: string, held: Record<string, string>): boolean {
  if (Object.keys(held).length) all[name] = held; else delete all[name];
  return writeAtomic(secretsPath(), all);
}

const secretKeysOf = (fields: Field[] | undefined): string[] =>
  (Array.isArray(fields) ? fields : []).filter((f) => f?.type === "secret" && typeof f.key === "string" && !RESERVED_KEYS.has(f.key)).map((f) => f.key);

/** What one plugin holds, for the keys its manifest still declares as secret. */
function secretValuesOf(name: string, fields: Field[] | undefined): Record<string, string> {
  const keys = secretKeysOf(fields);
  if (!keys.length) return {}; // most plugins declare none: no second file to read
  const held = readSecrets()[name] ?? {};
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(held, k)).map((k) => [k, held[k]]));
}

/** A plugin's stored settings with its keys put back, for the readers that hand
 *  them to the plugin or redact them straight away. */
function settingsWithSecrets(rec: PluginRecord): Record<string, unknown> {
  return resolveSettings(rec.contributes?.settings, { ...rec.settings, ...secretValuesOf(rec.name, rec.contributes?.settings) });
}

/** Keep only `keys` of one plugin's secrets (none by default) and write when
 *  that changed anything — a revoke, a retype, a remove, a replacement. False
 *  when a key that had to go is still on disk: the caller then stops, because
 *  carrying on would hand the old key to whatever is installed next under this
 *  name. */
function keepSecrets(store: Store, name: string, keys: string[] = []): boolean {
  if (!settleStrip(store)) return false;
  const all = loadSecrets();
  if (!all) return false;
  const held = all[name];
  if (!held) return true;
  const kept = Object.fromEntries(Object.entries(held).filter(([k]) => keys.includes(k)));
  return Object.keys(kept).length === Object.keys(held).length || putSecrets(all, name, kept);
}

/** The settings without the values of fields that are `secret` in `fields`. */
function withoutSecrets(fields: Field[] | undefined, settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!settings) return settings;
  const secret = secretKeysOf(fields);
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !secret.includes(k)));
}

/** A key that was a secret and is not any more must not carry its value into a
 *  field that is drawn and served in the clear. */
function withoutRetypedSecrets(prev: Field[] | undefined, next: Field[] | undefined, settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const still = secretKeysOf(next);
  return withoutSecrets((prev ?? []).filter((f) => !still.includes(f.key)), settings);
}

/**
 * Whether the process actually running is inside a bwrap box, and why not
 * when it isn't. `no-block` is a plugin declaring nothing — not a failure of
 * anything, just "there is no box to build" — the other three are
 * `SandboxProbe`'s reasons, carried through so the reviewer sees exactly
 * what the app saw rather than a generic "unboxed". `refused` is a grant or
 * program that resolved but was still turned away (a symlink, a live
 * socket dir) — boxed and true either way, but worth a red line rather than
 * silence.
 */
export type BoxState =
  | { kind: "boxed"; refused?: { path: string; why: string }[] }
  | { kind: "unboxed"; reason: "no-block" | "missing" | "userns-blocked" | "failed"; detail?: string };

/** Live process state, deliberately never persisted. A pid and a token are
 *  only meaningful for the process that holds them; a server restart cannot
 *  hand either back, so it starts with nothing running and
 *  `resumeEnabledPlugins` starts each enabled plugin again with a new token. */
interface Running { proc: ReturnType<typeof Bun.spawn>; token: string; pid: number; boxState: BoxState }
const running = new Map<string, Running>();
setLivenessCheck((name) => running.has(name));

/**
 * A box that died in its first moments — bwrap itself refusing to mount
 * something, not the plugin's own code — with nowhere left to report once
 * `running` has already dropped the entry. Keyed by name, cleared at the
 * start of every new attempt so a failure never outlives the run after it.
 */
const lastBoxFailure = new Map<string, string>();
const BOX_GRACE_MS = 2000;
const STDERR_CAP = 2048;

/** Reads `stderr` up to `STDERR_CAP` bytes and cancels the stream once
 *  either that cap or the process's own exit is reached — this is not log
 *  capture, only enough to explain a bwrap mount failure that happens in
 *  the first instant of a boxed start. */
async function captureFirstStderrLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (bytes < STDERR_CAP) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      bytes += value.length;
    }
  } catch {
    /* stream errored (process reaped, pipe closed): use whatever arrived */
  } finally {
    try { await reader.cancel(); } catch { /* already done */ }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8", 0, STDERR_CAP);
  return text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

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
  stopPluginSocketServer();
}

function serverBase(): string {
  return `http://127.0.0.1:${Number(process.env.AGENTGLASS_PORT || 4000)}`;
}

/**
 * How to re-invoke this app as `agentglass-server plugin-bridge …` from
 * inside a `network: "agentglass"` box (see cookieentry.ts, which answers
 * that argument the same way it already answers `cookies`).
 *
 * `Bun.main` is a compiled build's own entry, never a `.ts` path — `bun
 * server/src/index.ts` in dev always ends in one. Dev re-runs `bun
 * <that file>`; a compiled build re-runs the sidecar binary itself
 * (`process.execPath`), since the binary already contains index.ts and
 * everything it imports, cookieentry.ts included.
 */
function bridgeExecCommand(): string[] {
  return Bun.main.endsWith(".ts") ? [process.execPath, Bun.main] : [process.execPath];
}

/**
 * What has to be readable inside the box for `bridgeExecCommand()`'s own
 * argv to actually exec — one more read-only path the box needs, never
 * anything a plugin declared, bound after the tmpfs over HOME and /tmp. A compiled build's argv is one file: the
 * sidecar binary itself, self-contained. Dev's `bun <index.ts>` needs the
 * whole repository read — `import type` lines get stripped before bun ever
 * asks the filesystem for their target, but plenty of the OTHER imports
 * index.ts pulls in are not type-only, and they resolve relative to files
 * under `shared/`, a sibling of `server/`, not under it — so the bound root
 * is the repository, not just `server/`. Never node_modules-only: the
 * `plugin-bridge` subcommand exits in cookieentry.ts, its very first import,
 * before index.ts's own (non-type) imports — the ones that would reach
 * `node_modules` — are ever evaluated.
 */
function bridgeExtraRo(bridgeExec: string[]): string[] {
  const paths = [bridgeExec[0]!];
  if (bridgeExec[1]) paths.push(resolve(dirname(bridgeExec[1]), "..", ".."));
  return paths;
}

/**
 * Turn an approved `sandbox` block plus what the host filesystem actually
 * looks like into the exact argv bwrap runs with, and the open descriptors
 * that argv's `--ro-bind-fd`/`--bind-fd` entries name. Everything impure —
 * the probe, walking `/etc`/`/opt`/the split-usr directories, resolving
 * `~/…` grants and `programs` against the real filesystem, and opening each
 * grant right before the spawn that will use it — happens here, once per
 * start; `sandboxArgv` itself never touches disk.
 *
 * `parentFds` must be closed by the caller once `Bun.spawn` has returned:
 * they exist only to be duplicated into the child at spawn time.
 */
/**
 * What `extraRo` is for a box, given whether it has a `network` input built
 * already. Pulled out of `buildBoxArgv` as its own exported, pure function so
 * the decision is directly testable — `buildBoxArgv` itself boots a real
 * plugin socket and is not something a unit test can call, which is exactly
 * how a reverted version of this one line (every box, networked or not, got
 * the host resolver mounted) shipped once without a red test noticing.
 *
 * A `network: "agentglass"` box has no interface but its own loopback
 * (`--unshare-net`, see sandboxArgv) and no resolver to reach: the host's
 * resolve socket at /run/systemd/resolve answers over varlink, not DNS, so
 * mounting it in anyway turned the box into a name-resolution oracle for the
 * open internet — measured with varlinkctl's own ResolveHostname call
 * returning real addresses from inside a box whose curl could not resolve
 * anything. Only a box with no network gets the host resolver.
 */
export function boxExtraRo(network: unknown): string[] {
  return network ? [] : hostResolvConfExtraRo();
}

async function buildBoxArgv(
  rec: PluginRecord,
  sandbox: PluginSandbox,
  bwrap: string,
  dataDir: string,
): Promise<{ argv: string[]; parentFds: number[]; refused: { path: string; why: string }[] }> {
  const home = process.env.HOME ?? homedir();
  const grants = resolveGrants(sandbox, home);
  const programs = resolvePrograms(sandbox.programs, process.env.PATH ?? "", home);
  const { systemDirs, systemLinks } = hostSystemPaths();
  // The socket has to exist before bwrap tries to bind-mount it — started
  // here, once per box, rather than at server boot: most installs never
  // enable a `network: "agentglass"` plugin at all, and a listener nothing
  // ever dials is one more thing to explain in a process list. Awaited, and
  // BEFORE `openGrantFds` below: a second instance's live socket at this
  // same path is only knowable by actually connecting to it (see
  // `ensurePluginSocketServer`), and that throwing here is deliberate — the
  // plugin's start fails loudly rather than boxing it against another
  // instance's socket. Ordered ahead of the fd opens so that throw can
  // never leave this plugin's own grant descriptors open with nothing left
  // to close them (they used to be opened first, and a start refused over a
  // live socket leaked them on every refusal).
  let network: { socketHostPath: string; bridgeExec: string[]; bridgeRo: string[] } | undefined;
  if (sandbox.network === "agentglass") {
    await ensurePluginSocketServer();
    network = { socketHostPath: pluginSocketPath(), bridgeExec: bridgeExecCommand(), bridgeRo: bridgeExtraRo(bridgeExecCommand()) };
  }
  const opened = openGrantFds({ read: grants.read, write: grants.write }, home);
  const argv = sandboxArgv({
    bwrap,
    installDir: rec.installDir,
    dataDir,
    home,
    entrypoint: rec.entrypoint,
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_URL: serverBase() },
    sandbox,
    grants: { read: opened.read, write: opened.write },
    programDirs: programs.dirs,
    systemLinks,
    systemDirs,
    network,
    extraRo: boxExtraRo(network),
  });
  return { argv, parentFds: opened.parentFds, refused: [...grants.refused, ...programs.refused, ...opened.refused] };
}

/**
 * Start the entrypoint as its own process, with its own scoped token.
 *
 * The env object is built by hand rather than spread from `process.env` on
 * purpose — that is the exact mistake `auth.ts` documents having made once
 * already for launched agents: "They inherit the process environment, which
 * carries the MACHINE token." A plugin gets `PATH`/`HOME` to find its own
 * runtime and no token but its own. It is still a process of the user's: what
 * that process can reach on disk is not limited by the scope.
 */
async function startProcess(rec: PluginRecord): Promise<void> {
  await stopRunning(rec.name);
  // Belt and braces: `enablePlugin` already refuses a blocked key, but this
  // is the one place a process actually starts, so it is the one place a
  // block can never be bypassed by a path that forgets to check first.
  if (blockedEntry(rec.name)) return;
  lastBoxFailure.delete(rec.name);
  // A run starts on an empty board, whatever the last one left.
  dropCanvases(rec.name);
  const token = mintPluginToken(rec.scope, rec.name);
  // Whether or not the plugin ends up boxed, it gets a folder of its own —
  // the same folder every time, so a plugin that writes state today can
  // read it back after a box that could not build, or after this host gets
  // bwrap installed.
  const dataDir = pluginDataDir(rec.name);
  let argv: string[] = ["bash", "-c", rec.entrypoint];
  let boxState: BoxState = { kind: "unboxed", reason: "no-block" };
  let parentFds: number[] = [];
  if (rec.sandbox) {
    const probe = sandboxProbe();
    if (probe.ok) {
      let built: Awaited<ReturnType<typeof buildBoxArgv>>;
      try {
        built = await buildBoxArgv(rec, rec.sandbox, probe.bwrap, dataDir);
      } catch (e) {
        // `ensurePluginSocketServer` refusing a live socket another instance
        // owns is the one way this throws today. Running THIS plugin unboxed
        // instead would widen exactly what `network: "agentglass"` declares
        // it needs boxed away from, so the start fails rather than falling
        // back — the same shape `blockedEntry` already returns early for.
        const detail = e instanceof Error ? e.message : String(e);
        lastBoxFailure.set(rec.name, detail);
        console.warn(`[plugin sandbox] ${rec.name}: could not build the box: ${detail}`);
        return;
      }
      argv = built.argv;
      parentFds = built.parentFds;
      boxState = built.refused.length > 0 ? { kind: "boxed", refused: built.refused } : { kind: "boxed" };
      for (const r of built.refused) console.warn(`[plugin sandbox] ${rec.name}: refused ${r.path}: ${r.why}`);
    } else if (mayRunUnboxed(rec)) {
      // `process.platform !== "linux"` first, and unconditional: bwrap is a
      // Linux mechanism, so on macOS/Windows `sandboxProbe()` fails with
      // "missing" for every single plugin, always — there is no box to
      // consent AWAY from there, unlike Linux where "missing"/"userns-
      // blocked" is usually a fixable local policy. Refusing by default
      // would not defend anything (there was never a box on these
      // platforms to widen past) and would silently stop every plugin at
      // the first boot after this ships. This is exactly the condition
      // it replaces, unchanged for those two platforms.
      // The host cannot build the box, and a human (or the machine-wide
      // escape hatch) has explicitly said this plugin may run anyway: the
      // plugin runs exactly as it would with no `sandbox` block at all,
      // behind the same red PROCESS_WARNING the declaration screen already
      // shows — the app tells the reviewer why, rather than silently
      // widening the grant.
      boxState = { kind: "unboxed", reason: probe.reason, detail: probe.detail };
    } else {
      // The host cannot build the box and nobody has said this plugin may
      // run without it: refuse to start rather than run it wide open behind
      // a warning the reviewer may never scroll to. `enabled` stays true —
      // this is the same shape as a crashed plugin, not an uninstall — so
      // turning on `allowUnboxed` (POST /plugins/allow-unboxed — no Settings
      // UI for this yet) or fixing the host
      // (installing bwrap, etc.) picks it back up without reinstalling.
      console.warn(
        `[plugin sandbox] ${rec.name}: refused to start unboxed (${probe.reason}) — ` +
        `this host cannot build the box it declared; allow it explicitly per plugin, ` +
        `or set AGENTGLASS_PLUGINS_UNBOXED=1 for every plugin, to run it anyway`
      );
      lastBoxFailure.set(rec.name, `refused to run unboxed: ${probe.reason}${probe.detail ? ` (${probe.detail})` : ""}`);
      // The token above was minted for a process that is not going to exist;
      // a refused start must not be the one path that leaves a live,
      // unrevoked credential behind, one more per boot or retry.
      revokePluginToken(token);
      return;
    }
  }
  const boxed = boxState.kind === "boxed";
  try {
    const proc = Bun.spawn(argv, {
      // Its own process group, so stopping it stops everything it started.
      detached: true,
      cwd: rec.installDir,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        AGENTGLASS_READ_TOKEN: token,
        AGENTGLASS_URL: serverBase(),
        AGENTGLASS_PLUGIN_DATA: dataDir,
      },
      // Extra fds for the box's `--ro-bind-fd`/`--bind-fd` grants — index 3
      // onward, matching the child fd numbers `sandboxArgv` was given. A
      // boxed start also pipes stderr, but ONLY long enough to catch bwrap
      // itself failing to mount something in the first instant; see
      // `captureFirstStderrLine`, which cancels the stream well short of
      // becoming a general log capture this app has never done.
      stdio: ["ignore", "ignore", boxed ? "pipe" : "ignore", ...parentFds],
    });
    for (const fd of parentFds) { try { closeSync(fd); } catch { /* already closed by the dup */ } }
    const startedAt = Date.now();
    if (boxed && proc.stderr instanceof ReadableStream) {
      captureFirstStderrLine(proc.stderr).then((line) => {
        if (line && Date.now() - startedAt < BOX_GRACE_MS) lastBoxFailure.set(rec.name, line);
      });
    }
    const entry: Running = { proc, token, pid: proc.pid, boxState };
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
    for (const fd of parentFds) { try { closeSync(fd); } catch { /* fine */ } }
    throw e;
  }
}

export { pluginGitEnv, PLUGIN_GIT_CONFIG };

/**
 * Every git a plugin install runs. The line endings are pinned because a
 * catalogue's hash is taken over the bytes a checkout writes: Git for Windows
 * installs with core.autocrlf on, and a checkout that turned every text file
 * to CRLF hashed to something no catalogue had listed. A plugin's own
 * `.gitattributes` still decides, the same way on every machine.
 */
async function git(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; err: string }> {
  try {
    const p = Bun.spawn(["git", ...PLUGIN_GIT_CONFIG, "-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], { cwd, env: pluginGitEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, timeoutMs);
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    clearTimeout(timer);
    return code === 0 ? { ok: true, err: "" } : { ok: false, err: err.trim().split("\n").slice(-3).join(" ").slice(0, 400) };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export type PublicSandboxProbe = { ok: true } | { ok: false; reason: Extract<SandboxProbe, { ok: false }>["reason"]; detail: string };

export type PublicPlugin = PluginRecord & {
  running: boolean;
  pid: number | null;
  boxState?: BoxState;
  /** Whether THIS HOST can build a box at all, present only when the plugin
   *  declares a sandbox — checked before a start is ever attempted, so the
   *  approval screen can say "this system cannot build the box" instead of
   *  the neutral "will run in a box" right up until the person switches it
   *  on. `sandboxProbe()` is cached, so asking for every plugin costs one
   *  probe, not one per plugin. */
  sandboxProbe?: PublicSandboxProbe;
  /** The first line bwrap wrote to stderr the last time this plugin's box
   *  died in its opening instant, cleared at the start of the next attempt.
   *  Set only while nothing is running: a plugin currently up has nothing
   *  to explain. */
  lastBoxFailure?: string;
  /** The other plugins whose key THIS one can read: set only while it runs
   *  outside its box (a same-user process reads `secrets.json`) and another
   *  plugin holds a key. Static, a line on the plugin and in `plugins list`,
   *  never a notification. */
  canReadKeysOf?: string[];
};

/** A record from before `contributes` existed has none on disk. */
function withContributes(p: PluginRecord): PluginRecord {
  return p.contributes ? p : { ...p, contributes: {} };
}

function publicProbe(): PublicSandboxProbe {
  const p = sandboxProbe();
  return p.ok ? { ok: true } : { ok: false, reason: p.reason, detail: p.detail };
}

/** Whether a host that cannot build the box lets this plugin run without it. */
function mayRunUnboxed(rec: PluginRecord): boolean {
  return process.platform !== "linux" || rec.allowUnboxed === true || process.env.AGENTGLASS_PLUGINS_UNBOXED === "1";
}

/** Outside a box now, or enabled and about to be: a plugin that is not running
 *  (crashed, master off, between boots) starts the same way it did last time,
 *  and the red line is for what it could read then, not only while it is up. */
function runsUnboxed(p: PluginRecord, boxState: BoxState | undefined): boolean {
  if (boxState) return boxState.kind === "unboxed";
  if (!p.enabled) return false;
  return !p.sandbox || (!sandboxProbe().ok && mayRunUnboxed(p));
}

/** `running`/`pid`/`boxState` together, from the one live entry — so a
 *  caller never reads `pid` off one lookup and `boxState` off a second that
 *  raced a stop or a restart in between. Adds the host-level probe and any
 *  leftover crash detail, both keyed off the RECORD rather than the live
 *  entry, since they matter most while nothing is running. */
function liveState(p: PluginRecord): Pick<PublicPlugin, "running" | "pid" | "boxState" | "sandboxProbe" | "lastBoxFailure"> {
  const r = running.get(p.name);
  const out: Pick<PublicPlugin, "running" | "pid" | "boxState" | "sandboxProbe" | "lastBoxFailure"> = {
    running: r !== undefined,
    pid: r?.pid ?? null,
  };
  if (r) out.boxState = r.boxState;
  if (p.sandbox) out.sandboxProbe = publicProbe();
  if (!r) {
    const fail = lastBoxFailure.get(p.name);
    if (fail) out.lastBoxFailure = fail;
  }
  return out;
}

/** `settings` stays out: what a person typed into one plugin's settings (a
 *  key, a private repository) is not for every read-scope caller of /plugins
 *  — another plugin, a paired phone — to see. It is served on its own, at
 *  `full`, and to the plugin itself over its own token. */
export function listPlugins(opts: { keyExposure?: boolean } = {}): PublicPlugin[] {
  const store = read();
  const installed = new Set(store.plugins.map((q) => q.name));
  let holders: string[] | undefined; // read only when somebody runs outside a box
  return store.plugins.map(({ settings: _s, ...p }) => {
    const live = liveState(p);
    // Who holds a key is for the window, so it is opt-in: a plugin that asks the
    // list must not get a free map of whom to go after (an unboxed one can read
    // the file anyway). Only plugins still installed count; an entry left in
    // secrets.json by one that is gone is nobody's to be told about.
    const exposed = opts.keyExposure && runsUnboxed(p, live.boxState)
      ? (holders ??= Object.keys(readSecrets()).filter((h) => installed.has(h))).filter((h) => h !== p.name)
      : [];
    return { ...withContributes(p), ...live, ...(exposed.length ? { canReadKeysOf: exposed } : {}) };
  });
}

/** What a plugin declared, for the routes that check a draw against it. */
export function contributesOf(name: string): Contributes {
  return read().plugins.find((p) => p.name === name)?.contributes ?? {};
}

export function isRunning(name: string): boolean {
  return running.has(name);
}

/**
 * What the window and any other reader gets: every `secret` field is `null`
 * and `set` names the ones that hold a value. The value itself leaves this
 * file only through `pluginOwnSettings`.
 */
export function pluginSettings(name: string): { fields: ReturnType<typeof fieldsWithOptions>; values: Record<string, unknown>; set: string[] } | null {
  const rec = read().plugins.find((p) => p.name === name);
  if (!rec) return null;
  const r = redactSecrets(rec.contributes?.settings, settingsWithSecrets(rec));
  return { fields: fieldsWithOptions(name, rec.contributes?.settings), values: r.values, set: r.set };
}

/** The plugin's own view of its settings, secrets included. Only for the
 *  `/plugin/self` routes and the `settings` event, which are its alone. */
export function pluginOwnSettings(name: string): Record<string, unknown> {
  const rec = read().plugins.find((p) => p.name === name);
  return rec ? settingsWithSecrets(rec) : {};
}

/**
 * Save what the person chose, typed by the manifest, and tell the plugin.
 * Merged over what was there, so a form that only shows some fields cannot
 * erase the rest. A secret the caller did not send is left alone; sending an
 * empty string clears it.
 */
export function setPluginSettings(name: string, raw: unknown): { ok: true; values: Record<string, unknown>; set: string[] } | { ok: false; error: string } {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return { ok: false, error: "no such plugin" };
  const fields = rec.contributes?.settings;
  if (!fields?.length) return { ok: false, error: "this plugin has no settings" };
  const given = coerceSettings(fields, raw);
  const secretKeys = secretKeysOf(fields);
  const sent = Object.entries(given).filter(([k]) => secretKeys.includes(k));
  if (sent.length) {
    if (!settleStrip(store)) return { ok: false, error: "could not save the key" };
    // Secrets first, as the migration does: a crash between the two files can
    // only leave a plain setting unsaved, never a key in the wrong place.
    const all = loadSecrets();
    if (!all) return { ok: false, error: "could not save the key" };
    const held = { ...(all[name] ?? {}) };
    for (const [k, v] of sent) { if (v === "") delete held[k]; else held[k] = v as string; }
    if (!putSecrets(all, name, held)) return { ok: false, error: "could not save the key" };
  }
  rec.settings = { ...(rec.settings ?? {}), ...withoutSecrets(fields, given) };
  // The key is already kept, so a failure here is a plain setting not saved,
  // said as such: an ok would let the next read put the old plugins.json back.
  if (!write(store)) return { ok: false, error: "could not save the settings" };
  const values = settingsWithSecrets(rec);
  pushEvent(name, { type: "settings", settings: values, at: Date.now() });
  return { ok: true, ...redactSecrets(fields, values) };
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
    const p = Bun.spawn(["git", ...PLUGIN_GIT_CONFIG, "rev-parse", "HEAD"], { cwd: dir, env: pluginGitEnv(), stdout: "pipe", stderr: "ignore", stdin: "ignore" });
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
  // An update carries the record's settings; a reinstall after an uninstall
  // picks up the ones the uninstall kept. Installing the same name from
  // another source is not an update: the record's settings belong to the
  // plugin being replaced, and they are kept for it as a remove would.
  const from = sourceKey(source);
  const same = existing !== undefined && sourceKey(existing.source) === from;
  // A secret is never kept for a later reinstall: removing a plugin to revoke
  // its key must actually revoke it.
  const displacedSettings = existing && !same ? withoutSecrets(existing.contributes?.settings, existing.settings) : undefined;
  const displaced = displacedSettings && Object.keys(displacedSettings).length > 0
    ? { ...(store.keptSettings ?? {}), [manifest.name]: { ...(store.keptSettings?.[manifest.name] ?? {}), [sourceKey(existing!.source)]: displacedSettings } }
    : store.keptSettings;
  const carried = same ? withoutRetypedSecrets(existing!.contributes?.settings, manifest.contributes?.settings, existing!.settings) : undefined;
  const kept = displaced?.[manifest.name]?.[from];
  const restored = !carried && kept !== undefined;
  const settings = carried ?? (restored ? kept : undefined);
  // The reviewer approved a specific declared scope over a specific tree of
  // bytes, not a name — see consentFingerprint. Unchanged keeps its
  // approval; changed loses it, and if it was running, running on the old
  // approval is worse than not running at all.
  const stillApproved = existing?.approvedFingerprint !== null && existing?.approvedFingerprint === fingerprint;
  const approvedHash = stillApproved ? existing!.approvedHash : null;
  const approvedFingerprint = stillApproved ? existing!.approvedFingerprint! : null;
  if (existing?.enabled && !stillApproved) await stopRunning(manifest.name);

  // A key follows an update from the same place that still declares the field
  // as a secret; a different source, a retyped field or a first install holds
  // none. Dropped before the folder or the record is touched, so a crash in between
  // leaves a plugin without its key and never one with somebody else's, and a
  // drop that fails refuses the install with nothing replaced.
  //
  // The ceiling: "the same place" is the name plus `sourceKey`, not an identity.
  // A local-path source is the same whenever the folder path matches, so
  // different content put at that path inherits the key on update. The
  // fingerprint changes with the content and resets the approval, so it cannot
  // run until a person approves it again, but nothing on that approval says a
  // stored key will be handed over with it. Same semantics as the plain settings
  // an update carries; a line on the consent screen is the next thing after this
  // and is not here.
  if (!keepSecrets(store, manifest.name, same ? secretKeysOf(manifest.contributes?.settings) : [])) {
    return { ok: false, error: "could not drop the old key of a plugin with this name, so nothing was installed" };
  }
  // Belt over braces: `validPluginName` already refused `..`, and this is
  // the assertion that survives a future edit to the regex. Nothing on disk
  // is touched unless the target is a child of the plugins folder.
  if (!insidePluginsRoot(installDir)) return { ok: false, error: "plugin name would install outside the plugins folder" };
  // The old folder is put aside, not deleted, until the record is saved: new
  // bytes under the old approval are what a failed save would otherwise leave.
  // The ceiling: a crash between the rename and the save leaves the old folder
  // under `.old-<pid>` and nothing at the name; a reinstall puts it right.
  const aside = `${installDir}.old-${process.pid}`;
  rmSync(aside, { recursive: true, force: true });
  if (existsSync(installDir)) renameSync(installDir, aside);
  const putBack = (): void => {
    rmSync(installDir, { recursive: true, force: true });
    if (existsSync(aside)) renameSync(aside, installDir);
  };
  mkdirSync(dirname(installDir), { recursive: true });
  // The app's own copy, not `cp`, which Windows does not have; a link is
  // copied as the link it is, not rewritten to where it pointed in staging.
  try { cpSync(staging, installDir, { recursive: true, verbatimSymlinks: true, filter: copied }); } catch (e) {
    putBack();
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
    ...(settings ? { settings } : {}),
  };
  const saved = write({
    ...store,
    plugins: [...store.plugins.filter((p) => p.name !== manifest.name), record],
    // Consumed only by the reinstall they belong to: a plugin from elsewhere
    // under the same name neither reads them nor throws them away.
    keptSettings: restored ? withoutKept(displaced, manifest.name, from) : displaced,
  });
  if (!saved) {
    putBack();
    return { ok: false, error: "could not save the plugin record, so nothing was installed" };
  }
  rmSync(aside, { recursive: true, force: true });
  return { ok: true, plugin: { ...record, ...liveState(record) } };
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
    const s = expandHome(input.trim(), process.env.HOME ?? homedir());
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

/**
 * Grant or revoke this plugin's explicit consent to run unboxed on a host
 * that cannot build its box (see `allowUnboxed` on `PluginRecord`, and R1 in
 * the security triage this closes). Granting retries a start if the plugin
 * is enabled but not currently running — the shape a refused start leaves it
 * in. Revoking stops it if the reason it is running at all was this consent;
 * a plugin that is boxed, or that never needed the box, is untouched.
 */
export async function setPluginUnboxedConsent(name: string, allow: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) return { ok: false, error: "no such plugin" };
  rec.allowUnboxed = allow;
  write(store);
  if (allow) {
    // The same three gates `enablePlugin`/`resumeEnabledPlugins` hold a start
    // to: switched on, approved at its CURRENT fingerprint, and not blocked.
    // Consent is not a fourth way to enable a plugin — a legacy record
    // migrated with `enabled: true, approvedFingerprint: null` (never
    // reviewed), or one with the master switch off, must not start just
    // because someone flipped this one switch.
    const canStart = store.master && rec.enabled && rec.approvedFingerprint === rec.fingerprint && !blockedEntry(name);
    if (canStart && !running.has(name)) await startProcess(rec);
  } else {
    const r = running.get(name);
    if (r && r.boxState.kind === "unboxed" && r.boxState.reason !== "no-block") await stopRunning(name);
  }
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

/** Throws rather than answer false, which means "no such plugin": a remove that
 *  could not revoke the key is not that. */
function dropKeyOrThrow(store: Store, name: string): void {
  if (!keepSecrets(store, name)) throw new Error("could not drop this plugin's key, so nothing was removed");
}

/** Disable and remove: stop the process, revoke its token, delete the
 *  copied folder, drop the record. A plugin left running after it was
 *  removed is the same failure a plugin left running after it was
 *  disabled is. Its settings stay in the store for a reinstall unless
 *  `dropSettings` asks for them to go too. */
export async function removePlugin(name: string, opts: { dropSettings?: boolean } = {}): Promise<boolean> {
  const store = read();
  const rec = store.plugins.find((p) => p.name === name);
  if (!rec) {
    // Already uninstalled, its settings kept: this is the only way left to
    // clear them, since there is no card to press Remove on. Every source's
    // under that name goes — the command names a plugin, not where it came
    // from.
    if (!opts.dropSettings || !Object.hasOwn(store.keptSettings ?? {}, name)) return false; // `keptSettings["__proto__"]` is not an entry
    dropKeyOrThrow(store, name);
    write({ ...store, keptSettings: withoutKey(store.keptSettings, name) });
    return true;
  }
  // First, before anything is deleted: a key that cannot be revoked leaves the
  // record, the folder and the name as they were, so nothing installed later
  // under it can be handed the key.
  dropKeyOrThrow(store, name);
  await stopRunning(name);
  lastBoxFailure.delete(name);
  // A record is read back from disk, so its `installDir` is trusted no more
  // than a manifest is: the folder goes only when it is a child of the
  // plugins root. Otherwise the record is dropped and the disk left alone —
  // a stale entry is a nuisance, a deleted config directory is not.
  if (insidePluginsRoot(rec.installDir)) rmSync(rec.installDir, { recursive: true, force: true });
  // A different author's plugin installed later under this same name must
  // not inherit whatever this one cached here.
  removePluginDataDir(name);
  const keepable = withoutSecrets(rec.contributes?.settings, rec.settings);
  const keep = !opts.dropSettings && keepable && Object.keys(keepable).length > 0;
  const from = sourceKey(rec.source);
  write({
    ...store,
    plugins: store.plugins.filter((p) => p.name !== name),
    // Only this plugin's own entry: settings another source left under the
    // same name belong to that plugin, and neither a keep nor a drop here
    // touches them.
    keptSettings: keep
      ? { ...(store.keptSettings ?? {}), [name]: { ...(store.keptSettings?.[name] ?? {}), [from]: keepable! } }
      : opts.dropSettings ? withoutKept(store.keptSettings, name, from) : store.keptSettings,
  });
  dropNotesOf(name);
  // Also when it was not running: a plugin installed later under the same
  // name must not inherit a queue of this one's events.
  forgetPlugin(name);
  return true;
}

/** Where a plugin came from, without the ref: a reinstall at another tag of
 *  the same repository is the same plugin. */
function sourceKey(s: InstallSource): string {
  if (s.kind === "local-path") return `local-path:${s.path}`;
  if (s.kind === "git") return `git:${s.url}`;
  return `marketplace:${s.marketplace.url}|${s.plugin.url}`;
}

function withoutKey<T>(m: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
  if (!m || !(key in m)) return m;
  const { [key]: _gone, ...rest } = m;
  return Object.keys(rest).length ? rest : undefined;
}

function withoutKept(m: Store["keptSettings"], name: string, from: string): Store["keptSettings"] {
  const bySource = withoutKey(m?.[name], from);
  return bySource ? { ...m, [name]: bySource } : withoutKey(m, name);
}

/** Test seam: wipe the store, the on-disk folder, and any running process. */
export async function __resetPlugins(): Promise<void> {
  for (const name of [...running.keys()]) await stopRunning(name);
  write({ master: true, plugins: [] });
  writeAtomic(secretsPath(), {});
  try { rmSync(join(pluginsConfigDir(), "plugins"), { recursive: true, force: true }); } catch { /* nothing to clear */ }
}
