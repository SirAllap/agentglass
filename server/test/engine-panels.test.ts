/*
 * The console and the bench are WINDOWS of the checkout's one engine session.
 *
 * They used to be sessions of their own (`<checkout>-console`, and one
 * `<checkout>-bench<n>` per tab). That broke the product rule — one engine
 * session per workspace, every window in it — and it made both panels tabs the
 * terminal strip could not show.
 *
 * What is driven here is the whole life of that, against a real tmux on a
 * socket of this suite's own:
 *
 *   - the window is made in the engine session, and the old session names are
 *     never created;
 *   - a panel's pty joins a SESSION GROUP of it and shows its own window while
 *     the engine's current window does not move — a second client on the same
 *     session mirrors the first, which is the bug the old separate sessions
 *     were avoiding;
 *   - the view goes when its client does;
 *   - closing a bench ends its window;
 *   - a restore after the server is gone finds the windows again.
 *
 * Isolation, every call: a TMUX_TMPDIR of its own, an engine socket of its own,
 * no TMUX in the environment, and no `kill-server` that is not addressed to
 * this suite's socket. Nothing here can reach the developer's tmux.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { killServerAndWait } from "./tmuxTmp.ts";

const REAL = {
  tmp: process.env.TMUX_TMPDIR,
  root: process.env.AGENTGLASS_ROOT,
  state: process.env.AGENTGLASS_STATE_DIR,
  socket: process.env.AGENTGLASS_TMUX_SOCKET,
  tmux: process.env.TMUX,
};
const SOCKET = `agx-panels-${process.pid}`;
const BOX = mkdtempSync(join(tmpdir(), "agx-panels-"));
const CWD = join(BOX, "orbit");
const STATE = join(BOX, "state");
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = join(BOX, "tmux");
process.env.AGENTGLASS_STATE_DIR = STATE;
process.env.AGENTGLASS_ROOT = BOX;
delete process.env.TMUX;

let pane: typeof import("../src/tmuxpane.ts");
let bench: typeof import("../src/bench.ts");
let restore: typeof import("../src/tmuxrestore.ts");
let conf: typeof import("../src/tmuxconf.ts");
let engine = "";
let have = false;

beforeAll(async () => {
  mkdirSync(CWD, { recursive: true });
  mkdirSync(STATE, { recursive: true });
  mkdirSync(process.env.TMUX_TMPDIR!, { recursive: true, mode: 0o700 });
  pane = await import("../src/tmuxpane.ts");
  bench = await import("../src/bench.ts");
  restore = await import("../src/tmuxrestore.ts");
  conf = await import("../src/tmuxconf.ts");
  engine = pane.engineSessionName(CWD);
  /* The engine's conf by hand: `ensureConf` remembers the content it last
     wrote, and every test file shares one process. */
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
  have = pane.tmuxCapability().available;
});

afterAll(async () => {
  /* The server first, while its socket is still findable — see tmuxrestore.test.ts.
     Addressed to this suite's socket and waited for, so nothing outlives the box. */
  try { await killServerAndWait((a) => pane.tmux(a), SOCKET); } catch { /* already gone */ }
  for (const [k, v] of Object.entries({
    TMUX_TMPDIR: REAL.tmp,
    AGENTGLASS_ROOT: REAL.root,
    AGENTGLASS_STATE_DIR: REAL.state,
    AGENTGLASS_TMUX_SOCKET: REAL.socket,
    TMUX: REAL.tmux,
  })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(BOX, { recursive: true, force: true });
});

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/* An empty configuration for the CLIENT this file spawns.
 *
 * The server is the engine's — `ensurePanelWindow` made it, with the engine's
 * own conf, on the socket and TMUX_TMPDIR this file owns. The attach argv under
 * test carries that same `-f`; swapping it for /dev/null here keeps the property
 * the isolation lint asks for of every test that runs tmux at all: nothing in
 * this file can read ~/.tmux.conf, and a server it started by accident would
 * read nothing either. */
const EMPTY_CONF = ["-f", "/dev/null"] as const;

/** The panel's pty, as terminal.ts spawns it: a terminal running the argv. */
function attachInPty(product: string[]) {
  const argv = [...product];
  const at = argv.indexOf("-f");
  if (at >= 0) argv.splice(at, 2, ...EMPTY_CONF);
  /* A TERM, as `ptyOpen` gives its own pty before it hands it a panel's argv:
     the CI runner has none, and tmux then refuses the attach with "terminal
     does not support clear" — leaving the view it had already made behind,
     which is also why the bench below found two sessions it did not expect. */
  const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
  delete env.TMUX;
  return Bun.spawn(
    ["script", "-qec", `stty rows 30 cols 100; exec ${argv.map(shq).join(" ")}`, "/dev/null"],
    { env, cwd: CWD, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
}

/** The view session this pty joined, once tmux lists it. */
async function viewOf(pid: number): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const r = await pane.tmux(["list-clients", "-F", "#{session_name}"]);
    const view = (r.ok ? r.stdout.split("\n") : []).map((s) => s.trim()).find((n) => pane.isPanelViewSession(n));
    if (view) return view;
    try { process.kill(pid, 0); } catch { break; }
    await Bun.sleep(50);
  }
  return null;
}

async function until<T>(f: () => Promise<T | null | false | "" | undefined>, ms = 4000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) return null;
    await Bun.sleep(40);
  }
}

