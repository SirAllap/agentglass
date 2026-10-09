/*
 * "Edit in nvim" puts nvim on that file in the bench — checked on the tmux
 * pane, not on the command we would have built.
 *
 * Two fixes before this one were proven by unit tests (the viewing door
 * accepts the path; the editor argv holds the path) and the button still
 * opened a shell prompt in the checkout. The defect was never in the command:
 * the checkout's reader session already existed as a plain SHELL — created
 * once, when its first file could not be opened — and `new-session -A`
 * attaches to whatever holds the name and ignores the command. So this drives
 * a real server over the same socket the button's tab opens
 * (`/terminal/pty?view=…&edit=1&bench=90`) and asks tmux what the pane is
 * running afterwards.
 *
 * The file lives OUTSIDE the project, in a folder under the server's home: the
 * finder's Machine tab, which is where every report of this came from.
 *
 * Its own tmux socket under its own TMUX_TMPDIR, `-f /dev/null` for the
 * fixture's calls, a HOME of its own (so nvim loads nobody's config), and
 * every state directory jailed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";

/* Short, because a unix socket path is 108 bytes — see tmux-shutdown-restore. */
const TMPDIR = `/tmp/agx-rdr-${process.pid}`;
const SOCK = "agx-rdr";
const HAVE = !!Bun.which("tmux") && !!Bun.which("nvim") && !!Bun.which("git") && process.platform === "linux";
const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const SOCKET_FILE = `${TMPDIR}/tmux-${uid}/${SOCK}`;

const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", SOCKET_FILE, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX_TMPDIR: TMPDIR, TMUX: "" },
  });
const out = (...args: string[]) => tmux(...args).stdout.toString().trim();

let server: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let project = "";
let home = "";
let md = "";
let json = "";
const READER = "orbit-bench90";

/** What the reader's pane is running, and what it was started with. */
function reader(): { current: string; start: string; pid: string } | null {
  const r = out("display-message", "-p", "-t", `=${READER}:`, "#{pane_current_command}\t#{pane_start_command}\t#{pane_pid}");
  if (!r) return null;
  const [current = "", start = "", pid = ""] = r.split("\t");
  return { current, start, pid };
}

/** Open the bench reader tab exactly as the web client does, and wait for the
 *  server's first control frame. */
function openReader(view: string): Promise<{ ws: WebSocket; frame: { t?: string; error?: string } }> {
  const q = new URLSearchParams({ root: project, cols: "100", rows: "30", view, edit: "1", bench: "90" });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/pty?${q}`);
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error("no control frame")), 15_000);
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") return;
      let frame: { t?: string; error?: string };
      try { frame = JSON.parse(e.data); } catch { return; }
      if (frame.t === "ready" || frame.t === "fatal") { clearTimeout(fail); resolve({ ws, frame }); }
    });
    ws.addEventListener("error", () => { clearTimeout(fail); reject(new Error("socket refused")); });
  });
}

/** Poll, because nvim takes a moment to exec inside the new pane. */
async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = read();
  while (!ok(v) && Date.now() < end) { await Bun.sleep(100); v = read(); }
  return v;
}

beforeAll(async () => {
  if (!HAVE) return;
  mkdirSync(TMPDIR, { recursive: true });
  const dir = join(TMPDIR, "s");
  home = join(TMPDIR, "home");
  project = join(TMPDIR, "ws", "orbit");
  const run = join(home, "Documents", "evidence", "bench-before-run1");
  mkdirSync(project, { recursive: true });
  mkdirSync(run, { recursive: true });
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main", project]);
  writeFileSync(join(project, "README.md"), "# orbit\n");
  /* Two files, and the one asked for is the SECOND: the first file of the
     folder is what came up when the wrong one was opened. */
  json = join(run, "results.json");
  md = join(run, "results.md");
  writeFileSync(json, '{"passed": 3, "failed": 1}\n');
  writeFileSync(md, "# Results\n\nRun one: 3 passed, 1 failed.\n");

  port = await freePort();
  server = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      LANG: process.env.LANG ?? "C.UTF-8",
      TMUX_TMPDIR: TMPDIR,
      AGENTGLASS_TMUX_SOCKET: SOCK,
      XDG_CONFIG_HOME: join(dir, "cfg"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_ROOT: join(TMPDIR, "ws"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      EDITOR: "nvim",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(server.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { server?.kill("SIGKILL"); } catch { /* already gone */ }
  if (HAVE) tmux("kill-server");
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing there */ }
});

const step = story();

describe.skipIf(!HAVE)("the bench reader runs nvim on the file asked for", () => {
  step("a reader session left as a plain shell is replaced by nvim on that exact file", async () => {
    /* The state the button met: the checkout's reader session exists, and it
       is a shell (started with no command). */
    tmux("new-session", "-d", "-s", READER, "-c", project);
    expect(reader()?.start).toBe("");

    const { ws, frame } = await openReader(md);
    expect(frame.t).toBe("ready");
    const pane = await until(reader, (p) => p?.current === "nvim");
    ws.close();

    expect(pane?.current).toBe("nvim");
    // The exact path, as the last argument: not the folder's first file.
    expect(pane?.start.endsWith(` ${md}`)).toBe(true);
    expect(pane?.start).not.toContain(json);
  }, 20_000);

  step("an editor already running is attached to, not restarted", async () => {
    const before = await until(reader, (p) => p?.current === "nvim");
    expect(before?.current).toBe("nvim");
    const { ws, frame } = await openReader(json);
    expect(frame.t).toBe("ready");
    await Bun.sleep(300);
    ws.close();
    // Same process: the buffers and the undo history of the running editor
    // are the reason the reader is one session.
    expect(reader()?.pid).toBe(before!.pid);
  }, 20_000);

  step("with nothing to open, it says so instead of leaving a shell", async () => {
    tmux("kill-session", "-t", `=${READER}`);
    const { ws, frame } = await openReader(join(home, "Documents", "evidence", "gone.md"));
    ws.close();
    expect(frame.t).toBe("fatal");
    expect(frame.error).toContain("gone.md");
    expect(reader()).toBeNull();
  }, 20_000);
});
