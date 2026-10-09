/*
 * The pending-gate list rings the clients whenever it changes, so the dashboard
 * need not poll it.
 *
 * `/gate/pending` was fetched every two seconds by every window (30 identical
 * requests a minute, measured) because only a NEW hold was pushed, as an alert
 * frame. A hold that was decided, timed out or was answered by a rule changed
 * the list without a word. This holds the push to every one of those ways.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket;
let gateFrames = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-gatepush-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "gate.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { await Bun.sleep(100); }
  }
  if (!up) throw new Error("the server did not come up");
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: "gate-push" }));
  ws.addEventListener("message", (ev) => {
    try { if (JSON.parse(String((ev as MessageEvent).data)).type === "gate") gateFrames++; } catch { /* not JSON */ }
  });
}, SERVER_BOOT_MS);

afterAll(() => {
  try { ws?.close(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const hold = (id: string, timeoutMs: number) =>
  void fetch(base + "/gate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, source_app: "claude", session_id: "s-1", tool_name: "Bash", tool_input: { command: "make build" }, timeout_ms: timeoutMs }),
  }).catch(() => {});

async function frames(atLeast: number): Promise<number> {
  for (let i = 0; i < 60 && gateFrames < atLeast; i++) await Bun.sleep(50);
  return gateFrames;
}

test("a new hold, a decision and a timeout each ring the clients", async () => {
  const a = "00000000-0000-4000-8000-00000000000a";
  hold(a, 30_000);
  expect(await frames(1), "a hold arrived").toBeGreaterThanOrEqual(1);
  const afterArrival = gateFrames;
  const r = await fetch(base + "/gate/decide", {
    method: "POST", headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: a, decision: "deny", reason: "no" }),
  });
  expect((await r.json() as { ok: boolean }).ok).toBe(true);
  expect(await frames(afterArrival + 1), "a decision changed the list").toBeGreaterThan(afterArrival);

  const b = "00000000-0000-4000-8000-00000000000b";
  const beforeTimeout = gateFrames;
  hold(b, 300);
  expect(await frames(beforeTimeout + 1), "the second hold arrived").toBeGreaterThan(beforeTimeout);
  const armed = gateFrames;
  /* Nobody answers: the server's own timer resolves it, and that is a change too. */
  expect(await frames(armed + 1), "a timed-out hold left the list").toBeGreaterThan(armed);
  const pending = await (await fetch(base + "/gate/pending")).json() as { gates: unknown[] };
  expect(pending.gates.length).toBe(0);
});
