// A read-only GitHub door for walled workers.
//
// A worker under the read wall cannot reach the keyring, so `gh` fails there on
// purpose: handing the token in would undo the wall. This is the other side of
// that choice. The worker asks the server, the server runs `gh` itself with the
// credential it already holds for the PR panel, and only the answer goes back.
//
// What makes it a door and not a hole:
//   - an ALLOW list of verbs and flags, never a deny list; anything else gets
//     one sentence ("<verb> is not a read"), and `gh api` is not on the list;
//   - the repo is the caller's project's, never the one the ask names;
//   - nothing shaped like a token goes in (browserdrive's own check, plus the
//     `ghp_` family) and nothing shaped like one comes out;
//   - a per-worker budget, and one log line per call with the worker's name.

import { bodyCarriesToken } from "./browserdrive.ts";
import { runChild } from "./broker/brokerRun.ts";

export interface GhOut { code: number; stdout: string; stderr: string; capped?: boolean }
export type GhDoorResult =
  | { ok: true; code: number; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; error: string; status: number };

export const GH_DOOR_PER_MINUTE = 30;
export const GH_DOOR_OUT_MAX = 200_000;

const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
/** Anything shaped like a GitHub token, cut out of a string. */
export function scrubToken(s: string): string { return s.replace(TOKEN_SHAPE, "[token removed]"); }

const REFUSE_TOKEN = "a token-shaped string in the ask is refused: this door never takes or shows a credential.";
const WRITE_VERBS = new Set([
  "comment", "merge", "review", "edit", "create", "close", "reopen", "ready", "lock", "unlock", "delete", "develop",
  "transfer", "pin", "unpin", "rerun", "cancel", "checkout", "update-branch", "revert", "set-default", "fork", "sync",
]);

interface Verb { flags: Record<string, "bool" | "value">; positional: "number" | "ref" | "none"; optional?: boolean }
/* No --jq / --template: gh's jq has $ENV, which would read the server's environment. */
const FLAGS_JSON = { "--json": "value" } as const;
const VERBS: Record<string, Verb> = {
  "pr view": { flags: { ...FLAGS_JSON, "--comments": "bool" }, positional: "ref", optional: true },
  "pr diff": { flags: { "--name-only": "bool", "--patch": "bool" }, positional: "ref", optional: true },
  "pr checks": { flags: { ...FLAGS_JSON, "--required": "bool" }, positional: "ref", optional: true },
  "pr list": { flags: { ...FLAGS_JSON, "--state": "value", "-s": "value", "--limit": "value", "-L": "value", "--head": "value", "-H": "value", "--base": "value", "-B": "value" }, positional: "none" },
  "run view": { flags: { ...FLAGS_JSON, "--log-failed": "bool", "--job": "value", "-j": "value" }, positional: "number", optional: true },
  "run list": { flags: { ...FLAGS_JSON, "--limit": "value", "-L": "value", "--branch": "value", "-b": "value" }, positional: "none" },
  "issue view": { flags: { ...FLAGS_JSON, "--comments": "bool" }, positional: "number" },
  "issue list": { flags: { ...FLAGS_JSON, "--state": "value", "-s": "value", "--limit": "value", "-L": "value" }, positional: "none" },
};
const FLAG_VALUE = /^[A-Za-z0-9_.,:/@ -]{1,200}$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/;

export const GH_DOOR_VERBS = Object.keys(VERBS);

/** The `gh` argv a worker's ask turns into, or the one sentence that refuses it. */
export function planGhRead(argv: unknown, slug: string): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string") || argv.length === 0 || argv.length > 24) {
    return { ok: false, error: "argv: a list of up to 24 strings, like [\"pr\",\"view\",\"123\"]." };
  }
  const a = argv as string[];
  if (bodyCarriesToken(a) || a.some((s) => { TOKEN_SHAPE.lastIndex = 0; return TOKEN_SHAPE.test(s); })) return { ok: false, error: REFUSE_TOKEN };
  if (a[0] === "auth") return { ok: false, error: "`gh auth` is not offered: this door never prints or takes a token." };
  if (a[0] === "api") return { ok: false, error: "`gh api` is not offered: it can write, so only the named read verbs are." };
  if (WRITE_VERBS.has(a[1] ?? "")) return { ok: false, error: `${a[0]} ${a[1]} writes, and this door only reads.` };
  const key = `${a[0]} ${a[1] ?? ""}`;
  const verb = VERBS[key];
  if (!verb) return { ok: false, error: `"${a.slice(0, 2).join(" ")}" is not a read this door offers. Reads: ${GH_DOOR_VERBS.join(", ")}.` };
  const out: string[] = [a[0], a[1]];
  let positional: string | undefined;
  for (let i = 2; i < a.length; i++) {
    const s = a[i];
    if (s.startsWith("-")) {
      const [name, inline] = s.includes("=") ? [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)] : [s, undefined];
      if (name === "--repo" || name === "-R") {
        const v = inline ?? a[++i];
        if ((v ?? "").toLowerCase() !== slug.toLowerCase()) return { ok: false, error: `this door reads ${slug} only, the repo of the project this worker belongs to.` };
        continue;
      }
      const kind = verb.flags[name];
      if (!kind) return { ok: false, error: `${name} is not a flag this door passes to "${key}".` };
      if (kind === "bool") { if (inline !== undefined) return { ok: false, error: `${name} takes no value.` }; out.push(name); continue; }
      const v = inline ?? a[++i];
      if (v === undefined || !FLAG_VALUE.test(v)) return { ok: false, error: `${name} needs a plain value.` };
      out.push(name, v);
      continue;
    }
    if (positional !== undefined) return { ok: false, error: `"${key}" takes one argument.` };
    positional = s;
  }
  if (verb.positional === "none" && positional !== undefined) return { ok: false, error: `"${key}" takes no argument.` };
  if (positional === undefined && verb.positional !== "none" && !verb.optional) return { ok: false, error: `"${key}" needs a number.` };
  if (positional !== undefined) {
    const good = verb.positional === "number" ? /^\d{1,12}$/.test(positional) : /^\d{1,12}$/.test(positional) || REF.test(positional);
    if (!good) return { ok: false, error: verb.positional === "number" ? "the argument is a number." : "the argument is a number or a branch name, not a URL." };
    out.push(positional);
  }
  out.push("--repo", slug);
  return { ok: true, args: out };
}

