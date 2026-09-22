/*
 * The cockpit as an MCP server: what an agent can ask about its own work.
 *
 * The agent producing the events knows none of what the cockpit knows about
 * them — what it has spent, how long its tools take, what failed, whether
 * anything of its own is waiting on a person. bin/agentglass-cockpit-mcp puts
 * the existing read routes behind tools with schemas. Everything between this
 * file and the database is real: a server booted on its own port and data
 * dir, events that arrive through /ingest the way a hook sends them, and the
 * JSON-RPC over stdio or over the Streamable-HTTP transport the browser's MCP
 * server already has.
 *
 * Two properties matter more than any one tool, and each has its test:
 *   READ-ONLY — no tool writes, kills or approves; the binary sends GETs only.
 *   A CEILING — no answer is over the size limit, and one that would be comes
 *   back smaller, well formed, with a field naming what was dropped.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const MCP = new URL("../../bin/agentglass-cockpit-mcp", import.meta.url).pathname;
const SOURCE = readFileSync(MCP, "utf8");
const HAVE_PY = !!Bun.which("python3");

const PROJECT = "/tmp/acme/orbit";
const OTHER = "/tmp/acme/nebula";
const S1 = "cockpit-test-orbit-1";
const S2 = "cockpit-test-nebula-1";
const WAITING = "cockpit-test-orbit-waiting";
const T0 = Date.now() - 60_000;

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;

async function ingest(ev: Record<string, unknown>) {
  const r = await fetch(base + "/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_app: "orbit", timestamp: T0, ...ev }),
  });
  if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-cockpit-mcp-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: `${dir}/data`,
      XDG_CACHE_HOME: `${dir}/cache`,
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_DB: join(dir, "c.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  const usage = { input_tokens: 12_000, output_tokens: 3_000 };
  const chat = [{ type: "assistant", message: { model: "claude-sonnet-4-5", usage } }];
  // Session one: a prompt, a timed Bash call, a failed Read, a Stop with usage.
  await ingest({ session_id: S1, hook_event_type: "UserPromptSubmit", payload: { cwd: PROJECT, project_path: PROJECT, prompt: "fix ORBIT-1042" } });
  await ingest({ session_id: S1, hook_event_type: "PreToolUse", tool_name: "Bash", timestamp: T0 + 1000,
    payload: { cwd: PROJECT, project_path: PROJECT, tool_name: "Bash", tool_use_id: "tu-orbit-1", tool_input: { command: "make test" } } });
  await ingest({ session_id: S1, hook_event_type: "PostToolUse", tool_name: "Bash", timestamp: T0 + 2500,
    payload: { cwd: PROJECT, project_path: PROJECT, tool_name: "Bash", tool_use_id: "tu-orbit-1", tool_response: { stdout: "ok" } } });
  await ingest({ session_id: S1, hook_event_type: "PostToolUseFailure", tool_name: "Read", timestamp: T0 + 3000,
    payload: { cwd: PROJECT, project_path: PROJECT, tool_name: "Read", tool_use_id: "tu-orbit-2", error: "ENOENT: no such file, open 'orbit.cfg'" } });
  await ingest({ session_id: S1, hook_event_type: "Stop", timestamp: T0 + 4000, model_name: "claude-sonnet-4-5",
    chat, payload: { cwd: PROJECT, project_path: PROJECT } });
  // Session two, another project: only there so a filter has something to leave out.
  await ingest({ session_id: S2, hook_event_type: "Stop", timestamp: T0 + 5000, model_name: "claude-sonnet-4-5",
    chat, payload: { cwd: OTHER, project_path: OTHER } });
  // A third, stopped on a person.
  await ingest({ session_id: WAITING, hook_event_type: "UserPromptSubmit", timestamp: T0 + 6000, payload: { cwd: PROJECT, project_path: PROJECT, prompt: "deploy" } });
  await ingest({ session_id: WAITING, hook_event_type: "Notification", timestamp: T0 + 7000,
    payload: { cwd: PROJECT, project_path: PROJECT, message: "Claude needs your permission to use Bash" } });
  await fetch(base + "/agents/status", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ name: "orbit-deploy", doing: "deploying ORBIT-1042", worktree: PROJECT, session: WAITING }),
  });
  // And one that is not waiting on anybody, so "waiting" has something to leave out.
  await fetch(base + "/agents/status", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ name: "orbit-docs", doing: "writing the orbit README", worktree: PROJECT, session: S1 }),
  });
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

async function talk(messages: unknown[], env: Record<string, string> = {}): Promise<Record<string, any>[]> {
  const p = Bun.spawn(["python3", MCP], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const w = p.stdin as { write: (s: string) => void; end: () => void };
  for (const m of messages) w.write(`${JSON.stringify(m)}\n`);
  w.end();
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
}

const hello = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } };

/** One tool call; the text answer parsed back, plus the raw result. */
async function call(name: string, args: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const [, r] = await talk([hello, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }], env);
  const result = r!.result as { content: { type: string; text: string }[]; isError?: boolean };
  const text = result.content[0]!.text;
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* an error sentence */ }
  return { result, text, data };
}

