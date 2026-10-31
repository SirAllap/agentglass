/*
 * What a flight-plan builder may not do from its shell or with a file tool, as a
 * verdict on one pre-tool call. The builder's launch already passes a deny list
 * as `--disallowedTools`, which is a prefix match: `git -C . push`, `/usr/bin/git
 * push`, `env git push` and `sh -c 'git push'` all walk past it. This reads the
 * command the way a shell would, enough to see through those, and it holds the
 * builder's file writes (the tools and the shell's `>`, `tee`, `sed -i`, `cp`...)
 * inside its worktree.
 *
 * shortcut: a script the builder writes inside its worktree and then runs, a
 * command built from a variable, `eval`, and a program that writes where it is
 * not told to are not seen: this parses a command line, it is no sandbox.
 * Upgrade by running builders in one. GitHub's branch protection stays the hard
 * wall for anything remote, and, like every rule, this answers only while the
 * server does within the hook's 2 s.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface GuardCtx {
  /** The builder's worktree, as launched. */
  worktree: string;
  /** Where the call runs (the hook's cwd). */
  cwd: string;
  /** The one scratch directory this builder may write besides its worktree. */
  tmp: string;
  /** The project's base branch name, besides main and master. */
  base: string | null;
  home: string;
}
export type GuardVerdict = { decision: "never"; ruleId: string; reason: string } | null;

/** The real path of a file that may not exist: symlinks resolved, a dangling link followed to where it points, a missing tail appended to its nearest existing parent. */
export function realish(path: string, depth = 0): string {
  const rest: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try { return join(realpathSync(cur), ...rest); } catch { /* not there, or dangling */ }
    try {
      if (lstatSync(cur).isSymbolicLink() && depth < 20) return join(realish(resolve(dirname(cur), readlinkSync(cur)), depth + 1), ...rest);
    } catch { /* not a link either */ }
    const up = dirname(cur);
    if (up === cur) return join(cur, ...rest);
    rest.unshift(basename(cur)); cur = up;
  }
}
export const isInside = (real: string, root: string): boolean => { const r = realish(root); return real === r || real.startsWith(r + sep); };

/* ── reading a command line ── */

interface Tok { s: string; op?: boolean }
/** Splits a command line into segments of words, with redirections as `op` words. Command substitutions are returned apart, to be read as commands of their own. */
export function splitShell(cmd: string): { segments: Tok[][]; nested: string[] } {
  const segments: Tok[][] = [[]];
  const nested: string[] = [];
  let cur = "", has = false, i = 0;
  const seg = () => segments[segments.length - 1]!;
  const push = () => { if (has) seg().push({ s: cur }); cur = ""; has = false; };
  const cut = () => { push(); if (seg().length) segments.push([]); };
  const inner = (open: string, close: string, from: number): number => {
    let depth = 1, j = from;
    for (; j < cmd.length && depth > 0; j++) {
      if (cmd[j] === open && close !== open) depth++;
      else if (cmd[j] === close) depth--;
      else if (cmd[j] === "\\") j++;
    }
    nested.push(cmd.slice(from, j - 1));
    return j;
  };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "\\") { cur += cmd[i + 1] ?? ""; has = true; i += 2; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1); const end = e < 0 ? cmd.length : e; cur += cmd.slice(i + 1, end); has = true; i = end + 1; continue; }
    if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\") { cur += cmd[i + 1] ?? ""; i += 2; continue; }
        if (cmd[i] === "$" && cmd[i + 1] === "(") { i = inner("(", ")", i + 2); cur += "$SUB"; continue; }
        if (cmd[i] === "`") { i = inner("`", "`", i + 1); cur += "$SUB"; continue; }
        cur += cmd[i]; i++;
      }
      has = true; i++; continue;
    }
    if (c === "$" && cmd[i + 1] === "(") { i = inner("(", ")", i + 2); cur += "$SUB"; has = true; continue; }
    if (c === "`") { i = inner("`", "`", i + 1); cur += "$SUB"; has = true; continue; }
    if (c === ";" || c === "\n" || c === "|" || (c === "&" && cmd[i + 1] !== ">" && cmd[i - 1] !== ">")) {
      cut(); i += c === "|" && cmd[i + 1] === "|" || c === "&" && cmd[i + 1] === "&" ? 2 : 1; continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") { if (!has) { i++; continue; } }
    if (c === ">" || c === "<" || (c === "&" && cmd[i + 1] === ">")) {
      // `2>` is a file descriptor on a redirection, not a word.
      if (has && /^\d+$/.test(cur)) { cur = ""; has = false; } else push();
      let op = "";
      while (i < cmd.length && /[<>&|]/.test(cmd[i]!) && op.length < 3) { op += cmd[i]; i++; }
      seg().push({ s: op, op: true });
      continue;
    }
    if (/\s/.test(c)) { push(); i++; continue; }
    cur += c; has = true; i++;
  }
  push();
  return { segments: segments.filter((s) => s.length), nested };
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Wrappers that run the command after them, and the options of each that take a value. */
const WRAPPERS: Record<string, string[]> = { env: ["-u", "-S", "-C", "--unset", "--chdir"], command: [], exec: ["-a"], nohup: [], time: [], nice: ["-n"], sudo: ["-u", "-g", "-h", "-p", "-U"], timeout: ["-k", "-s"], builtin: [], setsid: [], stdbuf: ["-i", "-o", "-e"] };

