/*
 * A seat acts on its own project's pull requests, and on no other.
 *
 * The confinement had no test that could fail: the block could be deleted and
 * every suite stayed green. This one is booted with a real seat credential (an
 * adopted chair, so no engine is started) and a sibling project that is not
 * under it, and asks the same act twice.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const have = !!Bun.which("tmux") && !!Bun.which("git");
const TOKEN = "tok-polaris-seat-confinement";
const SOCKET = `agx-polaris-seat-${process.pid}`;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let dir: string, other: string, seatToken: string, base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

const call = async (path: string, method: string, body: unknown, token = TOKEN) => {
  const r = await fetch(base + path, { method, headers: { ...auth, Authorization: `Bearer ${token}`, Origin: base }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const act = (root: string) => call("/polaris/items/7/action", "POST", { root, type: "beacon-draft", reason: "failing", text: "Fix the build." }, seatToken);

async function handTab(cwd: string): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "sleep", "300"],
    { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
  const pane = (await new Response(p.stdout).text()).trim();
  if (await p.exited !== 0 || !pane) throw new Error("the tab did not open");
  return pane;
}

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-polaris-seat-"));
  const init = Bun.spawn(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  if (await init.exited !== 0) throw new Error("the project did not become a repository");
  // A sibling, not a directory under the seat's project.
  other = `${dir}-orbit-b`;
  mkdirSync(other, { recursive: true });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "p.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }

  const adopted = await call("/seat/adopt", "POST", { root: dir, session: "s-polaris-seat", pane: await handTab(dir), powers: "assign" });
  if (!adopted.body.ok) throw new Error(`the seat was not adopted: ${JSON.stringify(adopted.body)}`);
  seatToken = String(adopted.body.token);

  // The person turns Polaris on for the seat's project: Guided keeps the beacon door drafting.
  for (const body of [{ root: dir, preset: "guided" }, { root: dir, enabled: true }]) {
    const r = await call("/polaris/settings", "PUT", body);
    if (r.status !== 200) throw new Error(`Polaris did not switch on: ${JSON.stringify(r.body)}`);
  }
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], {
    env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore",
  }).exited;
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe.skipIf(!have)("a seat acting on pull requests", () => {
  test("acts on its own project and is refused another one, however the path is spelled", async () => {
    expect((await act(dir)).status).toBe(200);
    for (const asked of [other, `${dir}/../orbit-b`, `${other}/`]) {
      const r = await act(asked);
      expect(r.status).toBe(403);
      expect(String(r.body.error)).toContain("not for another one");
    }
  });
});