const calls = new Map<string, number[]>();
/** Whether this worker has budget left; a call that passes is counted. */
export function takeBudget(worker: string, now = Date.now(), per = GH_DOOR_PER_MINUTE): boolean {
  const recent = (calls.get(worker) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= per) { calls.set(worker, recent); return false; }
  recent.push(now);
  calls.set(worker, recent);
  if (calls.size > 500) for (const [k, v] of calls) if (!v.some((t) => now - t < 60_000)) calls.delete(k);
  return true;
}
export const GH_DOOR_GLOBAL_PER_MINUTE = 120;
export const GH_DOOR_MAX_CONCURRENT = 4;
let allCalls: number[] = [];
let running = 0;
/** Every caller together: one more worker is not one more 30 a minute. */
export function takeGlobal(now = Date.now(), per = GH_DOOR_GLOBAL_PER_MINUTE): boolean {
  allCalls = allCalls.filter((t) => now - t < 60_000);
  if (allCalls.length >= per) return false;
  allCalls.push(now);
  return true;
}
export function resetBudgets(): void { calls.clear(); allCalls = []; running = 0; pins.clear(); }

/* The repo a project reads is fixed the first time the SERVER resolves it, which
   is when a worker credential is minted (auth.ts mint hook), before the worker
   can run anything. A later `git remote set-url` in the shared .git changes
   nothing here. */
const pins = new Map<string, Promise<string | null>>();
export function pinProjectSlug(root: string, resolve: (root: string) => Promise<string | null>): Promise<string | null> {
  let p = pins.get(root);
  if (!p) {
    p = resolve(root).catch(() => null);
    pins.set(root, p);
    void p.then((v) => { if (v === null && pins.get(root) === p) pins.delete(root); });
  }
  return p;
}

const ENV_KEYS = ["PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "LANG"];
/** What gh is given: its own few variables, never an agentglass one. */
export function ghEnv(src: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const k of ENV_KEYS) if (src[k] !== undefined) out[k] = src[k]!;
  return out;
}

/** gh with a minimal env, killed once stdout passes the cap. */
export async function runGh(args: string[], cwd?: string): Promise<GhOut & { capped?: boolean }> {
  const bin = Bun.which("gh");
  if (!bin) return { code: 127, stdout: "", stderr: "gh not found" };
  // Started by the spawn broker (broker/brokerRun.ts), not a fork of this server.
  const p = await runChild([bin, ...args], { cwd, env: ghEnv(process.env), timeoutMs: 25_000, maxBytes: GH_DOOR_OUT_MAX });
  if (p.error !== undefined && p.error !== "lost") throw new Error(p.error);
  return { code: p.code ?? 1, stdout: p.stdout, stderr: p.stderr, capped: p.truncated };
}

export interface GhDoorDeps {
  gh?: (args: string[], cwd?: string) => Promise<GhOut>;
  slugOf: (root: string) => Promise<string | null>;
  log?: (line: string) => void;
}

/** One ask: who (worker), for which project root, and the `gh` words. */
export async function ghRead(worker: string, root: string | undefined, argv: unknown, deps: GhDoorDeps): Promise<GhDoorResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const note = (outcome: string) => log(JSON.stringify({ event: "gh.door", worker, argv: Array.isArray(argv) ? scrubToken(argv.map(String).slice(0, 8).join(" ")) : null, outcome }));
  if (!root) { note("no-project"); return { ok: false, status: 403, error: "this worker has no project, so there is no repo to read." }; }
  const slug = await pinProjectSlug(root, deps.slugOf);
  if (!slug) { note("no-repo"); return { ok: false, status: 400, error: "this project has no GitHub remote." }; }
  const plan = planGhRead(argv, slug);
  if (!plan.ok) { note("refused"); return { ok: false, status: 403, error: plan.error }; }
  if (!takeBudget(worker)) { note("rate-limited"); return { ok: false, status: 429, error: `${GH_DOOR_PER_MINUTE} reads a minute per worker; wait and ask again.` }; }
  if (!takeGlobal()) { note("rate-limited-global"); return { ok: false, status: 429, error: `${GH_DOOR_GLOBAL_PER_MINUTE} reads a minute across all workers; wait and ask again.` }; }
  if (running >= GH_DOOR_MAX_CONCURRENT) { note("busy"); return { ok: false, status: 429, error: `${GH_DOOR_MAX_CONCURRENT} reads are already running; ask again in a moment.` }; }
  running++;
  let r: GhOut;
  try { r = await (deps.gh ?? runGh)(plan.args, root); } finally { running--; }
  note(r.code === 0 ? "ok" : "gh-failed");
  const full = scrubToken(r.stdout);
  const truncated = !!r.capped || full.length > GH_DOOR_OUT_MAX;
  return { ok: true, code: r.code, stdout: truncated ? full.slice(0, GH_DOOR_OUT_MAX) : full, stderr: scrubToken(r.stderr).slice(0, 4000), truncated };
}
