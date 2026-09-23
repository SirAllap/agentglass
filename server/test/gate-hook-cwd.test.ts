/*
 * The gate hook says where the call runs — #109.
 *
 * A gate rule and a budget are per project, and the gate payload carried no
 * directory: the server recovered one from the pane note, which only exists for
 * sessions running in an agentglass pane. Everything else — a terminal opened
 * anywhere, a desktop launcher — was a call from nowhere, so a project rule
 * never applied to it. Claude Code hands the hook a `cwd`; this pins that the
 * hook passes it on, by running the real hook against a stand-in server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PY = Bun.which("python3");
const HOOK = new URL("../../hooks/gate_event.py", import.meta.url).pathname;
let dir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let seen: Record<string, unknown> | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-gate-hook-cwd-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen = (await req.json()) as Record<string, unknown>;
      return Response.json({ decision: "allow", reason: "" });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

async function runHook(payload: Record<string, unknown>): Promise<void> {
  seen = null;
  // Async, not spawnSync: the stand-in server lives in this process, and a
  // blocked event loop would never answer the hook it is waiting on.
  const p = Bun.spawn([PY!, HOOK, "--server", `http://127.0.0.1:${server!.port}`, "--timeout", "5"], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "ignore",
    stderr: "ignore",
  });
  await p.exited;
}

test.skipIf(!PY)("the directory Claude Code reports reaches the server", async () => {
  await runHook({ session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/nonexistent/code/orbit" });
  expect(seen).not.toBeNull();
  expect(seen!.cwd).toBe("/nonexistent/code/orbit");
});

test.skipIf(!PY)("a payload without one sends none, and the server falls back to the pane", async () => {
  await runHook({ session_id: "s-1", tool_name: "Bash", tool_input: { command: "ls" } });
  expect(seen).not.toBeNull();
  expect(seen!.cwd ?? "").toBe("");
});
