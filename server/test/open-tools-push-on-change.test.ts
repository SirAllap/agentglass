/*
 * An open tool call is pushed to every client when the list changes, not on
 * every four second tick.
 *
 * With one call open the server sent the same 225 byte `openTools` frame 15
 * times a minute to each client (measured), because the tick broadcast whatever
 * it read. A change, a call closing and a new client (which is handed the list
 * in `initial`) still get one.
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
let frames = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-toolspush-"));
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
      AGENTGLASS_DB: join(dir, "tools.db"),
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
  ws.send(JSON.stringify({ type: "hello", clientId: "tools-push" }));
  ws.addEventListener("message", (ev) => {
    try { if (JSON.parse(String((ev as MessageEvent).data)).type === "openTools") frames++; } catch { /* not JSON */ }
  });
}, SERVER_BOOT_MS);

afterAll(() => {
  try { ws?.close(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const ingest = (type: string, id: string) =>
  fetch(base + "/ingest", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_app: "orbit", session_id: "orbit-tools-1", hook_event_type: type, tool_name: "Bash", timestamp: Date.now(), payload: { cwd: dir, project_path: dir, tool_name: "Bash", tool_use_id: id, tool_input: { command: "make build" } } }),
  });

test("an unchanged open call is pushed once, not every tick", async () => {
  expect((await ingest("PreToolUse", "call-1")).ok).toBe(true);
  await Bun.sleep(9500);                          // two and a bit ticks
  console.log(`openTools frames in 9.5 s with one call open: ${frames}`);
  expect(frames, "the call opening").toBeGreaterThanOrEqual(1);
  expect(frames, "and nothing after it while nothing changed").toBeLessThanOrEqual(1);
  const before = frames;
  expect((await ingest("PostToolUse", "call-1")).ok).toBe(true);
  await Bun.sleep(300);
  expect(frames, "the call closing is a change").toBeGreaterThan(before);
}, 20_000);
