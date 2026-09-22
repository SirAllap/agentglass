/*
 * THE DESK IS WHOLE ON ONE ENGINE, AND A NEW ENGINE IS PUT BACK.
 *
 * A session or window missing from a photograph is forgotten only once this
 * process has put the desk back on the tmux server it is looking at. Bound to
 * the server read once at the end of the first pass, that went wrong two
 * ways, both measured: with no server running at that moment (a first run, or
 * a layout that had just been cleared) the desk was never whole for the life
 * of the process; and after the server was replaced — the last session
 * closed, the conf reset, a crash — it was never whole again. Either way a
 * tab somebody closed was kept, and rebuilt at the next boot.
 *
 * Real tmux on its own socket and its own state directory.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCKET = `agx-settle-${process.pid}`;
const TMPDIR = join(tmpdir(), `agx-settle-tmp-${process.pid}`);
const STATE = join(tmpdir(), `agx-settle-state-${process.pid}`);
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");

const P = `agxsettleP${process.pid}`;
const Q = `agxsettleQ${process.pid}`;
const R = `agxsettleR${process.pid}`;

type Layout = { sessions: { name: string; windows: { name?: string }[] }[] };
const layout = (): Layout | null => {
  try { return JSON.parse(readFileSync(join(STATE, "tmux", "restore", "layout.json"), "utf8")); } catch { return null; }
};
const names = () => (layout()?.sessions ?? []).map((s) => s.name);
const windowsOf = (s: string) => (layout()?.sessions.find((x) => x.name === s)?.windows ?? []).map((w) => w.name);

beforeAll(async () => {
  mkdirSync(TMPDIR, { recursive: true });
  process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
  process.env.AGENTGLASS_STATE_DIR = STATE;
  process.env.TMUX_TMPDIR = TMPDIR;
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  const put = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put("AGENTGLASS_TMUX_SOCKET", REAL_SOCKET);
  put("AGENTGLASS_STATE_DIR", REAL_STATE);
  put("TMUX_TMPDIR", REAL_TMPDIR);
  for (const d of [TMPDIR, STATE]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* never made */ } }
});

test("with no server running when the desk was put back, the first server after is the desk's", async () => {
  /* Nothing recorded, nothing running: the pass has nothing to build. */
  const r = await restore.restoreLayout("lazy");
  expect(r.ok).toBe(false);
  expect((await pane.tmux(["new-session", "-d", "-s", P, "-n", "one", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  expect((await pane.tmux(["new-window", "-d", "-t", `=${P}:`, "-n", "extra", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  expect((await pane.tmux(["new-session", "-d", "-s", Q, "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  await restore.captureLayout();
  expect(names()).toContain(Q);
  expect(windowsOf(P)).toContain("extra");

  await pane.tmux(["kill-session", "-t", `=${Q}`]);
  await pane.tmux(["kill-window", "-t", `=${P}:extra`]);
  await restore.captureLayout();
  expect(names(), "a session closed on a whole desk was kept").not.toContain(Q);
  expect(windowsOf(P), "a window closed on a whole desk was kept").not.toContain("extra");
}, 20_000);

test("a server started since is put back once, and then it is the desk's", async () => {
  expect((await pane.tmux(["new-session", "-d", "-s", R, "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  await restore.captureLayout();
  expect(names()).toContain(R);

  /* The server dies; something makes one session on a new one. */
  await pane.tmux(["kill-server"]);
  await Bun.sleep(300);
  expect((await pane.tmux(["new-session", "-d", "-s", P, "-n", "one", "-c", "/tmp", "sleep", "300"])).ok).toBe(true);
  /* One sweep sees it and forgets nothing; the second puts the desk back. */
  await restore.captureLayout();
  expect(names(), "a session lost with the server was forgotten").toContain(R);
  expect((await pane.tmux(["has-session", "-t", `=${R}`])).ok, "put back on a server seen once").toBe(false);
  await restore.captureLayout();
  await Bun.sleep(50);
  for (let i = 0; i < 50 && restore.isRestoring(); i++) await Bun.sleep(100);
  expect((await pane.tmux(["has-session", "-t", `=${R}`])).ok, "the desk was not put back on the new server").toBe(true);
  expect(names(), "a session lost with the server was forgotten").toContain(R);

  /* And from then on a close is a close. */
  await pane.tmux(["kill-session", "-t", `=${R}`]);
  await restore.captureLayout();
  expect(names()).not.toContain(R);
}, 20_000);