const READ_TOOLS = [
  "cockpit_agents", "cockpit_attention", "cockpit_errors", "cockpit_recent_events",
  "cockpit_session", "cockpit_sessions", "cockpit_spend", "cockpit_tool_latency",
];

describe.skipIf(!HAVE_PY)("the cockpit MCP server", () => {
  test("shakes hands as agentglass-cockpit", async () => {
    const [r] = await talk([hello]);
    expect(r!.result.serverInfo.name).toBe("agentglass-cockpit");
    expect(r!.result.capabilities.tools).toBeDefined();
  });

  test("lists read-only tools only, each with a schema and the read-only hint", async () => {
    const [, r] = await talk([hello, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const tools = r!.result.tools as { name: string; inputSchema: { type: string }; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    }
  });

  test("the binary only ever sends GET to the app", () => {
    // Read-only is a property of the transport to the app, not of the tool
    // names: one Request is built, and its method is GET.
    const code = SOURCE.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code.match(/urllib\.request\.Request\(/g)?.length).toBe(1);
    expect(code).toContain('method="GET"');
    expect(code).not.toMatch(/method="(POST|PUT|DELETE|PATCH)"/);
  });

  test("an unknown tool is an error answer, not a dropped pipe", async () => {
    const { result } = await call("cockpit_kill_session", { id: S1 });
    expect(result.isError).toBe(true);
  });

  test("cockpit_sessions lists sessions with spend, and filters by project", async () => {
    const all = await call("cockpit_sessions", { limit: 10 });
    const ids = (all.data.sessions as { session_id: string }[]).map((s) => s.session_id);
    expect(ids).toContain(S1);
    expect(ids).toContain(S2);
    const orbit = await call("cockpit_sessions", { project: "orbit" });
    const rows = orbit.data.sessions as { session_id: string; project_path: string; cost_usd: number; errors: number; input_tokens: number }[];
    expect(rows.map((s) => s.session_id)).not.toContain(S2);
    const s1 = rows.find((s) => s.session_id === S1)!;
    expect(s1.project_path).toBe(PROJECT);
    expect(s1.cost_usd).toBeGreaterThan(0);
    expect(s1.input_tokens).toBe(12_000);
    expect(s1.errors).toBeGreaterThanOrEqual(1);
    expect(orbit.data.truncated).toBeUndefined();
  });

  test("cockpit_session answers one session, and a missing one is an error", async () => {
    const one = await call("cockpit_session", { id: S1 });
    expect(one.data.session_id).toBe(S1);
    expect((one.data.tool_mix as { tool: string }[]).map((t) => t.tool)).toContain("Bash");
    expect(one.data.conversation, "the heavy lists stay out unless asked for").toBeUndefined();
    const none = await call("cockpit_session", { id: "no-such-session" });
    expect(none.result.isError).toBe(true);
    const bad = await call("cockpit_session", {});
    expect(bad.result.isError).toBe(true);
  });

  test("cockpit_spend: one session, one project, and the whole window", async () => {
    const s = await call("cockpit_spend", { session: S1 });
    expect(s.data.scope).toEqual({ session: S1 });
    expect(s.data.cost_usd).toBeGreaterThan(0);
    expect(s.data.input_tokens).toBe(12_000);
    expect(s.data.output_tokens).toBe(3_000);
    const p = await call("cockpit_spend", { project: "orbit" });
    expect(p.data.sessions).toBeGreaterThanOrEqual(1);
    expect(p.data.cost_usd).toBeCloseTo(s.data.cost_usd, 6);
    const w = await call("cockpit_spend", { window: "24h" });
    expect(w.data.cost_usd).toBeGreaterThanOrEqual(p.data.cost_usd);
    expect(Array.isArray(w.data.by_model)).toBe(true);
    const both = await call("cockpit_spend", { session: S1, project: "orbit" });
    expect(both.result.isError).toBe(true);
  });

  test("cockpit_tool_latency gives percentiles per tool", async () => {
    const { data } = await call("cockpit_tool_latency", { window: "24h" });
    const bash = (data.tools as { tool_name: string; p50_ms: number; calls: number }[]).find((t) => t.tool_name === "Bash")!;
    expect(bash).toBeDefined();
    expect(bash.p50_ms).toBe(1500);
    const only = await call("cockpit_tool_latency", { window: "24h", tool: "Read" });
    expect((only.data.tools as { tool_name: string }[]).every((t) => t.tool_name === "Read")).toBe(true);
    const badWindow = await call("cockpit_tool_latency", { window: "fortnight" });
    expect(badWindow.result.isError).toBe(true);
  });

  test("cockpit_errors lists recent failures with their text, and narrows to a session", async () => {
    const { data } = await call("cockpit_errors", { session: S1 });
    const errs = data.errors as { session_id: string; tool_name: string; error_text: string }[];
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0]!.tool_name).toBe("Read");
    expect(errs[0]!.error_text).toContain("ENOENT");
    expect(errs.every((e) => e.session_id === S1)).toBe(true);
    const other = await call("cockpit_errors", { session: S2 });
    expect(other.data.errors).toEqual([]);
  });

  test("cockpit_recent_events is newest first, without payloads, filterable by type", async () => {
    const { data } = await call("cockpit_recent_events", { session: S1 });
    const evs = data.events as { timestamp: number; hook_event_type: string; payload?: unknown }[];
    expect(evs.length).toBe(5);
    expect(evs[0]!.hook_event_type).toBe("Stop");
    expect(evs.every((e) => e.payload === undefined)).toBe(true);
    const typed = await call("cockpit_recent_events", { type: "PreToolUse" });
    expect((typed.data.events as { hook_event_type: string }[]).every((e) => e.hook_event_type === "PreToolUse")).toBe(true);
  });

  test("cockpit_agents and cockpit_attention: the agent stopped on a person is named", async () => {
    const agents = await call("cockpit_agents");
    const row = (agents.data.agents as { name: string; state: string }[]).find((a) => a.name === "orbit-deploy");
    expect(row).toBeDefined();
    const docs = (agents.data.agents as { name: string; state: string }[]).find((a) => a.name === "orbit-docs");
    expect(docs?.state).not.toBe("waiting");
    const att = await call("cockpit_attention");
    expect(Array.isArray(att.data.gates)).toBe(true);
    const waiting = att.data.waiting as { name: string; state: string }[];
    expect(waiting.map((w) => w.name)).toContain("orbit-deploy");
    expect(waiting.every((w) => w.state === "waiting")).toBe(true);
  });

  test("an app that is not there is an error answer naming where it looked", async () => {
    const { result, text } = await call("cockpit_sessions", {}, { AGENTGLASS_SERVER: "http://127.0.0.1:9" });
    expect(result.isError).toBe(true);
    expect(text).toContain("127.0.0.1:9");
  });
});

