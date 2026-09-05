/*
 * A prompt nobody can answer is caught because it is ON SCREEN, not because
 * the transcript went quiet.
 *
 * The run loop watches two things while a turn is in flight: the transcript
 * file, which is what the agent has actually said, and the pane, which is what
 * it is showing. The check for "this opened a picker only a person can answer"
 * used to be gated on the FIRST — the screen was only looked at once the
 * transcript had been still for `STALL_CHECK_MS`. Those are different
 * questions, and they come apart exactly where it costs most.
 *
 * Measured on an isolated server, the same permission prompt held on screen,
 * budget 60s:
 *
 *     transcript quiet     caught at 8.98s, named for what it was
 *     transcript growing   60.2s — the entire budget, which in a real run is
 *                          45 minutes, and the recorded outcome never mentions
 *                          a prompt at all
 *
 * Anything still writing while the prompt is up lands in the second row: a
 * subagent finishing its own work, a hook, a buffered flush arriving late. The
 * turn is equally stuck; only the telling is lost.
 *
 * Both halves are locked here, because the fix is only correct if it keeps
 * what the old gate was actually FOR — a picker's key hints scrolling past in
 * ordinary output must still not kill a healthy run. That is the second test,
 * and it is the one that fails if somebody makes the first one pass by simply
 * deleting the wait.
 *
 * Against a real tmux, on its own socket and TMUX_TMPDIR: a `-L` with the
 * developer's tmpdir lands on the developer's server, and this one types.
 *
 * RUN IN A CHILD, and that is not tidiness. `claudeCode.bin()` is
 * `Bun.which("claude")`, which reads the PATH the PROCESS started with —
 * assigning `process.env.PATH` in a `beforeAll` does not move it. The first
 * version of this file did exactly that and launched the REAL agent against a
 * throwaway directory, which answered "I don't have enough context to know what
 * the thing refers to" and cost a turn of somebody's quota to learn. So the
 * stub goes on the PATH of a child process, and this file reads its verdict.
 * `understudy-verdict-capture.test.ts` writes a child test the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

/* Nothing here mutates this process's own environment: everything the run needs
   is handed to the child's `env`, which is the only place it takes effect. */
const SOCKET = `agx-prompttalk-${process.pid}`;

/*
 * A stand-in for the agent CLI, written by the test rather than committed as a
 * fixture: it has to sit on PATH under the exact name `Bun.which("claude")`
 * looks for, and a file by that name in the repository is a file somebody's
 * shell finds one day.
 *
 * It draws only what the pane driver reads — `❯` as the input box, the box
 * holding the pasted brief, then the box emptied — and writes a transcript at
 * the path `transcriptFor` computes. `AGX_MODE` picks the shape under test.
 */
const STUB = String.raw`#!/usr/bin/env python3
import json, os, re, select, sys, termios, tty, time, pathlib
if "--help" in sys.argv:
    print("--session-id <uuid>\n--resume\n--model\n--effort"); sys.exit(0)
a = sys.argv[1:]
sid = a[a.index("--session-id") + 1] if "--session-id" in a else "x"
home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
tr = pathlib.Path(home) / "projects" / re.sub(r"[^A-Za-z0-9]", "-", os.getcwd()) / (sid + ".jsonl")
tr.parent.mkdir(parents=True, exist_ok=True)
mode = os.environ.get("AGX_MODE", "prompt")
PROMPT = "Do you want to allow this?\r\n  1. Yes, and to use this session only\r\n"
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
    # Nothing on screen until the brief is well and truly taken. submitConfirmed
    # re-presses Enter and re-reads the screen for up to a second after the box
    # empties, and it reads a prompt found there as the paste having been
    # DIVERTED -- a different failure from the one under test, and the one this
    # stub kept producing until it learned to wait.
    time.sleep(2.0)
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "starting"}]}})
    n = 0
    while True:
        time.sleep(0.2); n += 1
        # The transcript never stops growing, which is the whole point.
        emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "tick %d" % n}]}})
        if mode == "prompt":
            # Anchored, the way a real TUI holds a prompt while work continues.
            sys.stdout.write(PROMPT)
        elif mode == "passing-hint":
            # Said once and then GONE from the screen, which is what "scrolls
            # past" means to capture-pane. Clearing each tick rather than
            # printing filler: a pane is fifty lines tall, so pushing a line off
            # the top by hand would take fifty ticks and the test would be
            # measuring the scrollback instead of the guard.
            sys.stdout.write("\x1b[2J\x1b[H")
            if n == 2: sys.stdout.write(PROMPT)
        sys.stdout.write("tick %d\r\n" % n); sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

const CHILD = String.raw`
import { expect, test } from "bun:test";
import { runAgentInteractivePane } from "REPO/server/src/understudy-pane.ts";
import { tmux, tmuxCapability } from "REPO/server/src/tmuxpane.ts";