/** The words of one segment from the command itself on, with what runs it peeled off; `sh -c STRING` yields STRING to be read again. */
function unwrap(words: string[]): { cmd: string[]; shell: string | null } {
  let w = words.slice();
  for (let guard = 0; guard < 30 && w.length; guard++) {
    if (ASSIGN.test(w[0]!)) { w.shift(); continue; }
    const name = basename(w[0]!);
    if (name in WRAPPERS) {
      const takes = WRAPPERS[name]!;
      w.shift();
      if (name === "timeout") { while (w[0]?.startsWith("-")) w.shift(); w.shift(); continue; } // the duration
      while (w.length && (w[0]!.startsWith("-") || ASSIGN.test(w[0]!))) { const o = w.shift()!; if (takes.includes(o)) w.shift(); }
      continue;
    }
    if (SHELLS.has(name)) {
      const k = w.findIndex((x, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      if (k > 0 && w[k + 1] !== undefined) return { cmd: [], shell: w[k + 1]! };
    }
    if (/^(python3?|node|bun|perl|ruby)$/.test(name)) {
      const k = w.findIndex((x, n) => n > 0 && !x.startsWith("-"));
      if (k > 0 && /^agentglass-ui(-mcp)?$/.test(basename(w[k]!))) { w = w.slice(k); continue; }
    }
    break;
  }
  return { cmd: w, shell: null };
}

const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"]);
const GIT_NEVER = new Set(["push", "pull", "merge", "tag", "update-ref"]);
const BRANCH_DESTRUCTIVE = /^(-[a-zA-Z]*[fDMm][a-zA-Z]*|--force|--delete|--move|--copy)$/;
const refused = (ruleId: string, reason: string): GuardVerdict => ({ decision: "never", ruleId, reason });

function gitVerdict(args: string[], ctx: GuardCtx, names: Set<string>): GuardVerdict {
  let k = 0;
  const away: string[] = [];
  while (k < args.length && args[k]!.startsWith("-")) {
    const o = args[k]!, eq = o.indexOf("=");
    const key = eq > 0 ? o.slice(0, eq) : o;
    if (GIT_GLOBAL_WITH_VALUE.has(key)) {
      const v = eq > 0 ? o.slice(eq + 1) : args[++k] ?? "";
      if (key === "-C" || key === "--git-dir" || key === "--work-tree") away.push(v);
    }
    k++;
  }
  for (const p of away) {
    const real = realish(isAbsolute(p) ? p : resolve(ctx.cwd, p));
    if (!isInside(real, ctx.worktree)) return refused("flight-plan-git-away", `This builder works in ${ctx.worktree}: git may not be pointed at ${real}.`);
  }
  const sub = args[k], rest = args.slice(k + 1);
  if (!sub) return null;
  if (GIT_NEVER.has(sub)) return refused("flight-plan-git", `A builder never runs git ${sub}: the coordinator brings work in, and a rebase brings main into your branch. Report to your coordinator.`);
  const operands = rest.filter((x) => !x.startsWith("-"));
  const onBase = operands.some((x) => names.has(x.replace(/^(origin|upstream)\//, "")));
  if (sub === "branch" && rest.some((x) => BRANCH_DESTRUCTIVE.test(x)) && onBase) return refused("flight-plan-git", "A builder never rewrites or deletes the project's main branch.");
  if ((sub === "checkout" || sub === "switch") && onBase) return refused("flight-plan-git", "A builder stays on its own branch: it never checks out the project's main branch.");
  return null;
}

function ghVerdict(args: string[]): GuardVerdict {
  const words = [];
  for (let k = 0; k < args.length; k++) { if (args[k] === "-R" || args[k] === "--repo") { k++; continue; } words.push(args[k]!); }
  const sub = words.find((x) => !x.startsWith("-"));
  if (sub === "pr" || sub === "release") return refused("flight-plan-gh", `A builder never runs gh ${sub}: opening and landing work is the coordinator's and the person's.`);
  if (sub === "api") {
    const m = args.findIndex((x) => x === "-X" || x === "--method" || /^-X./.test(x) || x.startsWith("--method="));
    const method = m < 0 ? null : (args[m]!.includes("=") ? args[m]!.split("=")[1]! : /^-X./.test(args[m]!) ? args[m]!.slice(2) : args[m + 1] ?? "").toUpperCase();
    const writes = args.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x) || /^(-f|-F).+/.test(x) || x.startsWith("--field=") || x.startsWith("--raw-field=") || x.startsWith("--input="));
    const mutation = args.includes("graphql") && args.some((x) => /\bmutation\b/i.test(x));
    if ((method !== null && method !== "GET") || (method === null && writes) || mutation) return refused("flight-plan-gh", "A builder never writes through gh api: only GET reads.");
  }
  return null;
}

function uiVerdict(args: string[]): GuardVerdict {
  for (const group of ["settings", "rules"]) {
    const g = args.indexOf(group);
    if (g >= 0 && args.slice(g + 1).includes("set")) return refused("flight-plan-settings", `A builder never changes agentglass ${group}: ask your coordinator.`);
  }
  return null;
}

/* ── where a command writes ── */

const NO_VALUE_FLAGS = /^-/;
const OPT_VALUE: Record<string, string[]> = { cp: ["-t", "-S", "--target-directory", "--suffix"], mv: ["-t", "-S", "--target-directory", "--suffix"], install: ["-m", "-o", "-g", "-t", "-S", "--mode", "--owner", "--group", "--target-directory"], ln: ["-t", "-S", "--target-directory", "--suffix"], rm: [], tee: [], sed: ["-e", "-f", "--expression", "--file", "-l"] };
function operands(name: string, args: string[]): { files: string[]; target: string | null; scriptFlag: boolean } {
  const takes = OPT_VALUE[name] ?? [];
  const files: string[] = [];
  let target: string | null = null, scriptFlag = false, done = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!done && a === "--") { done = true; continue; }
    if (!done && NO_VALUE_FLAGS.test(a)) {
      if (name === "sed" && (a === "-e" || a === "-f" || a.startsWith("--expression") || a.startsWith("--file"))) scriptFlag = true;
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(0, eq) : a;
      if (takes.includes(key)) { const v = eq > 0 ? a.slice(eq + 1) : args[++k] ?? ""; if (key === "-t" || key === "--target-directory") target = v; }
      continue;
    }
    files.push(a);
  }
  return { files, target, scriptFlag };
}

/** The files a simple command writes or removes, by the commands the guard knows. */
function written(name: string, args: string[]): string[] {
  if (name === "tee") return operands("tee", args).files;
  if (name === "rm") return operands("rm", args).files;
  if (name === "mv") { const o = operands("mv", args); return [...o.files, ...(o.target ? [o.target] : [])]; }
  if (name === "cp" || name === "install" || name === "ln") { const o = operands(name, args); return o.target ? [o.target] : o.files.slice(-1); }
  if (name === "sed" && args.some((x) => /^-[a-zA-Z]*i/.test(x) || x === "--in-place" || x.startsWith("--in-place="))) {
    const o = operands("sed", args);
    return o.scriptFlag ? o.files : o.files.slice(1);
  }
  if (name === "dd") return args.filter((x) => x.startsWith("of=")).map((x) => x.slice(3));
  return [];
}

const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/stdin", "/dev/zero"]);
function writeVerdict(path: string, ctx: GuardCtx): GuardVerdict {
  if (DEVICES.has(path)) return null;
  let p = path.replace(/^\$\{?TMPDIR\}?(?=\/|$)/, ctx.tmp);
  if (p === "~" || p.startsWith("~/")) p = join(ctx.home, p.slice(1));
  if (/[$`*?]/.test(p)) return refused("flight-plan-worktree", `This builder works in ${ctx.worktree}: the check cannot tell where "${path}" is. Write the path out.`);
  const real = realish(isAbsolute(p) ? p : resolve(ctx.cwd, p));
  return isInside(real, ctx.worktree) || isInside(real, ctx.tmp) ? null
    : refused("flight-plan-worktree", `This builder works in ${ctx.worktree} and may not write ${real} from the shell either. If the change belongs outside it, tell your coordinator.`);
}

function inspect(cmd: string, ctx: GuardCtx, names: Set<string>, depth: number): GuardVerdict {
  if (depth > 6) return null;
  const { segments, nested } = splitShell(cmd);
  for (const n of nested) { const v = inspect(n, ctx, names, depth + 1); if (v) return v; }
  for (const seg of segments) {
    // Redirections write wherever they point, whatever command they hang on.
    for (let k = 0; k < seg.length; k++) {
      const t = seg[k]!;
      if (t.op && /^(&?>>?|>\|)$/.test(t.s) && seg[k + 1] && !seg[k + 1]!.op) { const v = writeVerdict(seg[k + 1]!.s, ctx); if (v) return v; }
    }
    const words = seg.filter((t, k) => !t.op && !(k > 0 && seg[k - 1]!.op)).map((t) => t.s);
    const { cmd: c, shell } = unwrap(words);
    if (shell !== null) { const v = inspect(shell, ctx, names, depth + 1); if (v) return v; continue; }
    if (!c.length) continue;
    const name = basename(c[0]!), args = c.slice(1);
    const v = name === "git" ? gitVerdict(args, ctx, names)
      : name === "gh" ? ghVerdict(args)
      : /^agentglass-ui(-mcp)?$/.test(name) ? uiVerdict(args)
      : null;
    if (v) return v;
    for (const f of written(name, args)) { const w = writeVerdict(f, ctx); if (w) return w; }
  }
  return null;
}

/** The verdict on one shell command a builder is about to run: null, or a "never" with the sentence the hook shows. */
export function commandVerdict(command: string, ctx: GuardCtx): GuardVerdict {
  const names = new Set(["main", "master", ...(ctx.base ? [ctx.base] : [])]);
  return inspect(command, ctx, names, 0);
}
