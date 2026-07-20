// User settings that have to survive being launched from a desktop icon.
//
// A .env beside the server only works when the server is started from a
// checkout; the app has no such file and an arbitrary working directory. This
// reads the same settings from the XDG config dir, which both surfaces can
// find. Environment variables still win, so a one-off `AGENTGLASS_…=x bun run`
// overrides the file without editing it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { worktreeFamily } from "./worktree.ts";

export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "config.json"
);

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
}

function load(): Config {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch (e) {
    // A typo shouldn't take the server down, but it must not pass unnoticed
    // either — the symptom would be settings mysteriously not applying.
    console.error(`[config] ignoring ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

const config = load();

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

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
export function workspaceRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const asked = process.env.AGENTGLASS_ROOT || config.root;
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
export function inScope(path: string | null | undefined, scope = workspaceRoot()): boolean {
  if (!scope) return true; // whole-machine: nothing to enforce
  if (!path) return false;
  const p = resolve(expand(path));
  // The plain prefix test first: it answers every non-worktree case without a
  // subprocess, including the container-folder scope where the family is moot.
  if (p === scope || p.startsWith(scope + "/")) return true;
  return worktreeFamily(scope).some((r) => p === r || p.startsWith(r + "/"));
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
  return repoTop(abs) ?? abs; // a path that isn't a repo is still a scope
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
  try {
    let cur: Config = {};
    try {
      cur = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
    } catch (e) {
      // Absent → start fresh. Present but unreadable/malformed → do NOT write:
      // rewriting would silently destroy whatever else the user keeps in it
      // (repoDirs, future keys). The runtime switch still applies.
      if (existsSync(CONFIG_PATH)) {
        console.error(`[config] not persisting workspace — ${CONFIG_PATH} exists but can't be parsed: ${e instanceof Error ? e.message : e}`);
        return { ok: true, workspace: next, persisted: false, note: `config file is malformed — fix ${CONFIG_PATH} to persist this choice` };
      }
    }
    if (next) cur.root = next; else delete cur.root;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2) + "\n");
    persisted = true;
  } catch (e) {
    console.error(`[config] could not persist workspace to ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
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
  return config.chatBypass === true;
}

export function configuredRepoDirs(): string[] {
  const fromEnv = (process.env.AGENTGLASS_REPO_DIRS || "").split(":").filter(Boolean);
  const dirs = fromEnv.length ? fromEnv : config.repoDirs ?? [];
  return dirs.map(expand);
}
