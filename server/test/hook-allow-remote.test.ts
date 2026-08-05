/*
 * The hooks' local-only guard, tested through the hooks themselves.
 *
 * AGENTGLASS_SERVER is attacker-influenceable — a repo-local `.claude/settings.json`
 * can set it — and what the hooks POST is the full session: prompts, tool input,
 * file contents. So they refuse any host that is not this machine, and
 * AGENTGLASS_ALLOW_REMOTE is the deliberate way out.
 *
 * The trap this file exists for: the guard used to be a truthy test, so
 * AGENTGLASS_ALLOW_REMOTE=0 — which every reader takes for "off" — turned the
 * guard OFF rather than leaving it on. Anything non-empty did. Only the literal
 * "1" is an opt-out, and that is what is checked here, against all four hooks
 * rather than the two that happen to be named in the README.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);

const hook = (name: string) => join(import.meta.dir, "..", "..", "hooks", name);
const HOOKS = ["send_event.py", "gate_event.py", "connect_otel.py", "seed_demo.py"];

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** Run a hook against `server`, with the guard's env set, and collect stderr. */
async function runHook(name: string, server: string, allowRemote: string | undefined) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, AGENTGLASS_SERVER: server };
  if (allowRemote === undefined) delete env.AGENTGLASS_ALLOW_REMOTE;
  else env.AGENTGLASS_ALLOW_REMOTE = allowRemote;
  // --server too: send_event and gate_event read the flag, the other two only
  // the environment, and the guard has to hold whichever way the value arrives.
  const args = name === "send_event.py" || name === "gate_event.py" ? [hook(name), "--server", server] : [hook(name)];
  const proc = Bun.spawn([python!, ...args], { env, stdin: new TextEncoder().encode("{}"), stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return stderr;
}

describe("the hooks' local-only guard", () => {
  const REMOTE = "https://collector.example.invalid";

  test.if(!!python)("refuses a non-local server when the opt-out is unset", async () => {
    for (const name of HOOKS) {
      expect(await runHook(name, REMOTE, undefined), name).toContain("refusing non-local server");
    }
  });

  // The regression. Each of these reads as "off" to a human, and each of them
  // used to switch the guard off.
  for (const value of ["0", "false", "no", "off", ""]) {
    test.if(!!python)(`AGENTGLASS_ALLOW_REMOTE=${JSON.stringify(value)} does not disable it`, async () => {
      for (const name of HOOKS) {
        expect(await runHook(name, REMOTE, value), `${name} with ${JSON.stringify(value)}`)
          .toContain("refusing non-local server");
      }
    });
  }

  test.if(!!python)("and an explicit 1 still lets a remote server through", async () => {
    // 127.0.0.2 is loopback to the kernel but is not one of the three names the
    // guard allows, so it exercises the opt-out for real: refused without it,
    // delivered with it. A hostname would need DNS and would only ever prove
    // the refusal.
    let resolveBody!: (body: unknown) => void;
    const received = Promise.race([
      new Promise<any>((resolve) => { resolveBody = resolve; }),
      Bun.sleep(5_000).then(() => { throw new Error("the event never arrived"); }),
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.2",
      port: 0,
      async fetch(req) { resolveBody(await req.json()); return new Response("ok"); },
    });
    servers.push(server);
    const url = `http://127.0.0.2:${server.port}`;

    expect(await runHook("send_event.py", url, undefined)).toContain("refusing non-local server");

    const stderr = await runHook("send_event.py", url, "1");
    expect(stderr).not.toContain("refusing non-local server");
    expect((await received).source_app).toBeString();
  });
});

/*
 * The other half of the same guard: `localhost` is allowed, and rewritten.
 *
 * Allowed because it is this machine, which is all the guard is about.
 * Rewritten because of what it costs — the server binds IPv4-only, so on a host
 * whose resolver answers ::1 first, every single event pays a refused IPv6
 * connect before falling back to IPv4. Doing it in the guard rather than only
 * in the default is what carries the fix to installs that already wrote
 * `localhost` into a settings.json months ago.
 */
describe("what the hooks actually connect to", () => {
  test.if(!!python)("a localhost URL is delivered to 127.0.0.1", async () => {
    // Bound to 127.0.0.1 only. A hook that really resolved `localhost` could
    // still land here on most machines, so the assertion is on the Host header:
    // that is the address the client dialled, spelled out.
    let resolveHost!: (h: string | null) => void;
    const received = Promise.race([
      new Promise<string | null>((r) => { resolveHost = r; }),
      Bun.sleep(5_000).then(() => { throw new Error("the event never arrived"); }),
    ]);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) { await req.text(); resolveHost(req.headers.get("host")); return new Response("ok"); },
    });
    servers.push(server);

    const stderr = await runHook("send_event.py", `http://localhost:${server.port}`, undefined);
    expect(stderr).not.toContain("refusing non-local server");
    expect(await received).toBe(`127.0.0.1:${server.port}`);
  });

  test("the default written into every hook is already the fast one", () => {
    // The rewrite is the safety net for what is already installed; the default
    // is what a fresh setup gets, and it should not need the net.
    for (const name of HOOKS) {
      const src = readFileSync(new URL("../../hooks/" + name, import.meta.url), "utf8");
      expect(src, name).toContain("http://127.0.0.1:4000");
      expect(src, name).not.toContain('"http://localhost:4000"');
    }
  });
});
