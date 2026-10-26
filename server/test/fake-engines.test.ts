import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAKE_ENGINES, OPENCODE_BAD_MODEL, RATE_LIMITED, SIGNED_OUT, frames, installFakeEngines, readCalls,
  type FakeEngineId, type FakeFleet,
} from "./fixtures/fakeEngines.ts";

const roots: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "agx-fake-engines-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const all = (over: FakeFleet = {}): FakeFleet => ({
  ...Object.fromEntries(FAKE_ENGINES.map((e) => [e, {}])),
  ...over,
});

// A child with the PATH already set: Bun.which, and a shell's own lookup,
// resolve against the PATH a process STARTED with.
async function run(dir: string, cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const HEADLESS: Record<FakeEngineId, string[]> = {
  claude: ["claude", "-p", "hello", "--output-format", "stream-json"],
  codex: ["codex", "exec", "--json", "hello"],
  gemini: ["gemini", "-p", "hello"],
  opencode: ["opencode", "run", "--format", "json", "hello"],
  hermes: ["hermes", "chat", "--query=hello", "--format", "stream-json"],
  agy: ["agy", "-p", "hello", "--output-format", "stream-json"],
};
const STATUS: Record<FakeEngineId, string[]> = {
  claude: ["claude", "auth", "status"],
  codex: ["codex", "login", "status"],
  gemini: ["gemini", "status"],
  opencode: ["opencode", "providers", "list"],
  hermes: ["hermes", "status"],
  agy: ["agy", "status"],
};

describe("each stub answers version, status and headless as specified", () => {
  for (const engine of FAKE_ENGINES) {
    test(engine, async () => {
      const dir = fresh();
      installFakeEngines(dir, all());
      const v = await run(dir, [engine, "--version"]);
      expect(v.code).toBe(0);
      expect(v.out.trim().length).toBeGreaterThan(0);
      const s = await run(dir, STATUS[engine]);
      expect(s.code).toBe(0);
      expect(s.out.trim().length).toBeGreaterThan(0);
      const h = await run(dir, HEADLESS[engine]);
      expect(h.code).toBe(0);
      expect(h.out.trim().split("\n")).toEqual(frames(engine));
    });
  }

  test("the spec decides the version line, the status and its exit code", async () => {
    const dir = fresh();
    installFakeEngines(dir, {
      hermes: { version: { out: "Hermes Agent v0.21.0 (2026.8.31)" }, status: { out: "", stderr: "not logged in", exit: 1 } },
      codex: { version: { out: "", stderr: "ModuleNotFoundError: No module named 'x'", exit: 1 } },
    });
    expect((await run(dir, ["hermes", "--version"])).out).toBe("Hermes Agent v0.21.0 (2026.8.31)\n");
    const st = await run(dir, ["hermes", "status"]);
    expect([st.code, st.err.trim()]).toEqual([1, "not logged in"]);
    const cx = await run(dir, ["codex", "--version"]);
    expect([cx.code, cx.out, cx.err.trim()]).toEqual([1, "", "ModuleNotFoundError: No module named 'x'"]);
  });

  test("an engine left out of the fleet is not on the PATH", async () => {
    const dir = fresh();
    installFakeEngines(dir, { claude: {} });
    const r = await run(dir, ["sh", "-c", "command -v gemini || echo none"]);
    expect(r.out.trim()).toBe("none");
  });

  test("an old parser refuses the flag it does not know before any frame", async () => {
    const dir = fresh();
    installFakeEngines(dir, { hermes: { headless: { unknownFlags: ["--format"] } } });
    const r = await run(dir, HEADLESS.hermes);
    expect([r.code, r.out, r.err.trim()]).toEqual([2, "", "error: unrecognized arguments: --format"]);
    // and still answers when the flag is not used
    expect((await run(dir, ["hermes", "chat", "--query=hello"])).code).toBe(0);
  });

  test("a rate-limited turn prints nothing on stdout and one line on stderr", async () => {
    const dir = fresh();
    installFakeEngines(dir, { opencode: { headless: RATE_LIMITED } });
    const r = await run(dir, HEADLESS.opencode);
    expect([r.code, r.out, r.err.trim()]).toEqual([1, "", "Error: rate limit reached, try again later"]);
  });
});

describe("the failures seen on real CLIs", () => {
  test("signed-out Claude says so on stdout and exits 1; signed-out Codex ends on its 401 frames", async () => {
    const dir = fresh();
    installFakeEngines(dir, { claude: { headless: SIGNED_OUT.claude }, codex: { headless: SIGNED_OUT.codex } });
    const c = await run(dir, HEADLESS.claude);
    expect([c.code, c.out.trim(), c.err]).toEqual([1, "Not logged in · Please run /login", ""]);
    const x = await run(dir, HEADLESS.codex);
    expect(x.code).toBe(1);
    expect(x.out).toContain("401 Unauthorized");
  });

  test("OpenCode reports a model with no provider in a frame and still exits 0", async () => {
    const dir = fresh();
    installFakeEngines(dir, { opencode: { headless: OPENCODE_BAD_MODEL } });
    const r = await run(dir, HEADLESS.opencode);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).error.name).toBe("UnknownError");
  });
});

