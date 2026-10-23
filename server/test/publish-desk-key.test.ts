/*
 * Publishing a review is the person's click, and the person's click is the
 * app's own window: on a server the desktop app started, that window is the one
 * holder of the desk key. The gate asked for the key, and the window never sent
 * it on these two routes (web/src/lib/deskGate.ts did not list them), so the
 * press was refused as if an agent had made it. Asked through a booted server
 * with a key held, with the credentials the window and each agent actually have.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { deskGated } from "../../web/src/lib/deskGate.ts";

const TOKEN = "orbit-publish-token-0123456789abcdef";
const KEY = "desk-key-the-shell-minted-0123456789abcdefgh";
const APP = "agentglass://app";
const SERVER_SRC = new URL("../src/index.ts", import.meta.url).pathname;
const ROUTES = ["/plugins/pr-notes/publish-preview", "/plugins/pr-notes/publish"];
const REFUSED = "the person's own click";

let dir = "", base = "", proc: ChildProcess | null = null, said = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-publish-desk-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn("bun", ["run", SERVER_SRC], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, ".claude"), AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "publish.db"), AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port), AGENTGLASS_DESK_FD: `3:${process.pid}`,
    },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  const pipe = proc.stdio[3] as Writable;
  pipe.on("error", () => { /* gone before it read */ });
  pipe.end(`${KEY}\n`);
  proc.stderr?.on("data", (c) => { said = (said + c).slice(-8000); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + said.slice(0, 400));
}, SERVER_BOOT_MS);
afterAll(() => { proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

const send = (path: string, headers: Record<string, string | undefined>) =>
  fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ plugin: "acme-review", repo: "acme/orbit", number: 1042 }) });

describe("publish through the window's own credentials", () => {
  test("both routes are on the list the web client sends the key for", () => {
    for (const r of ROUTES) expect(deskGated(r)).toBe(true);
  });

  for (const route of ROUTES) {
    test(`${route}: the window (origin + desk key) gets past the gate`, async () => {
      const r = await send(route, { origin: APP, "x-agentglass-desk": KEY });
      const text = await r.text();
      expect(text).not.toContain(REFUSED);
      expect(r.status).not.toBe(403);
    });
    test(`${route}: the machine token alone, a forged origin, a wrong key and an agent are refused`, async () => {
      for (const h of [{} as Record<string, string>, { origin: APP }, { origin: APP, "x-agentglass-desk": "wrong" }, { origin: APP, "x-agentglass-desk": KEY, "x-agentglass-agent": "acme-bot" }]) {
        const r = await send(route, h);
        expect(r.status).toBe(403);
        expect(await r.text()).toContain(REFUSED);
      }
    });
  }
});
