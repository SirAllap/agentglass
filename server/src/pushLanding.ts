// Where a `git push` that names no destination lands.
//
// The rules match the command's text, and `git push` holds no target: the
// checked-out branch, `branch.<b>.merge` and `push.default` decide it. This
// reads those from the command's cwd (`git -C` counts) and says what the
// text could not. It answers only for a push with no destination refspec;
// one that names a destination is the rules' to read.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { shellCalls } from "../../shared/agentRules.ts";
import { refusal } from "../../shared/refusal.ts";
import { waitedFor } from "./loopwatch.ts";

const PROTECTED = new Set(["main", "master"]);
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

const unquote = (w: string): string => w.replace(/^(["'])(.*)\1$/, "$2");

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = waitedFor(`git ${args[0] ?? ""} (push landing)`, () => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }));
    return { ok: r.status === 0, out: String(r.stdout ?? "").trim() };
  } catch { return { ok: false, out: "" }; }
}

const CANNOT = refusal("rule", "cannot tell where this push lands (detached HEAD or git error); name the destination: git push origin <branch>");

/** One shell command: null when it is no push, or names its destination, or lands somewhere harmless; else the refusal text. */
function landing(cmd: string, cwdIn: string): string | null {
  const w = cmd.split(/\s+/).filter(Boolean).map(unquote);
  // A wrapper (`env X=1 git push`, `bash -c 'git -C d push'`) may come first: start at the word `git`.
  const g0 = w.indexOf("git");
  if (g0 < 0) return null;
  w.splice(0, g0);
  let i = 1;
  let cwd = cwdIn;
  const gitOpts: string[] = [];
  while (i < w.length && w[i]!.startsWith("-")) {
    const f = w[i]!;
    if (f === "-C") { cwd = resolve(cwd, w[i + 1] ?? "."); i += 2; continue; }
    if (f === "-c") { gitOpts.push("-c", w[i + 1] ?? ""); i += 2; continue; }
    i += GIT_VALUED.has(f) ? 2 : 1;
  }
  if (w[i] !== "push") return null;
  const pos: string[] = [];
  for (i += 1; i < w.length; i++) {
    const f = w[i]!;
    if (f === "--") { pos.push(...w.slice(i + 1)); break; }
    if (f.startsWith("-")) { if (PUSH_VALUED.has(f)) i++; continue; }
    pos.push(f);
  }
  // `HEAD` alone is "the current branch under its own name": no destination either.
  const refspecs = pos.slice(1).filter((r) => r !== "HEAD");
  if (refspecs.length) return null;
  const q = (args: string[]) => git(cwd, [...gitOpts, ...args]);
  const head = q(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!head.ok || !head.out) return CANNOT;
  const b = head.out;
  const merge = q(["config", "--get", `branch.${b}.merge`]).out.replace(/^refs\/heads\//, "");
  const pd = q(["config", "--get", "push.default"]);
  const mode = pd.ok && pd.out ? pd.out : "simple";
  const lands = new Set<string>();
  if (mode === "upstream" || mode === "tracking") lands.add(merge);
  else if (mode === "nothing") return null;
  else if (mode === "matching") {
    for (const p of PROTECTED) if (q(["rev-parse", "--verify", "--quiet", `refs/heads/${p}`]).ok) lands.add(p);
    lands.add(b);
  } else { lands.add(b); if (merge) lands.add(merge); }
  for (const d of lands) {
    if (PROTECTED.has(d)) return refusal("rule", `never git push origin ${d}: this push names no destination and lands on ${d} (branch ${b}, push.default ${mode})`);
  }
  return null;
}

/** The refusal text for a Bash command holding a push that lands on main/master, else null. */
export function pushLandsOnProtected(command: string, cwd: string): string | null {
  // The rules' reader drops `git -C dir`, so the raw pieces are read too: `-C` moves the repo the push reads.
  const pieces = command.split(/&&|\|\||[;|\n()`]|\$\(/).map((p) => p.trim()).filter(Boolean);
  // Only when the rules' own reader sees a push (quotes and heredocs are not commands): the pieces then say which repo.
  if (!shellCalls(command).some((s) => !s.text && /(^|\s)git(\s.*)?\spush(\s|$)/.test(s.cmd))) return null;
  for (const c of pieces) {
    const r = landing(c, cwd);
    if (r) return r;
  }
  return null;
}
