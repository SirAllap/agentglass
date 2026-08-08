/**
 * Whether an agent could actually drive this browser, and what is missing.
 *
 * This pane exists because of a specific failure, and the failure is the reason
 * every part of it reports a fact rather than an intention. The skill that tells
 * agents the browser can be driven was written, committed, shipped inside the
 * app — and copied into `~/.claude/skills` by nothing at all. The feature was
 * finished and unreachable at the same time, nothing on any screen said so, and
 * it was found by the person using it rather than by the person who built it.
 *
 * So: three things have to be true at once for this to work, they go wrong
 * independently, and each of them can now be seen.
 *
 *   * **The CLI on PATH.** A symlink, installed by electron/install-local.sh
 *     into ~/.local/bin. It goes wrong by pointing at something that no longer
 *     exists — which is not hypothetical: it pointed into a throwaway git
 *     worktree for one afternoon, and a dangling symlink is worse than nothing,
 *     because `command -v` keeps saying yes.
 *   * **The skill in ~/.claude/skills.** A copy, so it goes wrong by drifting:
 *     the app ships a newer one and the installed copy stays as it was. Only a
 *     comparison of the bytes can see that.
 *   * **A window that can drive a page**, which is the browserdrive relay's
 *     business and is asked of it rather than guessed at here.
 *
 * A symlink and a copy fail in different ways on purpose, and this deliberately
 * does not pretend otherwise: `existsSync` on a dangling symlink answers false,
 * so "missing" and "dangling" would collapse into one wrong instruction —
 * "install it" — for a state where installing again is exactly the fix, and for
 * a state where it is not.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Same rule as hooksetup.ts, and for the same reason: Claude Code reads
 *  $HOME, so a server started with a different one must agree with it rather
 *  than with the passwd entry. */
function home(): string {
  const env = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return env && env.length ? env : homedir();
}

export const skillDest = (): string => join(home(), ".claude", "skills", "browser-use", "SKILL.md");
export const cliLink = (): string => join(home(), ".local", "bin", "agentglass-browser");

/**
 * Where the copy this build ships lives.
 *
 * Three rungs, because the answer differs between a packaged app, a `bun run`
 * from the checkout, and a test — and getting it wrong is not visible: the pane
 * would simply report "up to date" against a file it never found. The packaged
 * rung is first and the checkout rung saves the developer, whose
 * `process.execPath` is bun's own binary and says nothing about this repo.
 */
export function shippedSkill(): string | null {
  const candidates = [
    join(dirname(process.execPath), "resources", "skills", "browser-use", "SKILL.md"),
    join(dirname(process.execPath), "skills", "browser-use", "SKILL.md"),
    join(import.meta.dir, "..", "..", "skills", "browser-use", "SKILL.md"),
    join(process.cwd(), "skills", "browser-use", "SKILL.md"),
    join(process.cwd(), "..", "skills", "browser-use", "SKILL.md"),
  ];
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return resolve(c); } catch { /* next rung */ }
  }
  return null;
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

export type SkillState = "current" | "stale" | "missing" | "unshipped";

/**
 * Pure, so the four states can be tested without a filesystem.
 *
 * `unshipped` is its own answer rather than folded into `missing`: one of them
 * is the user's to fix by pressing Install, and the other means this build
 * cannot fix it at all — the file it would copy is not in it.
 */
export function skillState(shipped: Buffer | null, installed: Buffer | null): SkillState {
  if (!shipped) return "unshipped";
  if (!installed) return "missing";
  return digest(shipped) === digest(installed) ? "current" : "stale";
}

export type CliState = "installed" | "dangling" | "missing";

/**
 * `lstat` first, and never `existsSync`.
 *
 * existsSync follows the link, so the state this whole pane was written for —
 * a symlink into a directory that has since been deleted — answers "missing",
 * and the pane then tells somebody to install a thing that is already
 * installed and pointing at nothing.
 */
export function cliState(path: string): { state: CliState; target: string | null } {
  let link: ReturnType<typeof lstatSync>;
  try { link = lstatSync(path); } catch { return { state: "missing", target: null }; }
  if (!link.isSymbolicLink()) {
    // A real file somebody put there themselves. It is on PATH and it runs;
    // this is not the shape the installer makes, and saying so is not the
    // pane's business.
    return { state: "installed", target: path };
  }
  let target: string | null = null;
  try { target = resolve(dirname(path), readlinkSync(path)); } catch { return { state: "dangling", target: null }; }
  return { state: existsSync(target) ? "installed" : "dangling", target };
}

export interface BrowserUseStatus {
  /** The CLI agents call. */
  cli: { state: CliState; path: string; target: string | null };
  /** The skill that tells them it exists. */
  skill: { state: SkillState; path: string; shipped: string | null };
  /** Whether a window is currently able to answer an ask at all. */
  windows: number;
  /** Whether this instance is even the kind that has a browser. */
  desktop: boolean;
}

export function browserUseStatus(readyWindows: number, desktop: boolean): BrowserUseStatus {
  const shippedPath = shippedSkill();
  const read = (p: string | null): Buffer | null => {
    if (!p) return null;
    try { return readFileSync(p); } catch { return null; }
  };
  const dest = skillDest();
  const link = cliLink();
  const cli = cliState(link);
  return {
    cli: { state: cli.state, path: link, target: cli.target },
    skill: { state: skillState(read(shippedPath), read(dest)), path: dest, shipped: shippedPath },
    windows: readyWindows,
    desktop,
  };
}

export interface InstallResult { ok: boolean; path?: string; backup?: string; error?: string }

/**
 * Put the shipped skill where agents look, keeping whatever was there.
 *
 * Backed up rather than clobbered, the way hooksetup.ts treats settings.json:
 * this writes into a directory that is the user's, not ours, and somebody may
 * have edited that file on purpose. A stamped copy beside it costs nothing and
 * is the difference between an install and a small act of vandalism.
 *
 * Writes only when the bytes actually differ, so pressing Install twice does
 * not leave a trail of identical backups.
 */
export function installSkill(): InstallResult {
  const src = shippedSkill();
  if (!src) return { ok: false, error: "this build does not carry the skill file" };
  const dest = skillDest();
  let current: Buffer | null = null;
  try { current = readFileSync(dest); } catch { /* not there yet */ }
  let shipped: Buffer;
  try { shipped = readFileSync(src); } catch (e) { return { ok: false, error: `could not read ${src}: ${e instanceof Error ? e.message : e}` }; }
  if (current && digest(current) === digest(shipped)) return { ok: true, path: dest };

  let backup: string | undefined;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    if (current) {
      backup = `${dest}.bak.agentglass.${digest(current)}`;
      copyFileSync(dest, backup);
    }
    writeFileSync(dest, shipped);
  } catch (e) {
    return { ok: false, error: `could not write ${dest}: ${e instanceof Error ? e.message : e}` };
  }
  return { ok: true, path: dest, backup };
}
