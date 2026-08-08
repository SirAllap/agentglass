/*
 * The route behind "this pane" in the worktree menu.
 *
 * Driven against a real server and a real tmux window, because the half that
 * cannot be unit-tested is the wiring: a window id from the browser has to
 * become the pane the keyboard is going to, and that pane's process tree has to
 * become an answer. The judgement itself is in panewt.test.ts.
 *
 * The pane holds a copy of `sleep` renamed to one of the agent CLIs, which is
 * exactly what the /proc walk looks for: a process by that name, and the
 * directory it is standing in. Never a real `claude` — see pane-routes.test.ts
 * for what a test that starts one costs.
 *
 * Everything lives under one TMUX_TMPDIR, the server's included, so the socket
 * directory this reads holds one server: this one. Without that, "which tmux
 * has window @0" is answered by whichever of the developer's own servers is
 * listed first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { freePort } from "./freePort.ts";

let dir = "", base = "", socket = "", window = "", proc: ReturnType<typeof Bun.spawn> | null = null;

/** Decided here rather than in beforeAll: `skipIf` is read when the file is
 *  loaded, so a flag set later skips nothing and the tmux tests run on a
 *  machine with no tmux. */
const HAVE_TMUX = !!Bun.which("tmux") && existsSync("/proc");

/** A worktree of the scoped project, so the answer is one this cockpit is
 *  allowed to give. Set once the temp directory exists. */
let WT = "";
/** And one that belongs to somebody else's project entirely. */
const OUTSIDE = "/home/dev/code/other-WEB-9999";

const tmux = (...args: string[]) =>
  Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", socket, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMUX_TMPDIR: dir },
    stdout: "pipe", stderr: "pipe",
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-panedirs-"));
  WT = join(dir, "orbit-WEB-1042");
  socket = `agx-pd-${dir.slice(dir.lastIndexOf("-") + 1)}`;
  if (HAVE_TMUX) {
    // A process named after an agent CLI, standing in a known directory. The
    // name is the whole fixture: /proc/<pid>/comm is what the walk matches.
    const fake = join(dir, "codex");
    copyFileSync("/bin/sleep", fake);
    chmodSync(fake, 0o755);
    tmux("new-session", "-d", "-s", "t", "-c", dir, `${fake} 300`);
    window = new TextDecoder().decode(tmux("list-windows", "-F", "#{window_id}").stdout).trim().split("\n")[0] ?? "";
  }

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: socket,
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
  try { if (socket) tmux("kill-server"); } catch { /* never started one */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const get = async (path: string) => (await fetch(base + path)).json() as Promise<Record<string, any>>;

describe("/terminal/pane-dirs", () => {
  test("a window id that is not tmux's spelling never reaches a command", async () => {
    for (const w of ["", "; rm -rf /", "@1;kill-server", "%3", "$0"]) {
      expect(await get(`/terminal/pane-dirs?window=${encodeURIComponent(w)}`)).toEqual({ ok: true, pane: null, dirs: [] });
    }
  });

  test("a window this machine does not have answers nothing rather than erroring", async () => {
    expect(await get("/terminal/pane-dirs?window=@99999")).toEqual({ ok: true, pane: null, dirs: [] });
  });

  test.skipIf(!HAVE_TMUX)("names the pane the keyboard is going to", async () => {
    const r = await get(`/terminal/pane-dirs?window=${window}`);
    expect(r.ok).toBe(true);
    expect(r.pane).toMatch(/^%\d+$/);
  });

  test.skipIf(!HAVE_TMUX)("the agent's own directory, with no hook and no transcript", async () => {
    const r = await get(`/terminal/pane-dirs?window=${window}`);
    expect(r.dirs).toEqual([dir]);
  });

  test.skipIf(!HAVE_TMUX)("and the worktree it is reaching into, once a hook says which transcript is its", async () => {
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: `git -C ${OUTSIDE} log && git -C ${WT} status` } }] },
    }) + "\n");
    const pane = (await get(`/terminal/pane-dirs?window=${window}`)).pane as string;

    // Exactly what hooks/send_event.py posts from inside that pane.
    const posted = await fetch(base + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_app: "orbit",
        session_id: "11111111-2222-3333-4444-555555555555",
        hook_event_type: "PostToolUse",
        tmux_pane: pane,
        payload: { cwd: dir, transcript_path: transcript, tool_name: "Bash" },
      }),
    });
    expect(posted.ok).toBe(true);

    const r = await get(`/terminal/pane-dirs?window=${window}`);
    // The directory it stands in first, then the one it is actually working in
    // — which is the whole point, and is nowhere on that pane's screen.
    expect(r.dirs).toEqual([dir, WT]);
    // And nothing from outside the project this cockpit was opened for, even
    // though the agent named it in the same command.
    expect(r.dirs).not.toContain(OUTSIDE);
  });
});
