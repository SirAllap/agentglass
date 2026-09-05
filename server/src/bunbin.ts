/*
 * WHERE `bun` IS, asked of the disk rather than of the PATH.
 *
 * A run's verdict is `bun test`, and its worktree is filled by `bun install`.
 * Both were spawned as the bare word `bun`, which works in every shell anybody
 * develops in and fails in the one place it matters: the packaged desktop app,
 * started from a launcher, whose PATH is whatever the session manager handed
 * it. Measured today in the deputy's own register:
 *
 *     the run threw and could not finish: ENOENT: no such file or directory,
 *     posix_spawn 'bun'
 *
 * The run died forty seconds in, its worktree was swept as barren, and the row
 * said the branch was gone — three sentences, none of which mentions a missing
 * program.
 *
 * `Bun.which` is asked FIRST but never trusted alone: this repository has
 * already measured it ignoring a PATH changed at runtime, so the candidates
 * below are checked directly. They are the places bun installs itself into on
 * this kind of machine, most specific first.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Every place worth looking, in order. Exported so a test can point the
 *  search at a directory it made rather than at whatever this machine has. */
export function bunCandidates(env: Record<string, string | undefined> = process.env, home = process.env.HOME ?? ""): string[] {
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p)) out.push(p); };
  if (env.AGENTGLASS_BUN) add(env.AGENTGLASS_BUN);
  if (env.BUN_INSTALL) add(join(env.BUN_INSTALL, "bin", "bun"));
  if (home) add(join(home, ".bun", "bin", "bun"));
  add("/home/linuxbrew/.linuxbrew/bin/bun");
  if (home) add(join(home, ".local", "bin", "bun"));
  add("/usr/local/bin/bun");
  add("/opt/homebrew/bin/bun");
  add("/usr/bin/bun");
  return out;
}

/**
 * The bun to spawn, or "" when this machine has none.
 *
 * Returning "" rather than falling back to the bare word is deliberate: the
 * caller can then say WHICH program is missing, instead of handing a person an
 * ENOENT from inside a run that looks like the task failed.
 */
export function bunBin(
  env: Record<string, string | undefined> = process.env,
  home = process.env.HOME ?? "",
  exists: (p: string) => boolean = existsSync,
): string {
  for (const p of bunCandidates(env, home)) if (exists(p)) return p;
  try {
    const found = Bun.which("bun");
    if (found && exists(found)) return found;
  } catch { /* no which, no answer */ }
  return "";
}

/** What to tell somebody when there is none, naming the places looked. */
export const NO_BUN = (env: Record<string, string | undefined> = process.env, home = process.env.HOME ?? ""): string =>
  `cannot find \`bun\` from inside the app — looked in ${bunCandidates(env, home).join(", ")}. `
  + "Set AGENTGLASS_BUN to its path, or install bun where the app can see it.";