describe.skipIf(!HAVE_PY)("the size ceiling", () => {
  /* The rule the issue puts above the tool list: a result over the ceiling is
     not cut in the middle, it is a smaller well-formed answer with a field
     naming what was dropped — so the model can narrow its next call instead
     of paying for half a payload that teaches it nothing. */
  const CEILING = 700;

  beforeAll(async () => {
    for (let i = 0; i < 30; i++) {
      await ingest({ session_id: `cockpit-test-bulk-${String(i).padStart(2, "0")}`, hook_event_type: "UserPromptSubmit",
        timestamp: T0 + 10_000 + i, payload: { cwd: PROJECT, project_path: PROJECT, prompt: "bulk" } });
    }
  });

  test("an answer over the ceiling comes back under it, whole, naming what it dropped", async () => {
    const { text, data } = await call("cockpit_sessions", { limit: 50 }, { AGENTGLASS_COCKPIT_MAX_BYTES: String(CEILING) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CEILING);
    expect(data, "well-formed JSON, not a cut payload").not.toBeNull();
    const t = data.truncated as { field: string; kept: number; dropped: number }[];
    expect(t).toHaveLength(1);
    expect(t[0]!.field).toBe("sessions");
    expect(t[0]!.kept).toBe((data.sessions as unknown[]).length);
    expect(t[0]!.kept + t[0]!.dropped).toBeGreaterThanOrEqual(33);
    expect(t[0]!.dropped).toBeGreaterThan(0);
    expect(typeof data.narrow).toBe("string");
    // Newest first, so what survives is what the model most likely wanted.
    expect((data.sessions as { session_id: string }[])[0]!.session_id).toBe("cockpit-test-bulk-29");
  });

  test("the default ceiling holds for the largest list a tool can ask for", async () => {
    const { text } = await call("cockpit_recent_events", { limit: 500 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  });

  test("a ceiling too small for anything still answers well formed", async () => {
    const { text, data } = await call("cockpit_sessions", { limit: 50 }, { AGENTGLASS_COCKPIT_MAX_BYTES: "10" });
    expect(data).not.toBeNull();
    expect(data.sessions).toEqual([]);
    expect(data.truncated[0].dropped).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAVE_PY)("the cockpit over Streamable HTTP", () => {
  /* The browser's transport, fences and all: a token of its own, loopback by
     default, no Origin, application/json only. The token is the cockpit's —
     neither the app's nor the browser endpoint's opens it, and it opens
     neither of them. */
  const TOKEN = "agx-cockpit-test-token-0123456789abcdef-0123456789";
  const APP_TOKEN = "agx-app-token-that-is-not-the-cockpit-one-012345";
  const BROWSER_TOKEN = "agx-browser-mcp-token-not-the-cockpit-one-0123456";
  let port = 0;
  let mcp: ReturnType<typeof Bun.spawn> | null = null;
  const url = () => `http://127.0.0.1:${port}/`;
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  beforeAll(async () => {
    port = await freePort();
    mcp = Bun.spawn(["python3", MCP, "--http", String(port)], {
      env: {
        PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base,
        AGENTGLASS_TOKEN: APP_TOKEN, AGENTGLASS_MCP_TOKEN: BROWSER_TOKEN, AGENTGLASS_COCKPIT_TOKEN: TOKEN,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: ping });
        if (r.ok) break;
      } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { mcp?.kill(); } catch { /* already gone */ }
  });

  test("the cockpit token lists the tools", async () => {
    const r = await fetch(url(), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: ping });
    expect(r.status).toBe(200);
    const j = await r.json() as { result: { tools: { name: string }[] } };
    expect(j.result.tools.map((t) => t.name).sort()).toEqual(READ_TOOLS);
  });

  test("no token, a wrong one, the app's and the browser endpoint's are all refused", async () => {
    for (const auth of [undefined, "Bearer nope", `Bearer ${APP_TOKEN}`, `Bearer ${BROWSER_TOKEN}`]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (auth) headers.authorization = auth;
      const r = await fetch(url(), { method: "POST", headers, body: ping });
      expect(r.status, String(auth)).toBe(401);
    }
  });

  test("a request from a web page is refused, token or not, and nothing is echoed", async () => {
    const r = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
      body: ping,
    });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the cockpit token must not be the app's or the browser endpoint's", async () => {
    for (const env of [
      { AGENTGLASS_COCKPIT_TOKEN: APP_TOKEN, AGENTGLASS_TOKEN: APP_TOKEN },
      { AGENTGLASS_COCKPIT_TOKEN: BROWSER_TOKEN, AGENTGLASS_MCP_TOKEN: BROWSER_TOKEN },
    ]) {
      const p = Bun.spawn(["python3", MCP, "--http", String(await freePort())], {
        env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, ...env },
        stdout: "ignore", stderr: "pipe",
      });
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      expect(code).toBe(2);
      expect(err).toContain("AGENTGLASS_COCKPIT_TOKEN must not be");
    }
  });

  test("the browser endpoint's variables do not start or expose the cockpit", async () => {
    // AGENTGLASS_MCP_HTTP belongs to the browser server; were it read here,
    // both would reach for the same port. The cockpit has its own variable.
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_MCP_HTTP: String(await freePort()) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    (p.stdin as { end: () => void }).end();
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code, "stdio: stdin closed, clean exit").toBe(0);
    expect(err).not.toContain("Streamable HTTP");
    const exposed = Bun.spawn(["python3", MCP, "--http", `0.0.0.0:${await freePort()}`], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_COCKPIT_TOKEN: TOKEN, AGENTGLASS_MCP_EXPOSE: "1" },
      stdout: "ignore", stderr: "pipe",
    });
    const [c2, e2] = await Promise.all([exposed.exited, new Response(exposed.stderr).text()]);
    expect(c2).toBe(2);
    expect(e2).toContain("--expose");
  });
});

