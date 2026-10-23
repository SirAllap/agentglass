/*
 * ANOTHER ENGINE IN THE CHAIR.
 *
 * The seat is a TUI that is woken by a paste, so "who may sit there" is "whose
 * screen can this app read". The screens below were captured by hand from the
 * real TUIs in an isolated tmux (server/test/fixtures/screens/<engine>/) and
 * their content replaced by invented text; a rule about a screen is asserted
 * against a screen, not against what somebody remembers it saying.
 *
 * What is held here:
 *   - Claude's reading is unchanged, screen for screen, whichever way it is asked;
 *   - each engine with a facet classifies its idle, working and asking screens,
 *     and a screen it does not know (a banner in front of the box) is
 *     "starting", never "ready" — a wake into a modal is swallowed;
 *   - an engine with no captured screen is refused a chair, with a sentence;
 *   - a wake paste lands in a box that is not Claude's, and is taken.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-s9-${process.pid}`;
const SAVED = { sock: process.env.AGENTGLASS_TMUX_SOCKET, tmp: process.env.TMUX_TMPDIR };
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
/* The open project, so `seatable` lets a root through and the refusal under
   test is the one that is reached. */
const PROJECT = mkdtempSync(join(tmpdir(), "agx-s9-orbit-"));
const SAVED_ROOT = process.env.AGENTGLASS_ROOT;
process.env.AGENTGLASS_ROOT = PROJECT;

