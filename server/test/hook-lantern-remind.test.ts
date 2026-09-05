/*
 * THE HOOK CARRIES THE LANTERN REMINDER, and nothing else about it.
 *
 * On a prompt the server may answer /ingest with `remind`, one line asking the
 * session to say what it is working on. The hook prints it to stdout — which
 * Claude Code shows the session as context for that turn, the same channel
 * the memory-save reminder uses — and does nothing else with it: no clock, no
 * file, no opinion. The server decides when; that is where the settings and
 * the session's own answer live. Pinned against the real script, the way
 * hook-allow-remote.test.ts does, against a fake server that answers what a
 * real one would.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const python = ["python3", "python", "py"].find(
  (exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0,
);
const HOOK = join(import.meta.dir, "..", "..", "hooks", "send_event.py");
const REMIND = "AGENTGLASS LANTERN: say what you are doing — curl … /agents/status";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); });

/** A fake /ingest that answers `body` on every POST. */
function serve(body: unknown) {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }) });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

async function run(server: string, eventType: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extraEnv };
  const proc = Bun.spawn([python!, HOOK, "--server", server, "--event-type", eventType],
    { env, stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s-1" })), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

describe("the lantern reminder, through the hook", () => {
  test.if(!!python)("is printed on a prompt when the server sends one", async () => {
    const r = await run(serve({ ok: true, remind: REMIND }), "UserPromptSubmit");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(REMIND);
  });

  test.if(!!python)("and nothing is printed when the server sends none", async () => {
    // The common case, every prompt inside the interval: stdout has to stay
    // empty, or Claude Code shows the session an empty context block.
    const r = await run(serve({ ok: true }), "UserPromptSubmit");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test.if(!!python)("never on any other event, whatever the server says", async () => {
    // A reminder on every tool call would be the thing the session remembers
    // the board for.
    for (const ev of ["PreToolUse", "PostToolUse", "Stop", "Notification"]) {
      const r = await run(serve({ ok: true, remind: REMIND }), ev);
      expect(r.stdout, ev).toBe("");
    }
  });

  test.if(!!python)("the machine can say no, and the server's answer is swallowed", async () => {
    const r = await run(serve({ ok: true, remind: REMIND }), "UserPromptSubmit", { AGENTGLASS_NO_STATUS_NUDGE: "1" });
    expect(r.stdout).toBe("");
    expect(r.code).toBe(0);
  });

  test.if(!!python)("an answer that is not JSON costs nothing — the event still went, the hook still exits 0", async () => {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    servers.push(s);
    const r = await run(`http://127.0.0.1:${s.port}`, "UserPromptSubmit");
    expect(r.stdout).toBe("");
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Traceback");
  });
});

describe("the hook says what the session is", () => {
  test("AGENTGLASS_ROLE in the pane's environment rides every event as `role`; absent, the field is absent", async () => {
    const src = await Bun.file(new URL("../../hooks/send_event.py", import.meta.url)).text();
    expect(src).toContain('role = os.environ.get("AGENTGLASS_ROLE")');
    expect(src).toContain('body["role"] = role');
  });
  test("the bench hands the Lantern's ticket role to its tmux session with -e, and a bare pty gets it in the environment", async () => {
    const term = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    expect(term).toContain("engineBenchArgv(startIn, d.bench, benchRuns, ticket?.role ? { AGENTGLASS_ROLE: ticket.role } : undefined)");
    expect(term).toContain("if (ticket?.role) env = { ...env, AGENTGLASS_ROLE: ticket.role };");
    const { engineBenchArgv } = await import("../src/tmuxpane.ts");
    const argv = engineBenchArgv("/tmp/some-root", 3, ["claude", "--name", "Lantern"], { AGENTGLASS_ROLE: "lantern" }) ?? [];
    const at = argv.indexOf("-e");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe("AGENTGLASS_ROLE=lantern");
    expect(argv.indexOf("claude"), "the variable goes BEFORE the command, or tmux hands it to claude").toBeGreaterThan(at);
    const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(index).toContain('title: "Lantern", kind: "claude", role: "lantern" }');
  });
});