/*
 * The shaping, against a stand-in app: the module loaded without its main and
 * its one GET replaced, so an answer the real server only gives with a big or
 * odd database — a 20,000-char summary, half an emoji at a cut, a hundred
 * timeline entries — is one line of fixture. `routes` maps a path to what the
 * app would answer; a path it does not name answers 404.
 */
function standIn(routes: Record<string, unknown>, calls: { name: string; arguments: unknown }[], env: Record<string, string> = {}) {
  const src = `
import json, sys
ns = {"__name__": "probe", "__file__": ${JSON.stringify(MCP)}}
exec(compile(open(ns["__file__"]).read(), ns["__file__"], "exec"), ns)
routes = json.loads(sys.stdin.readline())
calls = json.loads(sys.stdin.readline())
asked = []
def fake(path, params=None, timeout=30):
    asked.append({"path": path, "params": params or {}})
    if path.startswith("!"):
        return 0, path[1:]
    if path in routes:
        r = routes[path]
        if isinstance(r, dict) and "__refused__" in r:
            return 0, r["__refused__"]
        return 200, r
    return 404, "agentglass answered 404 for " + path
ns["get"] = fake
out = [ns["run"](c["name"], c["arguments"]) for c in calls]
print(json.dumps({"out": out, "asked": asked}))
`;
  const p = Bun.spawnSync(["python3", "-c", src], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: "http://127.0.0.1:4040", ...env },
    stdin: Buffer.from(`${JSON.stringify(routes)}\n${JSON.stringify(calls)}\n`),
    stdout: "pipe", stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  const r = JSON.parse(p.stdout.toString()) as { out: { content: { text: string }[]; isError?: boolean }[]; asked: { path: string; params: Record<string, unknown> }[] };
  return {
    asked: r.asked,
    out: r.out.map((o) => {
      let data: any = null;
      try { data = JSON.parse(o.content[0]!.text); } catch { /* a sentence */ }
      return { isError: !!o.isError, text: o.content[0]!.text, data };
    }),
  };
}

