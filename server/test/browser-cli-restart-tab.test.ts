/*
 * A worker restarted under the same name must not drive the tab its
 * predecessor opened. The CLI keeps "my tab" in a file on disk, keyed by the
 * agent name, and the relay forgets a name's pages when its credential is
 * revoked: so `open` named the old tab (`page`), the relay refused it as a page
 * this credential did not open ("reaches only that agent's own container"),
 * and the new worker could never open one of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");
const NAME = "orbit-worker";

let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let sent: Record<string, unknown>[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-cli-restart-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      let body: Record<string, unknown> = {};
      try { body = await req.json() as Record<string, unknown>; } catch { /* a GET */ }
      if (req.method === "POST") sent.push(body);
      return Response.json({ ok: true, value: { tab: "t2-new", id: "t2-new", profile: `agent:${NAME}`, url: "https://acme.example/" } });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const run = async (token: string) => { const p = Bun.spawn({
  cmd: ["python3", "-I", CLI, "--as", NAME, "open", "https://acme.example/"],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    AGENTGLASS_SERVER: `http://127.0.0.1:${server!.port}`,
    AGENTGLASS_BROWSER_STATE_DIR: dir,
    AGENTGLASS_TOKEN: token,
    AGENTGLASS_BROWSER_AS: NAME,
  },
  stdout: "pipe", stderr: "pipe",
}); await p.exited; return { exitCode: p.exitCode, err: await new Response(p.stderr).text() }; };

describe.skipIf(!HAVE_PY)("a restarted worker and the tab map on disk", async () => {
  test("a new credential under the same name does not name the old worker's tab", async () => {
    sent = [];
    // The first worker opens a tab; the CLI remembers it.
    const first = await run("wk_orbit_first");
    expect(first.exitCode).toBe(0);
    // Stop + start under the same name: a new credential, the old tab id still on disk.
    sent = [];
    const second = await run("wk_orbit_second");
    expect(second.exitCode).toBe(0);
    const open = sent.find((b) => b.op === "open" || b.url) as Record<string, unknown> | undefined;
    expect(open).toBeDefined();
    // The first worker's tab id must not ride along as the new worker's `page`.
    expect(open!.page).toBeUndefined();
  });

  test("the same credential keeps going to its own tab", async () => {
    sent = [];
    expect((await run("wk_orbit_third")).exitCode).toBe(0);
    sent = [];
    expect((await run("wk_orbit_third")).exitCode).toBe(0);
    const open = sent.find((b) => b.op === "open" || b.url) as Record<string, unknown> | undefined;
    expect(open!.page).toBe("t2-new");
  });
});
