/*
 * THE QUIET AGENT IS STOPPED BEFORE THE BUDGET — and a working one is not.
 *
 * Measured before this: a live agent that printed once and then said nothing
 * ran to the task's whole budget (forty-five minutes); a dead one was noticed
 * in five seconds. Now the pane is read for CHANGE with the volatile parts
 * masked, and a pane that neither writes its transcript nor changes its screen
 * is warned at one threshold and stopped at another.
 *
 * Same shape as pane-prompt-while-talking.test.ts: a stub `claude` in a child
 * process's PATH, an isolated tmux, thresholds shrunk to seconds through the
 * environment. Three cases: quiet (stopped early, named), ticking (the
 * spinner's seconds change every frame — masked, so still quiet, stopped), and
 * working (the transcript keeps growing — never stopped for quiet).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { screenSignature } from "../src/understudy-pane.ts";

const SOCKET = `agx-quiet-${process.pid}`;
const have = !!Bun.which("tmux") && !!Bun.which("python3");

const STUB = String.raw`#!/usr/bin/env python3
import json, os, re, select, sys, termios, tty, time, pathlib
if "--help" in sys.argv:
    print("--session-id <uuid>\n--resume\n--model\n--effort"); sys.exit(0)
a = sys.argv[1:]
sid = a[a.index("--session-id") + 1] if "--session-id" in a else "x"
home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
tr = pathlib.Path(home) / "projects" / re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()) / (sid + ".jsonl")
tr.parent.mkdir(parents=True, exist_ok=True)
mode = os.environ.get("AGX_MODE", "quiet")
def emit(o):
    with tr.open("a") as f: f.write(json.dumps(o) + "\n")
def draw(box=""):
    sys.stdout.write("\x1b[2J\x1b[H[stub]\r\n\r\n❯" + box + "\r\n"); sys.stdout.flush()
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
try:
    draw()
    typed, sent = "", False
    while not sent:
        if not select.select([fd], [], [], 0.05)[0]: continue
        for c in os.read(fd, 4096).decode("utf-8", "replace"):
            if c in ("\r", "\n"):
                if typed.strip(): sent = True
            elif c != "\x1b": typed += c
        if typed.strip() and not sent: draw(typed[:80])
    draw()
    time.sleep(2.0)
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "starting"}]}})
    sys.stdout.write("I said one thing.\r\n"); sys.stdout.flush()
    n = 0
    while True:
        time.sleep(0.2); n += 1
        if mode == "working":
            emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "tick %d" % n}]}})
        elif mode == "ticking":
            # The spinner: a frame that changes every tick and means nothing.
            sys.stdout.write("\x1b[2J\x1b[H[stub]\r\nI said one thing.\r\n✳ Cooking for %ds · ↓ %d tokens · %s\r\n" % (n, n * 37, time.strftime("%H:%M:%S"))); sys.stdout.flush()
        # "quiet": nothing at all.
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

const CHILD = String.raw`
import { test } from "bun:test";
import { runAgentInteractivePane } from "REPO/server/src/understudy-pane.ts";
import { tmux, tmuxCapability } from "REPO/server/src/tmuxpane.ts";

const have = tmuxCapability().available;
const run = (mode, budgetMs) => runAgentInteractivePane({
  cwd: "JAIL/repo", root: "JAIL/repo", label: "stub-" + mode,
  model: "sonnet", effort: "medium", prompt: "do the thing",
  env: { AGX_MODE: mode }, timeoutMs: budgetMs,
  onQuiet: (ms) => console.log(JSON.stringify({ warned: mode, afterMs: ms })),
});

for (const mode of ["quiet", "ticking", "working"]) {
  test(mode, async () => {
    if (!have) return;
    const t0 = Date.now();
    const r = await run(mode, 30000);
    console.log(JSON.stringify({ case: mode, took: Date.now() - t0, ok: r?.ok, quietStopped: /went quiet/.test(r?.out ?? ""), tail: (r?.out ?? "").slice(-200) }));
  }, 60000);
}
test("kill the server", async () => { if (have) await tmux(["kill-server"]); });
`;

let jail = "", out = "", code = -1;

beforeAll(async () => {
  if (!have) return;
  jail = mkdtempSync(join(tmpdir(), "agx-quiet-"));
  mkdirSync(join(jail, "bin"), { recursive: true });
  mkdirSync(join(jail, "repo"), { recursive: true });
  writeFileSync(join(jail, "bin", "claude"), STUB);
  chmodSync(join(jail, "bin", "claude"), 0o755);
  const repo = join(import.meta.dir, "..", "..");
  writeFileSync(join(jail, "child.test.ts"), CHILD.replaceAll("REPO", repo).replaceAll("JAIL", jail));
  const child = Bun.spawn(["bun", "test", join(jail, "child.test.ts")], {
    cwd: jail, stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${join(jail, "bin")}:${process.env.PATH ?? ""}`,
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      AGENTGLASS_CLAUDE_HOME: join(jail, "clone-claude"),
      /* Seconds, not minutes: the behaviour under test is the SHAPE — warn,
         then stop, both well under the budget — not the length. */
      AGENTGLASS_PANE_QUIET_MS: "3000",
      AGENTGLASS_PANE_QUIET_STOP_MS: "6000",
      TMUX: "",
    },
  });
  out = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;
  code = await child.exited;
}, 180_000);

