/*
 * THE AGENT RULES, END TO END: a booted server, the real PreToolUse hook as a
 * child process, and the person and an agent as two kinds of caller.
 *
 * What is asserted is what Claude Code would see: the JSON the hook prints on
 * stdout (a "deny" it obeys), the silence when nothing is decided, and the
 * stderr line when the server cannot be asked. The server runs with a machine
 * token and no desk key, so "the person" is a request from the app's origin and
 * "an agent" is the same token with no Origin (settings-door-route.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { AgentRulesView } from "../../shared/agentRules.ts";

const TOKEN = "tok-agent-rules-example";
const HOOK = new URL("../../hooks/send_event.py", import.meta.url).pathname;
const have = !!Bun.which("python3") && !!Bun.which("git");
let dir = "", root = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const fromAgent = () => ({ ...auth, "Content-Type": "application/json" });
const post = async (path: string, body: unknown, headers: Record<string, string>) => {
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const rules = async () => (await (await fetch(`${base}/agent-rules?root=${encodeURIComponent(root)}`, { headers: auth })).json()) as AgentRulesView;

/** The hook as Claude Code runs it: the payload on stdin, the answer on stdout. */
async function hook(command: string, permission_mode?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const port = new URL(base).port;
  const p = Bun.spawn(["python3", HOOK, "--server", base, "--event-type", "PreToolUse", "--source-app", "orbit"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_PORT: port },
    stdin: new Blob([JSON.stringify({ session_id: "s-orbit-1", cwd: root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...(permission_mode ? { permission_mode } : {}) })]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  if (!have) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-rules-hook-")));
  root = join(dir, "acme", "orbit");
  mkdirSync(root, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", root]);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!have)("the hook obeys the rules", () => {
  test("a never the person set for the project denies the call on stdout", async () => {
    const set = await post("/agent-rules", { root, match: "Bash(git push:*)", setting: "never" }, fromApp());
    expect(set).toMatchObject({ status: 200, body: { applied: true } });
    const r = await hook("git push origin main");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("git push");
  });

  test("a call no rule forbids passes with nothing on stdout", async () => {
    const r = await hook("git status");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a never inside a compound line still denies", async () => {
    const r = await hook("cd src && git push origin main");
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("the shipped base never on merging denies in a project that wrote nothing", async () => {
    const r = await hook("gh pr merge 3");
    expect(JSON.parse(r.stdout.trim()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("an unknown command files exactly one quiet suggestion, however often it is asked", async () => {
    const ask = () => fetch(`${base}/agent-rules/check?root=${encodeURIComponent(root)}&tool=Bash&mode=default&input=${encodeURIComponent(JSON.stringify({ command: "npm publish --tag beta" }))}`, { headers: auth }).then((x) => x.json());
    expect(await ask()).toMatchObject({ ok: true, decision: "unknown" });
    await ask();
    await ask();
    const sug = (await rules()).suggested.filter((s) => s.match === "Bash(npm publish:*)");
    expect(sug).toHaveLength(1);
    expect(sug[0]).toMatchObject({ source: "first-seen", pending: true });
  });

  test("the hook files a suggestion only from a session that would have stopped to ask", async () => {
    const made = async () => (await rules()).suggested.some((s) => s.match === "Bash(make build:*)");
    await hook("make build", "bypassPermissions");
    await hook("make build");
    expect(await made()).toBe(false);
    await hook("make build", "default");
    expect(await made()).toBe(true);
  });

  test("an agent loosening a never gets 202, the rule holds, and the person has a card", async () => {
    const r = await post("/agent-rules", { root, match: "Bash(git push:*)", setting: "allow", as: "builder-1" }, fromAgent());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ applied: false, waitsForPerson: true });
    expect((await hook("git push")).stdout).toContain("deny");
    const reqs = (await (await fetch(`${base}/settings/requests`, { headers: auth })).json()) as { requests: { setting: string; who: string; diff: string[] }[] };
    const card = reqs.requests.find((q) => q.setting === "agent.rules");
    expect(card).toBeDefined();
    expect(card!.who).toContain("builder-1");
    expect(card!.diff[0]).toContain("never -> allow");
  });

  test("an agent cannot answer a rule, the person can", async () => {
    const id = (await rules()).suggested.find((s) => s.match === "Bash(npm publish:*)")!.id;
    expect((await post(`/agent-rules/${id}/answer`, { setting: "allow" }, fromAgent())).status).toBe(403);
    expect((await rules()).suggested.some((s) => s.id === id)).toBe(true);
    expect((await post(`/agent-rules/${id}/answer`, { setting: "allow" }, fromApp())).status).toBe(200);
  });

  test("an agent going stricter applies at once", async () => {
    const r = await post("/agent-rules", { root, match: "Bash(rm:*)", setting: "never", as: "builder-1" }, fromAgent());
    expect(r).toMatchObject({ status: 200, body: { applied: true } });
  });

  test("a server that is not there never stops the agent: the hook exits 0 and says it skipped the check", async () => {
    proc!.kill();
    await proc!.exited;
    const r = await hook("git push origin main");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("deny");
    expect(r.stderr).toContain("rules check skipped");
  });
});