describe.skipIf(!HAVE_PY)("shaping, against a stand-in app", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    session_id: "s-orbit", started_at: T0, ended_at: null, last_seen: T0 + 1000, event_count: 3,
    cost_usd: 0.5, input_tokens: 10, output_tokens: 2, summary: "done", first_prompt: "fix ORBIT-1042",
    tool_mix: [], subagents: [], conversation: [], timeline: [], changes: [], ...over,
  });

  test("the heavy lists keep the server's newest-first order, and the ceiling drops the oldest", () => {
    // /session sends timeline, conversation and changes newest first already.
    const timeline = Array.from({ length: 100 }, (_, i) => ({ ts: 100 - i, what: "x".repeat(300) }));
    const { out } = standIn({ "/session": detail({ timeline }) }, [
      { name: "cockpit_session", arguments: { id: "s-orbit", include: ["timeline", "timeline"] } },
    ]);
    const d = out[0]!.data;
    expect(d.timeline[0].ts).toBe(100);
    expect(d.truncated).toHaveLength(1);
    expect(d.truncated[0]).toMatchObject({ field: "timeline", kept: d.timeline.length });
    expect(d.timeline.at(-1).ts).toBe(100 - d.timeline.length + 1);
  });

  test("long scalars are clipped and named, so a session's answer stays under the ceiling", () => {
    const { out } = standIn({ "/session": detail({ summary: "s".repeat(20_000), first_prompt: "p".repeat(30_000) }) }, [
      { name: "cockpit_session", arguments: { id: "s-orbit" } },
    ]);
    expect(Buffer.byteLength(out[0]!.text)).toBeLessThanOrEqual(16 * 1024);
    const clipped = (out[0]!.data.truncated as { field: string; clipped_to?: number }[]).map((t) => t.field).sort();
    expect(clipped).toEqual(["first_prompt", "summary"]);
    expect(out[0]!.data.summary.length).toBeLessThan(20_000);
  });

  test("half an emoji from a cut in the app's text is answered, not a crash", () => {
    const events = [{ id: 1, timestamp: T0, session_id: "s-orbit", hook_event_type: "PostToolUseFailure", tool_name: "Bash", error_text: "bad \ud83d" }];
    const { out } = standIn({ "/events/recent": events }, [
      { name: "cockpit_errors", arguments: {} },
      { name: "cockpit_errors", arguments: {} },
    ], { AGENTGLASS_COCKPIT_MAX_BYTES: "50" });
    expect(out[0]!.isError).toBe(false);
    expect(out[0]!.data).not.toBeNull();
  });

  test("an app that is not answering is not 'no session', whatever its port spells", () => {
    const { out } = standIn({ "/session": { __refused__: "no agentglass at http://127.0.0.1:4040 (Connection refused)" } }, [
      { name: "cockpit_session", arguments: { id: "s-orbit" } },
      { name: "cockpit_spend", arguments: { session: "s-orbit" } },
    ]);
    for (const o of out) {
      expect(o.isError).toBe(true);
      expect(o.text).not.toContain("no session");
      expect(o.text).toContain("Connection refused");
    }
    const missing = standIn({}, [{ name: "cockpit_session", arguments: { id: "s-gone" } }]);
    expect(missing.out[0]!.text).toBe("no session s-gone");
  });

  test("a scan of events asks the app for no more than it already sends a new window", () => {
    // /events/recent sends whole payloads — prompts, file contents, command
    // output — so a filter looks through the app's own default of 300, and
    // says so, rather than dragging 2000 rows through its event loop.
    const { asked, out } = standIn({ "/events/recent": [] }, [
      { name: "cockpit_errors", arguments: {} },
      { name: "cockpit_recent_events", arguments: { session: "s-orbit" } },
      { name: "cockpit_recent_events", arguments: { limit: 500 } },
    ]);
    for (const a of asked) expect(Number(a.params.limit), JSON.stringify(a)).toBeLessThanOrEqual(300);
    expect(out[0]!.data.scanned_events).toBe(0);
  });

  test("an agent waiting on a person says why, and its times are readable", () => {
    const since = Date.UTC(2026, 0, 2, 3, 4, 5);
    const board = { ok: true, agents: [
      { name: "orbit-deploy", state: "waiting", saidAt: since, needsYou: { kind: "permission", why: "Bash", since } },
      { name: "orbit-docs", state: "idle", saidAt: since },
    ] };
    const { out } = standIn({ "/agents/board": board, "/gate/pending": { gates: [] } }, [
      { name: "cockpit_attention", arguments: {} },
      { name: "cockpit_agents", arguments: {} },
    ]);
    const w = out[0]!.data.waiting;
    expect(w).toHaveLength(1);
    expect(w[0].needsYou).toEqual({ kind: "permission", why: "Bash", since: "2026-01-02T03:04:05Z" });
    expect(out[1]!.data.agents[1].saidAt).toBe("2026-01-02T03:04:05Z");
  });

  test("arguments of the wrong type are an answer, never a dead server", () => {
    const { out } = standIn({ "/session": detail(), "/agents/board": { agents: [] }, "/sessions": [], "/stats": { totals: {} } }, [
      { name: "cockpit_agents", arguments: { state: 5 } },
      { name: "cockpit_session", arguments: { id: 123 } },
      { name: "cockpit_session", arguments: { id: "s-orbit", include: 5 } },
      { name: "cockpit_sessions", arguments: { limit: "5", project: ["orbit"] } },
      { name: "cockpit_spend", arguments: { window: 7 } },
      { name: "cockpit_tool_latency", arguments: { tool: {} } },
      { name: "cockpit_errors", arguments: "not an object" },
    ]);
    expect(out).toHaveLength(7);
  });

  test("an answer from the app in a shape nobody expected is this call's error, not the process's end", () => {
    // An older or newer app, a proxy's error page parsed as JSON: whatever
    // the shaping trips on comes back as one call's failure.
    const { out } = standIn({ "/sessions": { rows: "not a list" }, "/agents/board": { agents: [] }, "/gate/pending": { gates: [] } }, [
      { name: "cockpit_sessions", arguments: {} },
      { name: "cockpit_agents", arguments: {} },
    ]);
    expect(out[0]!.isError).toBe(true);
    expect(out[0]!.text).toContain("cockpit_sessions failed");
    expect(out[1]!.isError).toBe(false);
  });
});

