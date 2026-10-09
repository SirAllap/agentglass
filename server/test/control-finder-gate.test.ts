/*
 * `open finder` puts a file chosen by the caller in front of the person, so who
 * may send it is the whole question, and it is asked of a running server:
 * the source-text test next door only proves the line is there.
 *
 * Which layer refuses is not this file's business: the outer origin check
 * already turns a foreign page away before trustedCaller is reached (measured:
 * deleting the trustedCaller line leaves these green), and a remote caller with
 * no Origin cannot be made from a loopback test. The line itself is pinned by
 * mutating-routes-guard.test.ts, which does go red without it; this file pins
 * the behaviour a caller sees, whichever layer gives it.
 *
 * A page on another origin must be refused outright (it is the one caller that
 * could otherwise show somebody a file without being asked), a loopback caller
 * with no Origin is the agent this exists for, and a bad path is a 400 that
 * never reaches a window.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-control-finder-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
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
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + "/control", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const finder = (path: string) => ({ cmd: "open", what: "finder", path });

describe("POST /control open finder", () => {
  test("a caller on this machine with no Origin is accepted", async () => {
    const r = await post(finder("/home/ana/notes/plan.md"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  test("a page on another origin is refused, and the same body from this machine is not", async () => {
    const r = await post(finder("/home/ana/notes/plan.md"), { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  test("a bad path is a 400, not a command", async () => {
    for (const p of ["plan.md", "/home/ana/../bob/plan.md", "/home/ana/a\0b"]) {
      const r = await post(finder(p));
      expect(r.status).toBe(400);
    }
  });
});
