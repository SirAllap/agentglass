/*
 * bin/agentglass-flightplan-mcp: a flight plan end to end as MCP tools.
 *
 * Each tool is one verb of `agentglass-ui flight-plan`, run through that CLI's
 * code, and the server decides every Go. What is pinned here:
 *
 *   - the tools and the verbs left out are, together, exactly the CLI's verbs,
 *     with both sides read from source: the CLI's from its own argparse, the
 *     MCP's from its table. A verb added to the CLI fails this until somebody
 *     decides whether an agent driving a plan gets it;
 *   - tools/list works over stdio with no app running;
 *   - a refusal is the server's sentence, word for word, as the tool's error;
 *   - the credential is the caller's (the token file, here), and with none the
 *     MCP sends none: it holds no token of its own.
 *
 * A stand-in server, not the real one: the routes' own rules are tested in the
 * flight-plan suites; this is about what the MCP sends and what it says back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;
const MCP = BIN("agentglass-flightplan-mcp");
const CURRENT = "the-callers-own-token";
const REASON = "Go is the person's here: this project is not in Autopilot";

let home = "", origin = "", server: ReturnType<typeof Bun.serve> | null = null;
let seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "agx-fp-mcp-"));
  mkdirSync(join(home, "agentglass"), { recursive: true });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      seen.push({ method: req.method, path, auth: req.headers.get("authorization"), body });
      if (path.endsWith("/go")) return Response.json({ ok: false, error: REASON }, { status: 403 });
      if (req.method === "POST" && path === "/flight-plan/plans") return Response.json({ ok: true, plan: { id: "fp_orbit1", state: "draft" } });
      return Response.json({ ok: true, plans: [] });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
});

function env(extra: Record<string, string> = {}) {
  const e: Record<string, string | undefined> = { ...process.env, AGENTGLASS_SERVER: origin, XDG_CONFIG_HOME: home, ...extra };
  delete e.AGENTGLASS_TOKEN;
  delete e.AGENTGLASS_SEAT;
  return e;
}

/** Messages in over stdio, one per line; every answer back. Spawned, never spawnSync: the stand-in is this process. */
async function stdio(messages: unknown[], extra: Record<string, string> = {}) {
  seen = [];
  const p = Bun.spawn(["python3", MCP], { env: env(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const sink = p.stdin as { write(s: string): void; end(): void };
  for (const m of messages) sink.write(JSON.stringify(m) + "\n");
  sink.end();
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const lines = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: any; error?: any });
  return { lines, err };
}

/** The MCP's own table, read from its source by loading it. */
function table(): { tools: Record<string, string>; notHere: Record<string, string> } {
  const src = `
import json
p = ${JSON.stringify(MCP)}
ns = {"__name__": "probe", "__file__": p}
exec(compile(open(p).read(), p, "exec"), ns)
print(json.dumps({"tools": ns["TOOLS"], "notHere": ns["NOT_HERE"]}))`;
  const r = Bun.spawnSync(["python3", "-c", src], { env: env({ AGENTGLASS_SERVER: "http://127.0.0.1:1" }), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return JSON.parse(r.stdout.toString());
}

/** The CLI's verbs, from its own parser: the `{a,b,...}` argparse prints in the usage line. */
function cliVerbs(): string[] {
  const choices = (...args: string[]) => {
    const r = Bun.spawnSync(["python3", BIN("agentglass-ui"), ...args, "-h"], { env: env({ AGENTGLASS_SERVER: "http://127.0.0.1:1" }), stdout: "pipe", stderr: "pipe" });
    const m = r.stdout.toString().match(/\{([a-z,-]+)\}/);
    expect(m, args.join(" ")).not.toBeNull();
    return m![1]!.split(",");
  };
  const top = choices("flight-plan");
  expect(top).toContain("plan");
  return [...top.filter((v) => v !== "plan"), ...choices("flight-plan", "plan").map((v) => `plan ${v}`)].sort();
}

describe.if(HAVE_PY)("agentglass-flightplan-mcp", () => {
  test("its tools and the verbs it leaves out are exactly the CLI's flight-plan verbs", () => {
    const { tools, notHere } = table();
    const mapped = Object.values(tools);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const v of mapped) expect(Object.keys(notHere), v).not.toContain(v);
    expect([...mapped, ...Object.keys(notHere)].sort()).toEqual(cliVerbs());
    for (const why of Object.values(notHere)) expect(why.length).toBeGreaterThan(10);
  });

  test("tools/list over stdio, with no app to ask", async () => {
    const { lines } = await stdio([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(lines.find((l) => l.id === 1)?.result?.serverInfo?.name).toBe("agentglass-flightplan");
    const listed = (lines.find((l) => l.id === 2)?.result?.tools ?? []) as { name: string; inputSchema: { type: string } }[];
    expect(listed.map((t) => t.name)).toEqual(Object.keys(table().tools));
    for (const t of listed) expect(t.inputSchema.type, t.name).toBe("object");
    expect(seen).toEqual([]);
  });

  test("a refusal is the server's own sentence as the tool's error, and the caller's token is the one sent", async () => {
    writeFileSync(join(home, "agentglass", "token"), CURRENT + "\n", { mode: 0o600 });
    const { lines } = await stdio([{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "go", arguments: { id: "fp_orbit1" } } }]);
    const res = lines[0]!.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(REASON);
    expect(seen).toEqual([{ method: "POST", path: "/flight-plan/plans/fp_orbit1/go", auth: `Bearer ${CURRENT}`, body: { as: "mcp" } }]);
  });

  test("plan_new reaches the CLI's route with the CLI's body", async () => {
    writeFileSync(join(home, "agentglass", "token"), CURRENT + "\n", { mode: 0o600 });
    const { lines } = await stdio([{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "plan_new", arguments: { request: "rate-limit the orbit login", size: "M", root: "/home/me/code/orbit" } } }]);
    const res = lines[0]!.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text).plan.id).toBe("fp_orbit1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/flight-plan/plans", body: { root: "/home/me/code/orbit", request: "rate-limit the orbit login", size: "M", visual: false, as: "mcp" } });
  });

  test("with no credential anywhere it sends none: it has no token of its own", async () => {
    rmSync(join(home, "agentglass", "token"), { force: true });
    await stdio([{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list", arguments: {} } }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBeNull();
  });

  test("a name that is not a tool is an error that lists the tools", async () => {
    const { lines } = await stdio([{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "plan_answer", arguments: { id: "fp_orbit1", answer: "yes" } } }]);
    const res = lines[0]!.result as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("plan_new");
    expect(seen).toEqual([]);
  });
});