describe.skipIf(!HAVE_PY)("the stdio server outlives a bad call", () => {
  test("a wrong-typed argument, a list for params and a list for a name are each answered, and the ping after them too", async () => {
    const said = await talk([
      hello,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cockpit_agents", arguments: { state: 5 } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: ["cockpit_agents"] },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: ["cockpit_agents"] } },
      { jsonrpc: "2.0", id: 5, method: "ping" },
    ]);
    expect(said.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("session spend carries cache tokens as numbers, not nulls", async () => {
    const { data } = await call("cockpit_spend", { session: S1 });
    expect(typeof data.cache_read_tokens).toBe("number");
    expect(typeof data.cache_creation_tokens).toBe("number");
  });

  test("a malformed setting of the browser module is one line naming it, not a traceback", async () => {
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_WAIT: "soon" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    (p.stdin as { end: () => void }).end();
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).toBe(2);
    expect(err.trim().split("\n")).toHaveLength(1);
    expect(err).toContain("agentglass-browser-mcp");
  });

  test("the only way to the app is get(): the browser module's POST relay is never called", () => {
    const code = SOURCE.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\bT\.(call|run|storage_state|set_storage_state|_raw|_do_at)\(/);
  });
});

describe.skipIf(!HAVE_PY)("the browser endpoint refuses the cockpit's token", () => {
  test("AGENTGLASS_MCP_TOKEN equal to AGENTGLASS_COCKPIT_TOKEN does not start", async () => {
    const same = "agx-shared-token-that-must-open-one-thing-0123456";
    const p = Bun.spawn(["python3", new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname, "--http", String(await freePort())], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_MCP_TOKEN: same, AGENTGLASS_COCKPIT_TOKEN: same },
      stdout: "ignore", stderr: "pipe",
    });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    expect(code).toBe(2);
    expect(err).toContain("AGENTGLASS_MCP_TOKEN must not be AGENTGLASS_COCKPIT_TOKEN");
  });
});
