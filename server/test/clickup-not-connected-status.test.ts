/*
 * "ClickUp is not connected" is an answer, and every ClickUp read gives it the
 * same way. Three routes (search, sprints, list) used to give it as a 400, the
 * rest as a 200, so a client had two conventions to read for one situation.
 * Measured by asking an isolated server with no credential.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-notconn-"));
let proc: ReturnType<typeof Bun.spawn> | null = null, base = "";

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "srv"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("search, sprints and list answer 200 {ok:false,error} when nothing is connected, like task and find", async () => {
  for (const path of ["/clickup/search?q=pagination", "/clickup/sprints?id=c1", "/clickup/list?id=5", "/clickup/task?id=c1"]) {
    const r = await fetch(base + path);
    expect(r.status, path).toBe(200);
    const j = await r.json() as { ok: boolean; error?: string };
    expect(j.ok, path).toBe(false);
    expect(j.error, path).toBe("ClickUp is not connected");
  }
});