const have = tmuxCapability().available;
const run = (mode, budgetMs) => runAgentInteractivePane({
  cwd: "JAIL/repo", root: "JAIL/repo", label: "stub-" + mode,
  model: "sonnet", effort: "medium", prompt: "do the thing",
  env: { AGX_MODE: mode }, timeoutMs: budgetMs,
});
const ANSWERABLE = /interactive prompt only a person can answer/;

test("a prompt held on screen while the transcript keeps growing", async () => {
  if (!have) return;
  const t0 = Date.now();
  const r = await run("prompt", 20000);
  const took = Date.now() - t0;
  console.log("VERDICT " + JSON.stringify({ case: "prompt", took, named: ANSWERABLE.test(r?.out ?? "") }));
  expect(r?.out ?? "", "after " + took + "ms").toMatch(ANSWERABLE);
  // Well inside the budget: the bug was spending all of it. Loose enough not to
  // fail on a loaded machine — the claim is "not the deadline".
  expect(took).toBeLessThan(15000);
}, 40000);

test("a key hint that merely scrolls past does not kill a healthy run", async () => {
  if (!have) return;
  const r = await run("passing-hint", 4000);
  console.log("VERDICT " + JSON.stringify({ case: "hint", named: ANSWERABLE.test(r?.out ?? "") }));
  expect(r?.out ?? "").not.toMatch(ANSWERABLE);
  expect(r?.out ?? "").toContain("ran out of time");
}, 40000);

test.afterAll?.(async () => { if (have) await tmux(["kill-server"]); });
`;

let jail = "";
let out = "";
let code: number | null = null;
const have = Boolean(Bun.which("tmux"));

beforeAll(async () => {
  if (!have) return;
  jail = mkdtempSync(join(tmpdir(), "agx-prompttalk-"));
  mkdirSync(join(jail, "bin"), { recursive: true });
  mkdirSync(join(jail, "repo"), { recursive: true });
  writeFileSync(join(jail, "bin", "claude"), STUB);
  chmodSync(join(jail, "bin", "claude"), 0o755);

  const repo = join(import.meta.dir, "..", "..");
  writeFileSync(join(jail, "child.test.ts"),
    CHILD.replaceAll("REPO", repo).replaceAll("JAIL", jail));

  const child = Bun.spawn(["bun", "test", join(jail, "child.test.ts")], {
    cwd: jail,
    stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env,
      // The stub FIRST, in the environment the child process starts with.
      PATH: `${join(jail, "bin")}:${process.env.PATH ?? ""}`,
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      AGENTGLASS_CLAUDE_HOME: join(jail, "clone-claude"),
      // One second rather than eight: the behaviour under test is the SHAPE of
      // the wait, not its length, and a lock costing eight seconds a case is
      // one somebody eventually marks skip. Comfortably above the stub's 200ms
      // tick, so the passing hint is gone well before the second look.
      AGENTGLASS_PANE_STALL_CHECK_MS: "1000",
      // Never the outer tmux: this child opens windows.
      TMUX: "",
    },
  });
  out = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`;
  code = await child.exited;
// 90s, because this hook IS the work: the child drives two real panes and one
// of them deliberately runs to its own deadline. The default five seconds
// fails it before the first case finishes.
}, 90_000);

afterAll(() => {
  // The child kills its own server; this is the belt for a child that died
  // before its afterAll ran.
  if (have) Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCKET, "kill-server"],
    { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR } });
  if (jail) rmSync(jail, { recursive: true, force: true });
});

/** What the child measured, by case. */
const verdict = (name: string) => {
  const line = out.split("\n").find((l) => l.includes(`"case":"${name}"`) || l.includes(`"case": "${name}"`));
  return line ? JSON.parse(line.slice(line.indexOf("{"))) : null;
};

describe("a prompt on screen while the transcript is still growing", () => {
  it("ran the child against the stub, not the real agent", () => {
    // The failure this file was rewritten for looks like a pass otherwise: the
    // real CLI answers, the turn ends, and the assertions below are measuring
    // somebody's quota rather than the loop.
    if (!have) return;
    expect(out, out.slice(0, 300)).toContain("VERDICT");
    expect(out).not.toContain("I don't have enough context");
  });

  it("ends the turn early and says it was a prompt", () => {
    if (!have) return;
    const v = verdict("prompt");
    expect(v, out.slice(-800)).not.toBeNull();
    expect(v.named, `took ${v?.took}ms`).toBe(true);
    expect(v.took).toBeLessThan(15_000);
  });

  it("but a key hint that merely scrolls past does not kill a healthy run", () => {
    /* The half the old transcript gate was actually for, and the reason the fix
       waits rather than firing on the first sighting. Delete the wait to make
       the test above pass sooner and this one goes red: the run ends early,
       blaming a prompt that was one line of output. */
    if (!have) return;
    expect(verdict("hint")?.named, out.slice(-800)).toBe(false);
  });

  it("and the child suite itself passed", () => {
    if (!have) return;
    expect(code, out.slice(-1200)).toBe(0);
  });
});
