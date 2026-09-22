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
