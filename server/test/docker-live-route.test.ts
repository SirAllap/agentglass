/*
 * `GET /docker/live` through a real server: the same credential gate as the
 * rest of /docker, a stream that carries what `docker events` says, and a
 * docker process that is gone once the client hangs up (closing a tab sends no
 * goodbye, only a closed socket).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-live-feed";
let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-liveroute-"));
  writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  events) echo $$ > "${dir}/events.pid"; sleep 0.3; echo '{"Type":"volume","Action":"create","id":"data"}'; exec sleep 300 ;;
  stats) exec sleep 300 ;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`, TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

test("no credential, no feed", async () => {
  expect((await fetch(base + "/docker/live")).status).toBe(401);
});

test("the stream carries a change, and hanging up kills the docker process", async () => {
  const ctl = new AbortController();
  const r = await fetch(base + "/docker/live", { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctl.signal });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/event-stream");
  const reader = r.body!.getReader();
  let text = "";
  const end = Date.now() + 8000;
  while (Date.now() < end && !text.includes(`"scope":"volumes"`)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  expect(text).toContain(`data: {"kind":"changed","scope":"volumes"}`);
  expect(existsSync(join(dir, "events.pid"))).toBe(true);
  const pid = Number(readFileSync(join(dir, "events.pid"), "utf8"));
  expect(alive(pid)).toBe(true);
  ctl.abort();
  let gone = false;
  for (let i = 0; i < 80 && !gone; i++) { gone = !alive(pid); if (!gone) await Bun.sleep(50); }
  expect(gone).toBe(true);
}, 20_000);
