// "This checkout cannot run its own checks yet" — the environment, not the code.
//
// A fresh `git worktree add` has no node_modules, and bun installs each
// workspace's own, so a checkout with only the root linked still fails: measured
// on a worktree whose root node_modules was a symlink and whose web/ was not,
// `tsc` in web/ answered `TS2688 Cannot find type definition file for
// 'vite/client'`. That reads as a type error in somebody's change and is not one.
//
// So the question is asked once, here, and the same sentence goes into every
// place that needs to say it: the start answer of a worker, its first prompt
// line, and `bun scripts/depscheck.ts` (what `make typecheck` and `make check`
// run first). Read-only: it installs nothing and starts nothing.
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CheckoutDeps {
  /** Repo-relative directories with no node_modules, the root as "" — `["", "web"]`. */
  missing: string[];
  /** One sentence, identical wherever it is said, so nobody has to guess whether two reports agree. */
  line: string;
}

const isDir = (p: string): boolean => {
  try {
    // Follows a symlink: a link to a real install is one, a dangling link is not.
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Whether bun's install would put a node_modules beside this manifest. Measured
 * with a real install: a workspace with no dependency of its own gets none, so
 * asking for one reports a healthy tree as missing.
 */
function declaresDeps(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown> | null;
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .some((k) => { const v = pkg?.[k]; return !!v && typeof v === "object" && Object.keys(v).length > 0; });
  } catch {
    return false;
  }
}

/**
 * Where node_modules is expected: the root, and every workspace that has a
 * dependency of its own. A dependency-free workspace is not asked for one —
 * that is bun's own rule, read off an install, not (yet) a record bun keeps
 * somewhere this could read; a workspace that never installs anything of its
 * own would be reported missing by the simpler rule, on a healthy tree.
 */
function expected(dir: string): string[] | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;
  const ws = (pkg as { workspaces?: unknown }).workspaces;
  // A list, which is what this checkout's package.json has; the object form
  // (`{ "packages": [] }`) is legal bun and not read here.
  const named = Array.isArray(ws) ? ws.filter((w): w is string => typeof w === "string") : [];
  // The root always, and a workspace only while the checkout has that directory:
  // a package.json naming a folder this commit does not carry is not a gap.
  return ["", ...named.filter((w) => isDir(resolve(dir, w)) && declaresDeps(resolve(dir, w)))];
}

/**
 * The node_modules this checkout is missing, or null when it has them all — and
 * null for a directory with no package.json, which is not a checkout at all.
 */
export function nodeModulesGap(dir: string): CheckoutDeps | null {
  const root = resolve(dir);
  const dirs = expected(root);
  if (!dirs) return null;
  const missing = dirs.filter((d) => !isDir(join(root, d, "node_modules")));
  if (!missing.length) return null;
  const names = missing.map((d) => (d ? `${d}/node_modules` : "node_modules")).join(", ");
  return {
    missing,
    line: `environment: node_modules missing (${names}) — run \`bun install\` in ${root}; a typecheck that fails before that is the environment, not the code.`,
  };
}

/**
 * The prompt a worker is handed, with the sentence in front of it.
 *
 * First line, because it is about to run a check and read its failure; left
 * alone when there is nothing to hand over or when the sentence is already
 * there (a later turn re-reads the prompt file, which carries it).
 */
export function withDepsLine(prompt: string, gap: CheckoutDeps | null): string {
  if (!gap || !prompt.trim() || prompt.startsWith(gap.line)) return prompt;
  return `${gap.line}\n\n${prompt}`;
}
