// User settings that have to survive being launched from a desktop icon.
//
// A .env beside the server only works when the server is started from a
// checkout; the app has no such file and an arbitrary working directory. This
// reads the same settings from the XDG config dir, which both surfaces can
// find. Environment variables still win, so a one-off `AGENTGLASS_…=x bun run`
// overrides the file without editing it.

import type { Budget } from "../../shared/types.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, sep, delimiter } from "node:path";
import { worktreeFamily } from "./worktree.ts";

/**
 * Resolved per call, and read per path.
 *
 * This was a module constant beside a `const config = load()`, which meant the
 * first import in the process decided both, on whatever HOME the process
 * happened to start with. Tests that redirect HOME or XDG_CONFIG_HOME and then
 * import were reading the developer's own settings: their `root` scoped tests
 * that had deliberately unscoped themselves, and their `repoDirs` filtered
 * every fixture repo out of discovery. That is why `whole-machine discovery`
 * and `open-tool memo` failed on a machine with real projects and passed in CI,
 * where the file does not exist.
 */
export function configPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "agentglass",
    "config.json"
  );
}

/**
 * Under `bun test`, settings may only come from the scratch directory.
 *
 * A test that points XDG_CONFIG_HOME at a temp dir gets exactly what it wrote
 * there. Everything else reads as "no config", whatever the import order was,
 * so no suite can inherit the settings of the machine it runs on or write over
 * them. Same rule as the theme sync and the database, for the same reason.
 */
const IS_TEST = process.env.NODE_ENV === "test";
function isScratch(p: string): boolean {
  const scratch = tmpdir();
  return p === scratch || p.startsWith(scratch + "/");
}
function realConfigOffLimits(p: string): boolean {
  return IS_TEST && !isScratch(p);
}

interface Config {
  /** Work on this one project and nothing else. */
  root?: string;
  /** Directories to sweep for git repos, e.g. ["~/code", "/mnt/hdd/code"]. */
  repoDirs?: string[];
  /** Offer `bypassPermissions` — `claude --dangerously-skip-permissions` — as a
   *  chat mode. Off unless stated, and stated *here* rather than only in the
   *  environment: a desktop launcher passes no env, so AGENTGLASS_CHAT_BYPASS
   *  alone made the mode unreachable for the surface that wants it most. */
  chatBypass?: boolean;
  /** Turn the terminal panel off. Stated *here* and not only in the environment
   *  for the same reason as chatBypass: an app launched from a desktop icon
   *  inherits no shell env, so AGENTGLASS_TERMINAL_DISABLED alone is unreachable
   *  for a packaged install or a shell-less deployment — exactly the people who
   *  want it off. The env var still wins when set. */
  terminalDisabled?: boolean;
  /** Spending limits somebody set. See budget.ts. Hand-edited freely like the
   *  rest of this file, so every field is checked on read. */
  budgets?: Budget[];
  /** Projects the picker should stop offering. Absolute paths. See
   *  hiddenProjects(). */
  hiddenProjects?: string[];
  /** Which tmux binary the pane engine runs. "auto" (default) prefers the
   *  bundled static tmux and falls back to the system one; "system" skips the
   *  bundle; "custom" uses `tmuxPath`. See tmuxbin.ts — AGENTGLASS_TMUX_PATH
   *  overrides all of this when set. */
  tmuxSource?: "auto" | "bundled" | "system" | "custom";
  /** Absolute path to a tmux binary, used when `tmuxSource` is "custom". */
  tmuxPath?: string;
  /** How agentglass's own tmux server gets its config: "append" runs the
   *  generated base conf then the user's override; "replace" uses a user file
   *  wholesale. Either way the user's ~/.tmux.conf is never loaded. See
   *  tmuxconf.ts. */
  tmuxConfMode?: "append" | "replace";
  /** The user's extra config lines for agentglass's tmux server (Level 1).
   *  Plain text, validated before it is ever applied. */
  tmuxOverride?: string;
  /** Restore the pane layout (windows, splits, scrollback) at boot, after a
   *  reboot took the tmux server down. Off by default. See tmuxrestore.ts. */
  tmuxRestore?: boolean;
  /** How restored agent panes relaunch their CLI: "lazy" restores the layout
   *  and waits for the chat to be reopened before resuming the session;
   *  "all" resumes every recorded session at restore time. */
  tmuxResume?: "lazy" | "all";
  /** The engine's prefix key in tmux's spelling (`C-a`, `M-Space`). Empty or
   *  absent leaves tmux's own default. Written from the settings panel because
   *  it is the one binding everybody changes, and it goes into a config file
   *  the engine runs — so it is validated, never escaped. */
  tmuxPrefix?: string;
  /** Which tmux the terminal VIEW opens on: the engine's server, or the tmux on
   *  this machine resumed where it was left. Absent means the engine. */
  tmuxTerminal?: "engine" | "desk";
  /** Set when the validation gate rejected the generated conf. The pane
   *  engine degrades (chat still works) and the settings panel shows why. */
  tmuxConfBroken?: { broken: boolean; reason: string };
}

