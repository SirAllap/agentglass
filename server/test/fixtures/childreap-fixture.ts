/*
 * Not a suite — the subject of one. `childreap.test.ts` runs this file in a
 * child `bun test` and then looks for the server it left running.
 *
 * It boots the server the way the suites do and, on purpose, never stops it:
 * the file that forgets its `afterAll`, or fails before reaching it.
 * Named without `.test.` so the normal run never collects it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "../freePort.ts";
import { SERVER_BOOT_MS } from "../serverBoot.ts";

const out = process.env.CHILDREAP_REPORT!;
const dir = mkdtempSync(join(tmpdir(), "agx-reapfix-"));

test("the fixture booted a server and walked away from it", async () => {
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", new URL("../../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      LANG: process.env.LANG || "C.UTF-8",
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      TMUX_TMPDIR: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: `agx-reapfix-${process.pid}`,
    },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await Bun.sleep(100); }
  }
  writeFileSync(out, `${proc.pid}\n${dir}\n${up ? "up" : "down"}`);
  expect(up).toBe(true);
}, SERVER_BOOT_MS);