const sessions = async (): Promise<string[]> => {
  const r = await pane.tmux(["list-sessions", "-F", "#{session_name}"]);
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
};

const windows = async (): Promise<string[]> => {
  const r = await pane.tmux(["list-windows", "-t", `=${engine}:`, "-F", "#{window_name}"]);
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
};

describe("a panel is a window on the one engine session", () => {
  it("makes the window in the engine session, and no session of its own", async () => {
    if (!have) return;
    const con = pane.ensurePanelWindow(CWD, pane.CONSOLE_WINDOW);
    expect(con).not.toBeNull();
    const tab = pane.ensurePanelWindow(CWD, pane.benchWindowName(1), { runs: ["sh", "-c", "sleep 300"], cwd: CWD });
    expect(tab).not.toBeNull();
    expect(await sessions()).toEqual([engine]);
    expect(await windows()).toEqual(expect.arrayContaining(["console", "bench-1"]));
    /* The session this panel made is not left ON the panel's window: a terminal
       view attaching later lands on the session's current window, and landing
       on `console` is two clients on one window — the mirroring this design
       exists to avoid. */
    const current = (await pane.tmux(["display-message", "-t", `=${engine}:`, "-p", "#{window_name}"])).stdout.trim();
    expect(current).not.toBe("console");
    expect(current).not.toBe("bench-1");
    // The names older builds made are never on this socket.
    for (const n of await sessions()) {
      expect(n.endsWith("-console"), n).toBe(false);
      expect(/-bench\d+$/.test(n), n).toBe(false);
    }
  });

  it("reattaches to the window that is already working rather than making a second", async () => {
    if (!have) return;
    const first = pane.ensurePanelWindow(CWD, pane.benchWindowName(2), { runs: ["sh", "-c", "sleep 300"] });
    const again = pane.ensurePanelWindow(CWD, pane.benchWindowName(2), { runs: ["sh", "-c", "echo SECOND; sleep 300"] });
    expect(again?.windowId).toBe(first?.windowId);
    expect((await windows()).filter((n) => n === "bench-2")).toHaveLength(1);
    await pane.tmux(["kill-window", "-t", first!.windowId]);
  });

  it("shows its own window while the engine's current window stays where it was", async () => {
    if (!have || !Bun.which("script")) return;
    const w = pane.ensurePanelWindow(CWD, pane.benchWindowName(1), { runs: ["sh", "-c", "sleep 300"] });
    expect(w).not.toBeNull();
    /* Put the engine's current window somewhere else first: the terminal view
       is usually on its own window, not on the one a panel is about to show. */
    const current = (await pane.tmux(["display-message", "-t", `=${engine}:`, "-p", "#{window_name}"])).stdout.trim();
    const argv = pane.engineBenchArgv(CWD, 1, w!.windowId);
    expect(argv).not.toBeNull();
    const pty = attachInPty(argv!);
    try {
      const view = await until(() => viewOf(pty.pid));
      expect(view, "the panel's pty joined a view of the engine").not.toBeNull();
      const seen = (await pane.tmux(["display-message", "-t", `=${view}:`, "-p", "#{window_name}"])).stdout.trim();
      expect(seen).toBe("bench-1");
      const after = (await pane.tmux(["display-message", "-t", `=${engine}:`, "-p", "#{window_name}"])).stdout.trim();
      expect(after, "the terminal view's window did not move").toBe(current);
      // And it is a group, not a session with windows of its own: the same one.
      const group = (await pane.tmux(["display-message", "-t", `=${view}:`, "-p", "#{session_group}"])).stdout.trim();
      expect(group).not.toBe("");
    } finally {
      const view = await viewOf(pty.pid);
      if (view) await pane.tmux(["detach-client", "-s", view]);
      await until(async () => {
        const gone = !(await sessions()).includes(view ?? "\u0000");
        return gone;
      });
      try { pty.kill(); } catch { /* already gone */ }
      await pty.exited;
    }
    // The view died with its client: nothing of the panel is left on the socket.
    expect((await sessions()).some((n) => pane.isPanelViewSession(n))).toBe(false);
  }, 20_000);

  it("hands the window's variables to its pane with -e, before the command", async () => {
    if (!have || !Bun.which("script")) return;
    const w = pane.ensurePanelWindow(CWD, pane.benchWindowName(4), {
      runs: ["sh", "-c", "echo ROLE=$AGENTGLASS_ROLE; sleep 300"],
      env: { AGENTGLASS_ROLE: "lantern" },
      cwd: CWD,
    });
    expect(w).not.toBeNull();
    const pty = attachInPty(pane.engineBenchArgv(CWD, 4, w!.windowId)!);
    try {
      const seen = await until(async () => {
        const view = await viewOf(pty.pid);
        if (!view) return null;
        const out = await pane.tmux(["capture-pane", "-p", "-t", `=${view}:`]);
        return out.ok && out.stdout.includes("ROLE=lantern") ? out.stdout : null;
      });
      expect(seen, "the pane got the role").not.toBeNull();
    } finally {
      const view = await viewOf(pty.pid);
      if (view) await pane.tmux(["detach-client", "-s", view]);
      /* The view goes when its client does, a moment later: a session the next
         test counts must not depend on when that lands. */
      await until(async () => !(await sessions()).includes(view ?? "\u0000"));
      try { pty.kill(); } catch { /* already gone */ }
      await pty.exited;
      await pane.tmux(["kill-window", "-t", w!.windowId]);
    }
  }, 20_000);
});