describe("what was run is recorded exactly", () => {
  test("a prompt that starts with a dash is one argv element, and the env is kept", async () => {
    const dir = fresh();
    installFakeEngines(dir, all());
    const prompt = "--version is not a flag here; it has  two  spaces and 'quotes' and $HOME";
    await run(dir, ["claude", "-p", prompt, "--model", "claude-sonnet-5-5"], { AGENTGLASS_FAKE_MARK: "seen" });
    const calls = readCalls(dir, "claude");
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["-p", prompt, "--model", "claude-sonnet-5-5"]);
    expect(calls[0].env.AGENTGLASS_FAKE_MARK).toBe("seen");
    expect(calls[0].pid).toBeGreaterThan(1);
  });

  test("calls come back oldest first and can be told apart by engine", async () => {
    const dir = fresh();
    installFakeEngines(dir, all());
    await run(dir, ["codex", "--version"]);
    await run(dir, ["claude", "--version"]);
    await run(dir, ["codex", "exec", "--json", "x"]);
    expect(readCalls(dir).map((c) => c.engine)).toEqual(["codex", "claude", "codex"]);
    expect(readCalls(dir, "codex").map((c) => c.argv[0])).toEqual(["--version", "exec"]);
    expect(readCalls(fresh())).toEqual([]);
  });
});

describe("a turn that never ends can be stopped by its process group", () => {
  test("SIGTERM to the group ends the stub and its sleeping child", async () => {
    const dir = fresh();
    installFakeEngines(dir, { claude: { headless: { hang: true } } });
    const p = Bun.spawn(["setsid", "claude", "-p", "x"], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
      stdout: "pipe", stderr: "pipe",
    });
    // The first frame is out once the stub is inside its loop.
    const reader = p.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"subtype":"init"');
    // Past its last frame and still running: that is what "never exit" means.
    await Bun.sleep(300);
    expect(p.exitCode).toBeNull();
    const t0 = Date.now();
    process.kill(-p.pid, "SIGTERM");
    await p.exited;
    expect(Date.now() - t0).toBeLessThan(3000);
    // setsid made the stub its own group leader, so the group is p.pid; the
    // sleeping child goes with it, a moment after the stub itself.
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(-p.pid, 0); await Bun.sleep(20); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });
});

describe("the frame shapes are the ones the server reads", () => {
  test("Codex: the first frame is the thread.started the server greps for", () => {
    const first = frames("codex")[0];
    expect(first).toContain("thread.started");
    expect(JSON.parse(first).thread_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("Claude: the session id sits where the session scanner reads it", () => {
    const m = /"session_id"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(frames("claude")[0]);
    expect(m).not.toBeNull();
  });
});
