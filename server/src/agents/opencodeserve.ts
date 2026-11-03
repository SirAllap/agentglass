/*
 * OpenCode 2.x workers run under a private `opencode serve` of their own.
 *
 * Measured on 2.1.4: `opencode run` without `--standalone` or `--server` sends
 * the turn to one long-lived background service that never sees the worker's
 * environment, so the lock in OPENCODE_CONFIG_CONTENT is ignored (a denied
 * `echo` ran). No command of 2.x prints an agent's merged rules either
 * (`debug agent` is gone, `debug agents` lists nothing). What does work: a
 * `serve` started with the lock lists its agents on GET /api/agent with the
 * RESOLVED rules, and `run --server <it>` obeys them even when the client's
 * environment carries no lock. So the process that is asked is the process that
 * enforces, and the worker never runs without having been checked.
 *
 * Fails closed everywhere: a serve that does not come up, answers with a shape
 * this does not know, has no `shell` rule, or lists a loosened lock refuses the
 * worker and is stopped. Nothing here ever falls back to a plain `run`.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockLoosened, openCodeVersion } from "../agentops.ts";
import type { Turn } from "./headless.ts";

export interface Serve { url: string; password: string; pids: number[] }
type Rule = { permission: string; pattern: string; action: string };
type Opened = { ok: true; serve: Serve } | { ok: false; error: string };

const auth = (pw: string) => ({ authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` });

/** SIGTERM to a pid this module recorded, and only while it is still an OpenCode `serve`
 *  (a pid can be reused). Never a pattern, never a group. */
export function stopServe(s: Serve | null): void {
  const stop = (pid: number, signal: NodeJS.Signals) => {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("serve")) return;
      process.kill(pid, signal);
    } catch { /* gone */ }
  };
  for (const pid of s?.pids ?? []) {
    stop(pid, "SIGTERM");
    setTimeout(() => stop(pid, "SIGKILL"), 3_000).unref(); // one that ignored the first
  }
}

/** What 2.x calls the lock's permissions (measured on 2.1.4: `bash` is `shell`, `task` is `subagent`; a name left unmapped
 *  would let a later `*` allow read as loosening it, and refuses the worker). */
const NAMES: Record<string, string> = { shell: "bash", subagent: "task" };

/** The rules 2.x resolved for the agent, in the shape `lockLoosened` reads: its `shell` is the lock's `bash`.
 *  Null when the answer is not the shape measured, or has no shell rule. */
export function serveRules(body: unknown, agent: string): Rule[] | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const a = data.find((x) => (x as { id?: unknown } | null)?.id === agent) as { permissions?: unknown } | undefined;
  if (!a || !Array.isArray(a.permissions) || a.permissions.length === 0) return null;
  const rules: Rule[] = [];
  for (const r of a.permissions as { action?: unknown; resource?: unknown; effect?: unknown }[]) {
    if (typeof r?.action !== "string" || typeof r.resource !== "string" || typeof r.effect !== "string") return null;
    rules.push({ permission: NAMES[r.action] ?? r.action, pattern: r.resource, action: r.effect });
  }
  return rules.some((r) => r.permission === "bash") ? rules : null;
}