describe("the bench reads and closes windows, not sessions", () => {
  it("reports the slots whose window is alive, and ends one when asked", async () => {
    if (!have) return;
    const one = pane.ensurePanelWindow(CWD, pane.benchWindowName(1), { runs: ["sh", "-c", "sleep 300"] });
    const three = pane.ensurePanelWindow(CWD, pane.benchWindowName(3), { runs: ["sh", "-c", "sleep 300"] });
    expect(one && three).toBeTruthy();
    expect((await bench.benchLive(CWD)).slots).toEqual([1, 3]);
    expect(await bench.benchEnd(CWD, 3)).toMatchObject({ ok: true, ended: true });
    expect(await windows()).not.toContain("bench-3");
    expect((await bench.benchLive(CWD)).slots).toEqual([1]);
    // The session itself is untouched: closing a tab closes a window.
    expect(await sessions()).toEqual([engine]);
    expect(await bench.benchEnd(CWD, 3)).toMatchObject({ ok: true, ended: false });
  });
});

describe("a restore finds the windows", () => {
  it("rebuilds console and bench windows that are in the photograph", async () => {
    if (!have) return;
    pane.ensurePanelWindow(CWD, pane.CONSOLE_WINDOW);
    pane.ensurePanelWindow(CWD, pane.benchWindowName(2), { runs: ["sh", "-c", "sleep 300"] });
    // A pane forked a moment ago has not exec'd yet and reads as the tmux
    // binary itself, which the capture leaves out on purpose.
    await Bun.sleep(300);
    const state = await restore.captureLayout();
    const photographed = state?.sessions.find((s) => s.name === engine)?.windows.map((w) => w.name) ?? [];
    expect(photographed).toEqual(expect.arrayContaining(["console", "bench-2"]));

    /* The shape of a reboot: the server that held them is gone, so nothing
       tmux lists is a close somebody made. */
    await killServerAndWait((a) => pane.tmux(a), SOCKET);
    const r = await restore.restoreLayout("lazy");
    expect(r.ok, r.error).toBe(true);
    expect(await windows()).toEqual(expect.arrayContaining(["console", "bench-2"]));
    // And still no session named after a panel.
    for (const n of await sessions()) {
      expect(n.endsWith("-console"), n).toBe(false);
      expect(/-bench\d+$/.test(n), n).toBe(false);
    }
  }, 30_000);

  it("skips a panel's view: one photograph of a window, and no view rebuilt", async () => {
    if (!have) return;
    /* A view is a GROUP of the engine: every window in it is the engine's, so a
       photograph that took it would carry a second copy of `console` under
       `agx-view-…`, and the reboot that rebuilt it would leave a session nobody
       is attached to. */
    const view = `agx-view-${process.pid}-probe`;
    const made = await pane.tmux(["new-session", "-d", "-t", `=${engine}`, "-s", view]);
    expect(made.ok, made.stderr).toBe(true);
    pane.ensurePanelWindow(CWD, pane.CONSOLE_WINDOW);
    await Bun.sleep(300);
    const state = await restore.captureLayout();
    expect(state?.sessions.some((s) => s.name === view)).toBe(false);
    expect(state?.sessions.filter((s) => s.name === engine)).toHaveLength(1);

    await killServerAndWait((a) => pane.tmux(a), SOCKET);
    const r = await restore.restoreLayout("lazy");
    expect(r.ok, r.error).toBe(true);
    expect(await sessions()).not.toContain(view);
    expect(await windows()).toContain("console");
  }, 30_000);
});