afterAll(() => {
  if (have) Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR } });
  if (jail) rmSync(jail, { recursive: true, force: true });
});

const verdict = (name: string) => {
  const line = out.split("\n").find((l) => l.includes(`"case":"${name}"`));
  return line ? JSON.parse(line.slice(line.indexOf("{"))) as { took: number; ok: boolean; quietStopped: boolean; tail: string } : null;
};
const warned = (name: string) => out.split("\n").some((l) => l.includes(`"warned":"${name}"`));

describe("the masked screen signature", () => {
  it("reads two frames of one situation as one, and new output as another", () => {
    const a = "⏺ Reading files…\n✻ Cooking for 12s · ↓ 1.2k tokens · 15:43:01\n/home/me/code/app/src/a.ts";
    const b = "⏺ Reading files…\n✻ Cooking for 13s · ↓ 1.3k tokens · 15:43:02\n/home/me/code/app/src/a.ts";
    expect(screenSignature(a)).toBe(screenSignature(b));
    expect(screenSignature(a + "\n⏺ Wrote the file")).not.toBe(screenSignature(a));
    expect(screenSignature("commit 9fd4bcbe done")).toBe(screenSignature("commit a04f3d95 done"));
  });
});

describe.skipIf(!have)("a live agent that goes quiet", () => {
  it("ran the child against the stub, not the real agent", () => {
    expect(out, out.slice(0, 400)).toContain('"case":"quiet"');
  });
  it("is warned first, then stopped, well before its budget — and the verdict names it", () => {
    const v = verdict("quiet");
    expect(v, out.slice(-1200)).not.toBeNull();
    expect(warned("quiet"), "the warning went out before the stop").toBe(true);
    expect(v!.quietStopped, v!.tail).toBe(true);
    expect(v!.ok).toBe(false);
    expect(v!.took, `took ${v!.took}ms of a 30000ms budget`).toBeLessThan(20_000);
  });
  it("a spinner that only ticks is still quiet: the seconds and counts are masked", () => {
    const v = verdict("ticking");
    expect(v, out.slice(-1200)).not.toBeNull();
    expect(v!.quietStopped, v!.tail).toBe(true);
    expect(v!.took).toBeLessThan(20_000);
  });
  it("but an agent whose transcript keeps growing is never stopped for quiet — it runs to its budget", () => {
    const v = verdict("working");
    expect(v, out.slice(-1200)).not.toBeNull();
    expect(v!.quietStopped, v!.tail).toBe(false);
    expect(warned("working")).toBe(false);
    expect(v!.took).toBeGreaterThan(25_000);
  });
  it("and the child suite itself passed", () => {
    expect(code, out.slice(-1500)).toBe(0);
  });
});