/** Start the serve with the lock, ask it, and keep it only if the lock holds. */
export async function startLockedServe(bin: string, cwd: string, env: Record<string, string>, timeoutMs = 20_000): Promise<Opened> {
  const lock = env.OPENCODE_CONFIG_CONTENT;
  if (!lock) return { ok: false, error: "the role carries no OpenCode lock" };
  let agent: string;
  try { agent = (JSON.parse(lock) as { default_agent?: string }).default_agent ?? "build"; } catch { return { ok: false, error: "the role's OpenCode lock is not JSON" }; }
  const password = randomBytes(24).toString("base64url");
  const dir = mkdtempSync(join(tmpdir(), "agx-oc-serve-"));
  const file = join(dir, "serve.out");
  const pids: number[] = [];
  const fail = (why: string): Opened => { stopServe({ url: "", password, pids }); return { ok: false, error: `the private OpenCode server could not vouch for the lock: ${why}` }; };
  try {
    // This app's own credentials stay out of the server, as the wrapper keeps them out of the window.
    const { AGENTGLASS_TOKEN: _t, AGENTGLASS_SEAT: _s, ...base } = process.env;
    const proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd, env: { ...base, ...env, OPENCODE_SERVER_PASSWORD: password } as Record<string, string>,
      stdin: "ignore", stdout: Bun.file(file), stderr: "ignore",
    });
    proc.unref();
    pids.push(proc.pid);
    const deadline = Date.now() + timeoutMs;
    let url = "";
    while (Date.now() < deadline && !url) {
      url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
      if (!url) await Bun.sleep(100);
    }
    if (!url) return fail("it did not come up");
    const get = async (path: string) => {
      const r = await fetch(url + path, { headers: auth(password), signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) });
      if (!r.ok) throw new Error(`${path} answered ${r.status}`);
      return (await r.json()) as unknown;
    };
    // The listener may be a child of the launcher: its own pid is the one to stop.
    const pid = (await get("/api/info") as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 2) return fail("it did not say its pid");
    if (!pids.includes(pid)) pids.push(pid);
    await get("/api/location");
    /* Agents are listed only once the directory has loaded, and the list is not whole the first time
       it is non-empty (measured on 2.1.4: [] at once, then a list whose build agent still lacked its
       shell rules in one run in three). So the answer is judged when two reads in a row, 300 ms apart,
       say the same non-empty thing; never "ask again until it says yes". At the deadline the last
       read is judged as it stands, and a half-loaded one is a refusal like any other. */
    let listed = await get("/api/agent");
    let before = "";
    while (Date.now() < deadline) {
      const now = JSON.stringify((listed as { data?: unknown } | null)?.data ?? null);
      if (now !== "[]" && now !== "null" && now === before) break;
      before = now;
      await Bun.sleep(300);
      listed = await get("/api/agent");
    }
    const rules = serveRules(listed, agent);
    if (!rules) return fail(`it lists no resolved shell rules for its ${agent} agent`);
    const hit = lockLoosened(rules, lock);
    if (hit) return fail(hit.rule ? `\`${hit.subject}\` is allowed by the ${hit.rule.permission} rule \`${hit.rule.pattern}\`: ${hit.rule.action}` : `\`${hit.subject}\` is not denied by any rule`);
    return { ok: true, serve: { url, password, pids } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "unknown error");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Whether this OpenCode needs the private server: 2.x and later, or one that will not say its version. */
export async function needsServe(bin: string, cwd: string): Promise<boolean> {
  const v = await openCodeVersion(bin, cwd, {});
  const major = Number(v.split(".")[0]);
  return !v || !Number.isInteger(major) || major >= 2;
}

/**
 * A locked OpenCode turn on 2.x, rewritten to run against its own checked server:
 * `run --server <url>`, the password in the client's environment and the lock only
 * in the server's. The wrapper stops the server by the recorded pids when the turn ends.
 * Any other engine, or an OpenCode that still has `debug agent`, passes through.
 */
export async function guardTurn(engine: string, bin: string, cwd: string, turn: Extract<Turn, { ok: true }>):
  Promise<{ ok: true; turn: Extract<Turn, { ok: true }>; serve: Serve | null } | { ok: false; error: string }> {
  if (engine !== "opencode" || !(await needsServe(bin, cwd))) return { ok: true, turn, serve: null };
  const opened = await startLockedServe(bin, cwd, turn.env);
  if (!opened.ok) return opened;
  const { serve } = opened;
  const at = turn.argv.indexOf("run");
  if (at < 0) { stopServe(serve); return { ok: false, error: "the OpenCode command line has no `run` to point at the checked server" }; }
  const { OPENCODE_CONFIG_CONTENT: _lock, ...client } = turn.env;
  const argv = [...turn.argv.slice(0, at + 1), "--server", serve.url, ...turn.argv.slice(at + 1)];
  return { ok: true, serve, turn: { ...turn, argv, env: { ...client, OPENCODE_SERVER_PASSWORD: serve.password, AGX_SERVE_PIDS: serve.pids.join(" ") } } };
}
