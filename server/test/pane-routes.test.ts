/*
 * The two routes behind "keep this one" and "what is running".
 *
 * Driven against a real server, because the interesting half is not the pane
 * bookkeeping (that has its own suite) but what the HTTP does with it: which
 * names are refused before they can reach `tmux kill-session -t`, and how the
 * orphan judgement is put together from two things neither side knows alone.
 *
 * Most of it runs against an empty socket, which is exactly the state of a
 * machine with the pane engine switched off — worth pinning that the panel
 * answers rather than errors there, since the alternative is a settings tab
 * that fails to load for everybody not using panes.
 *
 * The orphan judgement gets a real tmux session, because it is the one thing
 * that cannot be observed without a pane to judge. Skipped where tmux is not
 * installed, and on its own socket with a `sleep` in it — never a `claude`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const A = "6b191fd3-f71e-5010-863d-d32334eaf400";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-panes-"));
  const port = 4930 + Math.floor(Math.random() * 20);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env`.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      // A socket nothing is listening on, so `tmux list-sessions` fails the way
      // it does on a machine that has never run a pane: cleanly, with nothing.
      AGENTGLASS_TMUX_SOCKET: "agentglass-test-nothing-here",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const jsonOf = (r: Response) => r.json() as Promise<Json>;
const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("pinning a chat's pane", () => {
  test("takes a session id and says what it did", async () => {
    const r = await jsonOf(await post("/chat/pane/pin", { session: A, pinned: true }));
    expect(r).toEqual({ ok: true, session: A, pinned: true });
  });

  test("and unpinning is the same route, not a second one", async () => {
    const r = await jsonOf(await post("/chat/pane/pin", { session: A, pinned: false }));
    expect(r.pinned).toBe(false);
  });

  test("refuses a name that is not a session id", async () => {
    // The name ends up in `tmux kill-session -t`, and tmux reads `:` and `.` as
    // window and pane separators — a crafted one resolves onto a target nobody
    // meant. Refused here rather than escaped later.
    for (const session of ["../../etc/passwd", "a; rm -rf /", "sess:0.1", "short", ""]) {
      const r = await post("/chat/pane/pin", { session, pinned: true });
      expect(r.status, session).toBe(400);
    }
  });

  test("and a body that is not a body", async () => {
    const r = await fetch(base + "/chat/pane/pin", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(r.status).toBe(400);
  });

  test("defaults to pinning when the flag is missing, not to unpinning", async () => {
    // The route is reached by a toggle; a missing flag is a client that meant
    // the affirmative, and silently unpinning would be the one direction that
    // loses a warm CLI somebody asked to keep.
    const r = await jsonOf(await post("/chat/pane/pin", { session: A }));
    expect(r.pinned).toBe(true);
    await post("/chat/pane/pin", { session: A, pinned: false });
  });
});

describe("listing what is running", () => {
  test("answers on a machine with no panes at all", async () => {
    // Every user who has not switched the pane engine on. A settings tab that
    // errors for them would be a worse bug than the one this panel fixes.
    const r = await fetch(base + "/chat/panes?open=");
    expect(r.status).toBe(200);
    const j = await jsonOf(r);
    expect(j.panes).toEqual([]);
  });

  test("says how long a pane may idle, so the panel need not guess", async () => {
    const j = await jsonOf(await fetch(base + "/chat/panes?open="));
    // The default is 30 minutes, and 0 would mean eviction is off — which the
    // panel has to be able to say out loud rather than imply.
    expect(j.idleEvictMs).toBe(30 * 60_000);
  });

  test("takes the open chats from the caller, because the server has no idea", async () => {
    // Which chats are on screen is known only to the client, and a pane
    // belonging to a chat open in another window must not be called abandoned.
    // Nothing is running here, so what is asserted is that the parameter is
    // accepted and shapes the answer rather than being ignored.
    const r = await fetch(`${base}/chat/panes?open=${A},${encodeURIComponent("  ")}`);
    expect(r.status).toBe(200);
    expect((await jsonOf(r)).panes).toEqual([]);
  });
});

/**
 * With something actually running.
 *
 * `sleep` rather than an agent: what is under test is the bookkeeping, and a
 * suite that started a real CLI would be spending somebody's tokens to check a
 * boolean. Its own socket, so it cannot see — or reap — the developer's panes.
 */
describe("with a pane genuinely running", () => {
  const SOCK = "agentglass-test-nothing-here";
  const tmuxOk = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", SOCK, ...args]);

  test.skipIf(!tmuxOk)("a pane no open chat points at is named an orphan", async () => {
    tmux("new-session", "-d", "-s", A, "sleep", "300");
    try {
      // Nothing open: the state after a crash, where the panes are still there
      // and nothing in the app knows about any of them.
      const none = await jsonOf(await fetch(base + "/chat/panes?open="));
      const row = none.panes.find((p: Json) => p.name === A);
      expect(row, "the running pane was not listed at all").toBeTruthy();
      expect(row.orphan).toBe(true);
      expect(row.running).toBe(false);

      // …and the same pane, with its chat open in this window, is not.
      const open = await jsonOf(await fetch(`${base}/chat/panes?open=${A}`));
      expect(open.panes.find((p: Json) => p.name === A).orphan).toBe(false);
    } finally {
      tmux("kill-session", "-t", "=" + A);
    }
  });

  test.skipIf(!tmuxOk)("and a pin shows up in the listing", async () => {
    tmux("new-session", "-d", "-s", A, "sleep", "300");
    try {
      await post("/chat/pane/pin", { session: A, pinned: true });
      const j = await jsonOf(await fetch(base + "/chat/panes?open="));
      expect(j.panes.find((p: Json) => p.name === A).pinned).toBe(true);
      await post("/chat/pane/pin", { session: A, pinned: false });
      const after = await jsonOf(await fetch(base + "/chat/panes?open="));
      expect(after.panes.find((p: Json) => p.name === A).pinned).toBe(false);
    } finally {
      tmux("kill-session", "-t", "=" + A);
    }
  });

  test.skipIf(!tmuxOk)("ending one actually ends it", async () => {
    tmux("new-session", "-d", "-s", A, "sleep", "300");
    expect((await jsonOf(await post("/chat/pane/close", { session: A }))).killed).toBe(true);
    const j = await jsonOf(await fetch(base + "/chat/panes?open="));
    expect(j.panes.find((p: Json) => p.name === A)).toBeUndefined();
  });
});

describe("ending one", () => {
  test("is the route that already exists, not a new one", async () => {
    // Ending a pane is ending a pane. A second route that killed panes would be
    // one more thing able to stop an agent, for no new capability.
    const r = await jsonOf(await post("/chat/pane/close", { session: A }));
    expect(r).toHaveProperty("killed");
  });
});