function load(path: string): Config {
  try {
    if (realConfigOffLimits(path) || !existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    // A hand-edited config.json can hold anything. A top level that isn't a
    // plain object (a bare number, a string, an array, null) would make the
    // `root` check below throw on `in`, and a non-string `root` reached
    // expand()/startsWith() at boot — `workspaceRoot()` runs before the server
    // listens — and threw an uncaught TypeError that stopped the app dead. A
    // corrupt config must degrade, never prevent startup, so coerce the shape:
    // drop what we can't use, warn, keep the rest.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      console.error(`[config] ignoring ${path}: expected a JSON object`);
      return {};
    }
    const cfg = raw as Config;
    if ("root" in cfg && cfg.root !== undefined && typeof cfg.root !== "string") {
      console.error(`[config] ignoring non-string "root" in ${path}`);
      delete cfg.root;
    }
    return cfg;
  } catch (e) {
    // A typo shouldn't take the server down, but it must not pass unnoticed
    // either — the symptom would be settings mysteriously not applying.
    console.error(`[config] ignoring ${path}: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

/** Read once per resolved path, so the app pays the same single read it always
 *  did while a test that moves its home is actually followed. */
let cached: { path: string; cfg: Config } | null = null;
function config(): Config {
  const path = configPath();
  if (!cached || cached.path !== path) cached = { path, cfg: load(path) };
  return cached.cfg;
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * The budgets on disk, with anything unusable dropped.
 *
 * Checked field by field rather than trusted, for the same reason `root` is:
 * this file is hand-edited, and a budget is a *denominator*. A limit that
 * arrives as a string turns every percentage into NaN, and a period nobody
 * recognises would silently be evaluated as a month. Both are the kind of wrong
 * that shows up as a number on a dashboard rather than as an error.
 *
 * A row that cannot be used is skipped and said about, never coerced into
 * something plausible — a limit of `"40"` meaning forty is a guess, and
 * guessing on a spending limit is how somebody finds out at the end of a month.
 */
export function readBudgets(): Budget[] {
  const raw = config().budgets;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.error(`[config] ignoring "budgets" in ${configPath()}: expected an array`);
    return [];
  }
  const out: Budget[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const r = b as Partial<Budget>;
    if (typeof r.limit !== "number" || !Number.isFinite(r.limit) || r.limit <= 0) {
      console.error(`[config] ignoring a budget with a limit that is not a positive number`);
      continue;
    }
    if (r.period !== "day" && r.period !== "week" && r.period !== "month") {
      console.error(`[config] ignoring a budget with an unknown period: ${String(r.period)}`);
      continue;
    }
    out.push({
      root: typeof r.root === "string" ? expand(r.root) : "",
      model: typeof r.model === "string" ? r.model : "",
      limit: r.limit,
      period: r.period,
    });
  }
  return out;
}

/**
 * Projects the picker has been told not to offer again.
 *
 * A found repo is not the same thing as a project somebody wants: the sweep
 * turns up scratch checkouts, a clone made once to read something, the vendored
 * copy under a tool's cache. There was no way to say so, and a list you cannot
 * prune stops being read.
 *
 * Hidden, not forgotten, and certainly not deleted: nothing here touches the
 * filesystem. The path is remembered so the sweep can go on finding it and this
 * can go on leaving it out — anything else would mean the entry coming back on
 * the next sweep, which is how "remove" turns into a button that does nothing.
 *
 * Every row is checked on read, like the rest of this hand-editable file.
 */
export function hiddenProjects(): string[] {
  const raw = config().hiddenProjects;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    console.error(`[config] ignoring "hiddenProjects" in ${configPath()}: expected an array`);
    return [];
  }
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim()) continue;
    out.push(resolve(expand(p.trim())));
  }
  return out;
}

/**
 * Hide one, or put it back.
 *
 * Per-path rather than whole-set, because the two callers are one row's ✕ and
 * one row's undo — handing the whole list back and forth would let two windows
 * open at once overwrite each other's answer with a stale copy.
 */
export function setProjectHidden(pathIn: unknown, hidden: boolean): { ok: boolean; hidden: string[]; persisted: boolean; error?: string } {
  const fail = (error: string) => ({ ok: false as const, hidden: hiddenProjects(), persisted: false, error });
  if (typeof pathIn !== "string" || !pathIn.trim() || pathIn.includes("\0")) return fail("invalid path");
  const target = resolve(expand(pathIn.trim()));
  const next = hiddenProjects().filter((p) => p !== target);
  if (hidden) next.push(target);

  const file = configPath();
  if (realConfigOffLimits(file)) {
    // Applied in memory is not possible here — this is read from the file every
    // time — so say plainly that it did not take rather than report success.
    return { ok: false, hidden: hiddenProjects(), persisted: false, error: "not persisted: tests write settings only under os.tmpdir()" };
  }
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail(`config file is malformed — fix ${file} to change this`);
      }
      existing = parsed as Record<string, unknown>;
    }
  } catch (e) {
    return fail(`config file is malformed — fix ${file} to change this (${e instanceof Error ? e.message : e})`);
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const merged: Record<string, unknown> = { ...existing };
    if (next.length) merged.hiddenProjects = next; else delete merged.hiddenProjects;
    writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
    cached = null; // so the next read sees what was just written
  } catch (e) {
    return fail(`could not save to ${file}: ${e instanceof Error ? e.message : e}`);
  }
  return { ok: true, hidden: next, persisted: true };
}

/**
 * Replace the whole set.
 *
 * Whole-set rather than per-row: budgets are edited as a list in one pane, and
 * a partial update needs an identity for a row that has none — two budgets can
 * differ only by a limit somebody is halfway through typing.
 *
 * Written through the same path as the workspace root, and refusing the same
 * two things: a config file it could not parse, which would be overwritten
 * wholesale, and any path outside the scratch directory under test.
 */
export function writeBudgets(budgets: Budget[]): { ok: boolean; persisted: boolean; error?: string } {
  const path = configPath();
  if (realConfigOffLimits(path)) {
    return { ok: true, persisted: false, error: "not persisted: tests write settings only under os.tmpdir()" };
  }
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, persisted: false, error: `config file is malformed — fix ${path} to save budgets` };
      }
      existing = parsed as Record<string, unknown>;
    }
  } catch (e) {
    return { ok: false, persisted: false, error: `config file is malformed — fix ${path} to save budgets (${e instanceof Error ? e.message : e})` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...existing, budgets }, null, 2) + "\n");
    cached = null; // so the next read sees what was just written
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, persisted: false, error: `could not write ${path}: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Where to look for repos, most explicit source first.
 *
 * Returns an empty list when nothing is configured, which the caller reads as
 * "work it out from where the known projects live" — the out-of-the-box
 * behaviour. Naming the directories is both faster and more predictable, since
 * inference can only ever guess from history.
 */
/**
 * The single project this instance is for, if it was opened for one.
 *
 * Scoping to one directory is a different thing from listing several to search:
 * it means "this cockpit is about this project" — no sweeping, no other repos,
 * and the dashboard shows that project's work rather than everything on the
 * machine. Unset (the default) keeps the machine-wide behaviour.
 *
 * Only ever set on purpose: AGENTGLASS_ROOT, `root` in the config file, or the
 * directory passed to the app. Deliberately *not* inferred from the working
 * directory — that would silently scope a plain `bun run dev` in a checkout to
 * that checkout, which is a surprising way to lose the rest of your fleet.
 * Scoping is a decision, so it has to be stated.
 */
let cachedRoot: string | null | undefined;
let cachedFor: string | undefined;
export function workspaceRoot(): string | null {
  const asked = process.env.AGENTGLASS_ROOT || config().root;
  // Keyed on what was asked for, not merely "have we answered before". The
  // scope never changes in a running server, so this costs one comparison —
  // but `bun test` shares a process, and the first suite to call this used to
  // pin the answer for every suite after it. A later file setting
  // AGENTGLASS_ROOT then got the earlier file's scope, silently, and only in
  // whatever file order the runner happened to pick.
  if (cachedRoot !== undefined && cachedFor === asked) return cachedRoot;
  cachedFor = asked;
  cachedRoot = asked ? resolveScope(asked) : null;
  return cachedRoot;
}

/**
 * Is this path inside the open project?
 *
 * Scope became a read filter in #48, but only a read filter: a cockpit opened
 * for one project still handed out git writes, a login shell and chat in any
 * repo on the machine. "Open a project" that narrows what you can *see* while
 * leaving what you can *touch* wide open is the confusing half-state — the UI
 * says you are in one project and the capabilities say otherwise.
 *
 * The escape hatch for genuinely multi-repo work already exists and is
 * documented: scope to the parent folder (`~/code`) instead of one repo, which
 * `reposUnder()` already supports. So refusing here has a real answer that
 * isn't "turn the feature off", and the error message says it.
 *
 * Unscoped (whole machine) allows everything, unchanged — this only narrows an
 * instance that was deliberately pointed at one project.
 *
 * A repo's linked worktrees count as inside it, wherever they sit on disk. They
 * are the same project on another branch — the git panel has always listed them
 * as part of it, and `--git-common-dir` folds their sessions back onto it — so
 * refusing a shell or a commit in one was the app contradicting itself. The
 * usual layout puts them in sibling directories (`~/code/orbit-WEB-1042`
 * beside `~/code/orbit`), which no prefix test can ever match; that is the whole
 * reason this consults git rather than the path alone.
 */
/** child === parent, or child sits inside parent — compared with the OS's own
 *  separator (injectable so this can be exercised against both `/` and `\`
 *  from a single-OS test run). `resolve()` returns backslash-joined paths on
 *  Windows, so a hardcoded `parent + "/"` prefix test matches the scope root
 *  itself but never anything inside it there; every path in the project
 *  reads as out-of-scope. */
export function isWithin(child: string, parent: string, s: string = sep): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(s) ? parent : parent + s;
  return child.startsWith(prefix);
}

export function inScope(path: string | null | undefined, scope = workspaceRoot()): boolean {
  if (!scope) return true; // whole-machine: nothing to enforce
  if (!path) return false;
  const p = resolve(expand(path));
  // The plain prefix test first: it answers every non-worktree case without a
  // subprocess, including the container-folder scope where the family is moot.
  if (isWithin(p, scope)) return true;
  return worktreeFamily(scope).some((r) => isWithin(p, r));
}

/**
 * Is this session's work part of the open project?
 *
 * `inScope` asks it of a path; a session carries two, and either one answers
 * yes. That is the same rule `scopeClause()` puts in SQL — `project_path IN
 * (...) OR cwd_path IN (...)` — kept here so the live seam and the stored reads
 * cannot drift apart.
 *
 * They had drifted. Every read was scoped and the WebSocket push was not, so a
 * cockpit opened for one project showed that project's history and then filled
 * up with whatever else on the machine happened to emit while you watched.
 * Reloading swept those away and the next event brought them back — one window
 * disagreeing with itself about which fleet it was showing. It surfaced where it
 * was least deniable: an alert from another project taking the top bar of a
 * cockpit scoped somewhere else.
 */
export function sessionInScope(
  s: { project_path?: string | null; cwd_path?: string | null },
  scope = workspaceRoot(),
): boolean {
  if (!scope) return true; // whole-machine: nothing to filter
  return inScope(s.project_path, scope) || inScope(s.cwd_path, scope);
}

/** The directories a scoped instance is about: the project plus its linked
 *  worktrees. Unscoped returns empty — "no scope" is not "a list of roots", and
 *  callers branch on that rather than being handed the whole machine. */
export function scopeRoots(scope = workspaceRoot()): string[] {
  return scope ? worktreeFamily(scope) : [];
}

/** One rule for turning "what the user asked for" into a scope directory —
 *  shared by boot (env/config) and the runtime picker, so both resolve the
 *  same input to the same root. */
function resolveScope(asked: string): string {
  const abs = resolve(expand(asked));
  const top = repoTop(abs);
  if (!top) return abs; // a path that isn't a repo is still a scope
  /*
   * git answers with the REAL path, and the path we were asked about may be
   * reached through a symlink. That matters because this string is not used as
   * a path — it is used as a PREFIX, against `project_path` and `cwd_path` on
   * rows written by hooks, which spell the directory however the agent was
   * launched with it. Two spellings of the same directory share no prefix, so
   * handing back git's spelling filters out the very rows the scope exists to
   * select, and the cockpit comes up empty with nothing to say about why.
   *
   * It is not an exotic setup. `~/code` symlinked onto another volume, a home
   * directory behind an automounter, and `os.tmpdir()` on a machine that is not
   * ours are all this. The last one is how it was found: this suite passed for
   * months, then failed on an unchanged commit when the runner's temp directory
   * moved behind a link.
   *
   * So git is asked the question it is uniquely good at — HOW MUCH of this path
   * is the repository — and the answer is re-spelled in the caller's terms by
   * trimming the same tail. The segment names are identical either way; only
   * the prefix differs, which is exactly the part being replaced.
   */
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return top; // the directory went away mid-question; git's answer is all there is
  }
  if (real === top) return abs;
  if (real.startsWith(top + sep)) {
    const tail = real.length - top.length;
    const mapped = abs.slice(0, abs.length - tail);
    // Only when the tail really is a shared suffix. A path where it is not is
    // not something to guess at — git's own answer is the safer wrong.
    if (mapped && real.slice(top.length) === abs.slice(abs.length - tail)) return mapped;
  }
  return top;
}

/** git's own answer for "which repo is this", or null. */
function repoTop(dir: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Point this instance at one project (or back at the whole machine) while it
 * runs — the project picker in the UI calls this. The choice is applied
 * immediately (the transcript scanner re-evaluates scope on its next sweep,
 * every few seconds) and persisted to the config file so the next launch opens
 * the same project. Passing null clears the scope.
 *
 * Note the runtime cache is set directly: AGENTGLASS_ROOT from the environment
 * seeds the *initial* scope, but an explicit pick in the UI is newer intent and
 * wins for the rest of this process's life.
 */
export function setWorkspaceRoot(rootIn: string | null): { ok: boolean; workspace: string | null; persisted: boolean; error?: string; note?: string } {
  const fail = (error: string) => ({ ok: false as const, workspace: workspaceRoot(), persisted: false, error });
  let next: string | null = null;
  if (rootIn !== null) {
    if (typeof rootIn !== "string" || !rootIn.trim() || rootIn.includes("\0")) return fail("invalid path");
    const abs = resolve(expand(rootIn.trim()));
    try {
      if (!statSync(abs).isDirectory()) return fail("not a directory");
    } catch {
      return fail("directory does not exist");
    }
    next = resolveScope(abs);
  }
  cachedRoot = next;
  // Persist so the choice survives a restart. Re-read the file first — another
  // setting written there by hand must not be clobbered by a stale snapshot.
  let persisted = false;
  let note: string | undefined;
  const path = configPath();
  // A test may choose a workspace; it may not rewrite the settings of the
  // machine it runs on. The switch still applies in memory, which is all any
  // test needs, and cachedRoot above already carries it.
  if (realConfigOffLimits(path)) {
    return { ok: true, workspace: next, persisted: false, note: "not persisted: tests write settings only under os.tmpdir()" };
  }
  try {
    let cur: Config = {};
    try {
      cur = JSON.parse(readFileSync(path, "utf8")) as Config;
    } catch (e) {
      // Absent → start fresh. Present but unreadable/malformed → do NOT write:
      // rewriting would silently destroy whatever else the user keeps in it
      // (repoDirs, future keys). The runtime switch still applies.
      if (existsSync(path)) {
        console.error(`[config] not persisting workspace — ${path} exists but can't be parsed: ${e instanceof Error ? e.message : e}`);
        return { ok: true, workspace: next, persisted: false, note: `config file is malformed — fix ${path} to persist this choice` };
      }
    }
    if (next) cur.root = next; else delete cur.root;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
    cached = null; // the file changed under us; next read picks it up
    persisted = true;
  } catch (e) {
    console.error(`[config] could not persist workspace to ${path}: ${e instanceof Error ? e.message : e}`);
  }
  // The env var is read before the config file at boot, so it will shadow this
  // choice on the next launch (e.g. the desktop app started with a directory).
  if (process.env.AGENTGLASS_ROOT) note = `AGENTGLASS_ROOT is set — it will override this choice on the next launch`;
  return { ok: true, workspace: next, persisted, note };
}

/**
 * May a chat run with tool permissions skipped entirely?
 *
 * Deliberately opt-in and deliberately not a UI toggle: the chat endpoint is
 * reachable from a browser behind a same-origin check, so "run everything
 * unattended" has to be a decision made outside the thing it grants power to.
 * The env var covers `bun run dev`; the config key covers the desktop app,
 * which is launched from an icon and inherits no environment at all.
 */
export function chatBypassAllowed(): boolean {
  if (process.env.AGENTGLASS_CHAT_BYPASS !== undefined) return process.env.AGENTGLASS_CHAT_BYPASS === "1";
  return config().chatBypass === true;
}

/**
 * Whether the terminal is turned off, and by which layer — so the panel can say
 * why rather than open a socket that immediately closes. The env var overrides
 * the file (a one-off `AGENTGLASS_TERMINAL_DISABLED=0 bun run` can force it back
 * on), and the file makes it reachable from a desktop launcher. `null` means on.
 */
export function terminalDisabledSource(): "env" | "config" | null {
  if (process.env.AGENTGLASS_TERMINAL_DISABLED !== undefined) {
    return process.env.AGENTGLASS_TERMINAL_DISABLED === "1" ? "env" : null;
  }
  return config().terminalDisabled === true ? "config" : null;
}

export function configuredRepoDirs(): string[] {
  const fromEnv = (process.env.AGENTGLASS_REPO_DIRS || "").split(delimiter).filter(Boolean);
  // config.repoDirs comes from a hand-editable JSON file, so it may be a non-array
  // or hold non-string entries. Guard before mapping: an unguarded `.map(expand)`
  // threw a TypeError that broke GET /git/repos in the default whole-machine mode
  // — a single typo in config.json taking out the repo picker for the machine.
  const raw = fromEnv.length ? fromEnv : config().repoDirs ?? [];
  const dirs = Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : [];
  return dirs.map(expand);
}

// --- tmux engine settings ---------------------------------------------------
// Read one field at a time, each checked on read: config.json is hand-editable,
// and every one of these reaches a spawned binary or a filesystem path.

const TMUX_SOURCES = new Set(["auto", "bundled", "system", "custom"]);
export function tmuxSource(): "auto" | "bundled" | "system" | "custom" {
  const v = config().tmuxSource;
  return v !== undefined && TMUX_SOURCES.has(v) ? v : "auto";
}

export function tmuxPathSetting(): string {
  const v = config().tmuxPath;
  return typeof v === "string" && v.trim() && !v.includes("\0") ? v.trim() : "";
}

export function tmuxConfMode(): "append" | "replace" {
  const v = config().tmuxConfMode;
  return v === "replace" ? "replace" : "append";
}

export function tmuxOverride(): string {
  const v = config().tmuxOverride;
  return typeof v === "string" ? v.slice(0, 128_000) : "";
}

/** Was the generated conf rejected by the validation gate? Persisted so the
 *  reason survives a restart — a broken config is a property of what is on
 *  disk, not of this process. */
export function tmuxConfBroken(): { broken: boolean; reason: string } {
  const v = config().tmuxConfBroken;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { broken: false, reason: "" };
  return { broken: v.broken === true, reason: typeof v.reason === "string" ? v.reason.slice(0, 500) : "" };
}
export function setTmuxConfBroken(broken: boolean, reason = ""): void {
  writeTmuxSettings(broken ? { tmuxConfBroken: { broken, reason } } : { tmuxConfBroken: undefined });
}

export function tmuxRestoreEnabled(): boolean {
  return config().tmuxRestore === true;
}

export function tmuxResume(): "lazy" | "all" {
  const v = config().tmuxResume;
  return v === "all" ? "all" : "lazy";
}

/**
 * The engine's prefix key, in tmux's own spelling — `C-b`, `C-a`, `M-x`.
 *
 * A setting rather than something to be typed into the override, because it is
 * the one tmux binding everybody changes and asking for three lines of config
 * to move a keystroke is a wall in front of the commonest edit there is. Empty
 * means "leave tmux's default alone".
 *
 * Validated on the way in as well as here: this string is interpolated into a
 * config file the engine runs, so it may only ever be a key name.
 */
/**
 * Which tmux the TERMINAL VIEW opens on.
 *
 * "engine" — agentglass's own server: its config, its prefix, its restore, and
 * a session per checkout. "desk" — the tmux on this machine, resumed where it
 * was left, which is what the app did before there was an engine to offer.
 *
 * The two never mix. Whichever is not chosen goes on running untouched, so the
 * switch is reversible in both directions and nothing is migrated by flipping
 * it: a tmux session cannot move between servers, by anybody.
 */
export function tmuxTerminal(): "engine" | "desk" {
  return config().tmuxTerminal === "desk" ? "desk" : "engine";
}

export function tmuxPrefix(): string {
  const v = config().tmuxPrefix;
  return typeof v === "string" && validTmuxPrefix(v) ? v : "";
}

/**
 * A key name and nothing else.
 *
 * `C-a`, `M-Space`, `F5`. No spaces, no quotes, no semicolons — the value goes
 * into `set -g prefix <key>` in a file tmux executes, so anything that could
 * end the command and start another one is refused rather than escaped.
 */
export function validTmuxPrefix(v: string): boolean {
  return /^(C-|M-|C-M-)?[A-Za-z0-9]{1,10}$/.test(v);
}

/** Persist any subset of the tmux settings, preserving everything else in the
 *  file. Same write path and same guard as writeBudgets: a config it cannot
 *  parse is refused, not overwritten; tests write only under scratch. */
export function writeTmuxSettings(fields: {
  tmuxSource?: "auto" | "bundled" | "system" | "custom";
  tmuxPath?: string;
  tmuxConfMode?: "append" | "replace";
  tmuxOverride?: string;
  tmuxRestore?: boolean;
  tmuxResume?: "lazy" | "all";
  tmuxPrefix?: string;
  tmuxTerminal?: "engine" | "desk";
  tmuxConfBroken?: { broken: boolean; reason: string } | undefined;
}): { ok: boolean; persisted: boolean; error?: string } {
  const path = configPath();
  if (realConfigOffLimits(path)) {
    return { ok: false, persisted: false, error: "not persisted: tests write settings only under os.tmpdir()" };
  }
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, persisted: false, error: `config file is malformed — fix ${path} to save tmux settings` };
      }
      existing = parsed as Record<string, unknown>;
    }
  } catch (e) {
    return { ok: false, persisted: false, error: `config file is malformed — fix ${path} to save tmux settings (${e instanceof Error ? e.message : e})` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const merged: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) delete merged[k]; else merged[k] = v;
    }
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
    cached = null; // the file changed under us; next read picks it up
    return { ok: true, persisted: true };
  } catch (e) {
    return { ok: false, persisted: false, error: `could not write ${path}: ${e instanceof Error ? e.message : e}` };
  }
}