const AO = await import("../src/agentops.ts");
const Pane = await import("../src/chatpane.ts");
const Seat = await import("../src/seat.ts");
const { tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const { AGENT_PROVIDERS, agentProvider } = await import("../../shared/agentKinds.ts");

const fixture = (engine: string, name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", "screens", engine, `${name}.txt`), "utf8");

/* The screens Claude's reading was written against: one per state it names. */
const CLAUDE_SCREENS: Record<string, string> = {
  ready: ["╭──────────────────────────────╮", "❯ Try \"fix the failing test\"  │", "╰──────────────────────────────╯", "  ? for shortcuts"].join("\n"),
  working: "⏺ Reading files…\n  (esc to interrupt)\n\n❯ \n",
  permission: "Bash(rm -rf build)\n  Do you want to proceed?\n  ❯ 1. Yes\n  2. No\n  Esc to cancel\n",
  picker: "  Select model\n   Enter to confirm · Esc to cancel\n",
  queued: "⏺ Working…\n\n❯ Press up to edit queued messages\n  (esc to interrupt)\n",
  shell: "$ \n",
  typed: "❯ run the tests please\n",
};

describe("Claude's reading is the same however it is asked", () => {
  /* The golden was taken from main before the reader was moved onto the facet. */
  const GOLDEN: Record<string, string> = {
    ready: "ready", working: "working", permission: "needs-you", picker: "needs-you",
    queued: "working", shell: "starting", typed: "ready",
  };
  for (const [name, screen] of Object.entries(CLAUDE_SCREENS)) {
    test(`${name}: ${GOLDEN[name]}, with no kind and with "claude"`, () => {
      expect(AO.stateOfScreen(screen)).toBe(GOLDEN[name] as never);
      expect(AO.stateOfScreen(screen, "claude")).toBe(GOLDEN[name] as never);
    });
  }

  test("the box is read by the same function, so a paste is judged as before", () => {
    const r = Pane.screenReaderFor("claude")!;
    expect(r).not.toBeNull();
    for (const screen of Object.values(CLAUDE_SCREENS)) {
      expect(r.inputBox(screen)).toBe(Pane.inputBox(screen));
      expect(r.needsYou(screen)).toBe(Pane.screenNeedsYou(screen));
      expect(r.running(screen)).toBe(Pane.__running(screen));
      expect(r.queued(screen)).toBe(Pane.__isQueued(screen));
    }
  });

  test("its patterns are the facet's, not a second copy", () => {
    const s = agentProvider("claude")!.screen!;
    expect(Pane.screenNeedsYou("Esc to cancel")).toBe(new RegExp(s.needsYou).test("Esc to cancel"));
    expect(Pane.screenReaderFor("claude")!.needsYou("Yes, to use this session only")).toBe(true);
  });
});

describe("OpenCode's three screens, captured from the real TUI", () => {
  const state = (name: string) => AO.stateOfScreen(fixture("opencode", name), "opencode");

  test("an empty prompt is ready", () => {
    expect(state("idle")).toBe("ready");
    expect(state("idle-after-turn")).toBe("ready");
  });
  test("a custom agent named with a hyphen or a digit is still the mode line", () => {
    const screen = fixture("opencode", "idle").replace("Build · Big Pickle", "code-review2 · Big Pickle");
    expect(AO.stateOfScreen(screen, "opencode")).toBe("ready");
  });
  test("a turn running is working", () => expect(state("working")).toBe("working"));
  test("a permission prompt is needs-you", () => expect(state("asking")).toBe("needs-you"));
  test("an update banner in front of the box is starting, never ready", () => {
    /* The banner draws its own box and its own footer (`ctrl+p commands`), so
       a reading of "a box is on screen" calls it ready and a wake is typed into
       a dialog that swallows it. */
    expect(state("unknown-update")).toBe("starting");
  });
  test("a dialog the facet has never been shown is starting too: ready is a known screen, not the absence of a known dialog", () => {
    /* Different wording, the same box drawn over by buttons. The facet's
       `starting` list does not name it, and the box regex still matches. */
    expect(state("unknown-dialog")).toBe("starting");
    expect(Pane.screenReaderFor("opencode")!.blank!(fixture("opencode", "unknown-dialog"))).toBe(false);
    /* What somebody half typed is not an empty box either: a wake would be
       pasted onto their words. */
    expect(state("typed")).toBe("starting");
  });
  test("the same screens read as Claude's say nothing: they are not Claude's", () => {
    expect(AO.stateOfScreen(fixture("opencode", "idle"))).toBe("starting");
    expect(AO.stateOfScreen(fixture("opencode", "working"))).toBe("starting");
  });

  test("the box holds what was typed, a collapsed paste, or nothing", () => {
    const box = (name: string) => Pane.screenReaderFor("opencode")!.inputBox(fixture("opencode", name));
    expect(box("typed")).toBe("hello typed");
    expect(box("pasted")).toBe("[Pasted ~4 lines]");
    /* The placeholder is a hint, not a prompt somebody typed. */
    expect(box("idle")?.trim()).toBe("");
    expect(box("idle-after-turn")?.trim()).toBe("");
    expect(box("unknown-update")).toBeNull();
  });

  test("a submit is judged on this engine's box, not Claude's", () => {
    const r = Pane.screenReaderFor("opencode")!;
    expect(r.submitVerdict(fixture("opencode", "idle-after-turn"), "[Pasted ~4 lines]")).toBe("sent");
    expect(r.submitVerdict(fixture("opencode", "pasted"), "[Pasted ~4 lines]")).toBe("retry");
    expect(r.submitVerdict(fixture("opencode", "asking"), "x")).toBe("diverted");
  });
});

describe("an engine nobody has captured", () => {
  test("has no reader, and its screen is starting", () => {
    expect(Pane.screenReaderFor("codex")).toBeNull();
    expect(AO.stateOfScreen(fixture("codex", "unknown-signin"), "codex")).toBe("starting");
  });
  test("only engines with a captured idle, working and asking screen carry a facet", () => {
    expect(AGENT_PROVIDERS.filter((p) => p.screen).map((p) => p.id)).toEqual(["claude", "opencode"]);
  });
  test("the reader of a kind nobody knows is none", () => {
    expect(Pane.screenReaderFor("nope")).toBeNull();
  });
});

afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
  for (const [k, v] of [["AGENTGLASS_TMUX_SOCKET", SAVED.sock], ["TMUX_TMPDIR", SAVED.tmp], ["AGENTGLASS_ROOT", SAVED_ROOT]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("opening a chair with another engine", () => {
  test("is refused with a sentence when its screen has not been captured", async () => {
    const r = await Seat.openSeat({ root: PROJECT, kind: "codex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Codex cannot take the chair yet: agentglass has not captured its screen, so it could not tell when it is ready to be woken.");
  });
  test("is refused for an engine that has no tab at all", async () => {
    const r = await Seat.openSeat({ root: PROJECT, kind: "hermes" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Hermes cannot take the chair yet: it does not open in a terminal tab.");
  });
  test("is refused for a kind that is not an engine", async () => {
    const r = await Seat.openSeat({ root: PROJECT, kind: "nope" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not an agent engine");
  });
});

describe("what the chair is started with", () => {
  test("the model goes on the engine's own flag, and a Claude row's model is not carried over", () => {
    expect(Seat.seatModelArgs("claude", "claude-sonnet-5-5")).toEqual(["--model", "claude-sonnet-5-5"]);
    expect(Seat.seatModelArgs("opencode", "opencode/big-pickle")).toEqual(["--model", "opencode/big-pickle"]);
    expect(Seat.seatModelArgs("claude", "")).toEqual([]);
  });
  test("a chair's default model comes from its engine", () => {
    expect(Seat.seatDefaultModelFor("opencode")).toBe("opencode/big-pickle");
    expect(Seat.seatDefaultModelFor("claude")).toBe(Seat.defaultSeatModel());
  });
});

/* A TUI of the shape OpenCode's is: a box of `┃` rows over a mode line, a
   multi-line paste collapsed to a placeholder, Enter taking it. */
const FAKE_TUI = String.raw`#!/usr/bin/env python3
import sys, termios, tty, os
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
sys.stdout.write("\x1b[?2004h"); sys.stdout.flush()
box = ""; log = os.environ["FAKE_TUI_LOG"]; odd = os.environ.get("FAKE_TUI_ODD")
def draw():
    if odd:
        sys.stdout.write("\x1b[2J\x1b[H\r\n  Share this session?\r\n\r\n  ┃\r\n  ┃  Later          Publish\r\n  ┃\r\n  ┃  Build · Fake Model OpenCode Zen\r\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀\r\n   tab agents  ctrl+p commands\r\n"); sys.stdout.flush(); return
    sys.stdout.write("\x1b[2J\x1b[H\r\n  ┃\r\n  ┃" + ("  " + box if box else "") + "\r\n  ┃\r\n  ┃  Build · Fake Model OpenCode Zen\r\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀\r\n   tab agents  ctrl+p commands\r\n"); sys.stdout.flush()
draw(); buf = b""
try:
    while True:
        b = os.read(fd, 4096)
        if not b: break
        buf += b
        if odd: open(log, "a").write("RAW:" + repr(b) + "\n")
        if b"\x1b[200~" in buf and b"\x1b[201~" not in buf: continue
        if b"\x1b[201~" in buf:
            pre, rest = buf.split(b"\x1b[200~", 1); body, buf = rest.split(b"\x1b[201~", 1)
            t = body.decode().replace("\r", "\n"); n = t.count("\n") + 1
            box = t if n == 1 else "[Pasted ~%d lines]" % n
            open(log, "a").write("PASTE:" + t + "\n"); draw()
        if b"\r" in buf:
            buf = b""
            if box:
                open(log, "a").write("SUBMIT:" + box + "\n"); box = ""; draw()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

describe("the wake paste lands in a box that is not Claude's", () => {
  const have = tmuxCapability().available;
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-s9-")); });
  afterAll(async () => {
    if (have) await tmux(["kill-server"]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("a three-line wake is pasted, seen as a placeholder in the box, and submitted once", async () => {
    if (!have) return;
    const script = join(dir, "fake-tui.py");
    const log = join(dir, "log.txt");
    writeFileSync(script, FAKE_TUI, { mode: 0o755 });
    const r = await AO.startAgent({
      root: dir, name: "s9-fake", cwd: dir, kind: "opencode", exactArgv: ["env", `FAKE_TUI_LOG=${log}`, script],
      keep: true, yoloAllowed: false,
    });
    if (!r.ok) throw new Error(`did not start: ${r.error}`);
    const paneId = r.agent.paneId;
    expect((await AO.waitFor(paneId, ["ready"], 8_000, 100, "opencode")).state).toBe("ready");
    /* Read as Claude's, the same screen is never ready: this is what a seat of
       another engine did before the kind was threaded through. */
    expect(AO.stateOfScreen((await AO.screenOf(paneId))!)).toBe("starting");

    const text = "Wake: three things changed.\n- Orbit PR 12 is green\n- ORBIT-1042 is blocked";
    expect(await AO.promptAgent(paneId, text, 8_000, "opencode")).toBe("sent");
    const said = readFileSync(log, "utf8");
    expect(said).toContain("PASTE:" + text);
    expect(said.match(/SUBMIT:/g)?.length).toBe(1);
  }, 30_000);

  test("an escape that would end the paste early is not sent, so the text is one paste and one submit", async () => {
    if (!have) return;
    const script = join(dir, "fake-tui-esc.py");
    const log = join(dir, "log-esc.txt");
    writeFileSync(script, FAKE_TUI, { mode: 0o755 });
    const r = await AO.startAgent({
      root: dir, name: "s9-esc", cwd: dir, kind: "opencode", exactArgv: ["env", `FAKE_TUI_LOG=${log}`, script],
      keep: true, yoloAllowed: false,
    });
    if (!r.ok) throw new Error(`did not start: ${r.error}`);
    const paneId = r.agent.paneId;
    expect((await AO.waitFor(paneId, ["ready"], 8_000, 100, "opencode")).state).toBe("ready");
    expect(await AO.promptAgent(paneId, "Wake: one\x1b[201~\r!rm nothing", 8_000, "opencode")).toBe("sent");
    const said = readFileSync(log, "utf8");
    expect(said.match(/PASTE:/g)?.length).toBe(1);
    expect(said.match(/SUBMIT:/g)?.length).toBe(1);
    expect(said).not.toContain("\x1b");
    /* The whole text is inside the one paste; unstripped, the box held only
       what came before the escape and the rest was typed after it. */
    expect(said).toContain("PASTE:Wake: one[201~!rm nothing");
  }, 30_000);

  test("a dialog nobody captured gets no paste and no Enter, and the wake says stuck", async () => {
    if (!have) return;
    const script = join(dir, "fake-tui-odd.py");
    const log = join(dir, "log-odd.txt");
    writeFileSync(script, FAKE_TUI, { mode: 0o755 });
    writeFileSync(log, "");
    const r = await AO.startAgent({
      root: dir, name: "s9-odd", cwd: dir, kind: "opencode", exactArgv: ["env", `FAKE_TUI_LOG=${log}`, "FAKE_TUI_ODD=1", script],
      keep: true, yoloAllowed: false,
    });
    if (!r.ok) throw new Error(`did not start: ${r.error}`);
    const paneId = r.agent.paneId;
    for (let i = 0; i < 50 && AO.stateOfScreen((await AO.screenOf(paneId)) ?? "", "opencode") === "gone"; i++) await Bun.sleep(100);
    await Bun.sleep(400);
    expect(AO.stateOfScreen((await AO.screenOf(paneId))!, "opencode")).toBe("starting");
    expect(await AO.promptAgent(paneId, "Wake: one thing changed.", 3_000, "opencode")).toBe("stuck");
    await Bun.sleep(300);
    /* The TUI logs every byte it is sent in this mode: nothing was. */
    expect(readFileSync(log, "utf8")).toBe("");
  }, 30_000);
});
