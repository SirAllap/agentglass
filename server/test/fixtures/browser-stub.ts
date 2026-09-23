/**
 * A stand-in for the agentglass server, as the browser CLI sees it: every
 * `/browser/<op>` POST is recorded and answered from `answer`. Enough to
 * assert on exactly what the CLI sent, without a window or a relay.
 */
export interface StubCall { op: string; body: Record<string, unknown> }

export function startBrowserStub(answer: (op: string, body: Record<string, unknown>) => unknown) {
  const calls: StubCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const op = new URL(req.url).pathname.replace(/^\/browser\//, "");
      const body = req.method === "POST" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
      calls.push({ op, body });
      return Response.json(answer(op, body) ?? { ok: true, value: {} });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

const CLI = new URL("../../../bin/agentglass-browser", import.meta.url).pathname;

/** Run the CLI against `server` with a private state dir, both pipes read. */
export async function runCli(server: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: env.HOME ?? "/nonexistent", AGENTGLASS_SERVER: server, AGENTGLASS_TOKEN: "t", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}

const MCP = new URL("../../../bin/agentglass-browser-mcp", import.meta.url).pathname;

/** Call one MCP tool against `server`, start to finish over stdio, with a
 *  private tab map. Returns the tool's result, or null when none came back. */
export async function runMcpTool(server: string, stateDir: string, name: string, args: Record<string, unknown>) {
  const p = Bun.spawn(["python3", MCP], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: server, AGENTGLASS_BROWSER_STATE_DIR: stateDir, AGENTGLASS_PROFILE: "orbit-mcp" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name, arguments: args } },
  ];
  const w = p.stdin as { write: (s: string) => void; end: () => void };
  for (const l of lines) w.write(`${JSON.stringify(l)}\n`);
  w.end();
  const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const reply = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: number; result?: { content: { text?: string }[]; isError?: boolean } })
    .find((l) => l.id === 100);
  return reply?.result ?? null;
}
