/*
 * What this app can do to a tmux session it did not create, and the switch that
 * makes the answer "nothing".
 *
 * The differentiator and the danger are the same sentence: agentglass draws the
 * tab strip of the tmux server the USER started, so every window it can list is
 * a window it can also resize, rename, move, kill and rebind. This module's own
 * history is that sentence going wrong twice — a real session squeezed to 80x24
 * by an attach, and `resize-window -A` writing `window-size manual` across five
 * windows somebody was working in. `AGENTGLASS_TMUX_OBSERVE_ONLY=1` is the
 * answer to a stranger asking "what will this do to my tmux?": run it and it
 * does nothing at all.
 *
 * Against a real tmux server, on its own socket, with `-f /dev/null`. A mock
 * would only be able to confirm that the module called the mock politely, which
 * is not the claim — the claim is about the state of somebody's session after
 * the calls have been made, and only a session can answer that. `-f /dev/null`
 * is not decoration either: a tmux started without it reads the developer's
 * `~/.tmux.conf`, and a config with tmux-continuum in it restores their whole
 * workspace into this suite's server. That has happened here before.
 *
 * The control matters more than the assertion. Every "nothing changed" test can
 * pass by calling nothing at all, so each one runs the same sequence twice: once
 * with the switch off, where the session must come out visibly mangled, and once
 * with it on, where it must come out byte-identical.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

/* The eleven other tmux suites in here all carry this, and it is not optional:
 * every case below drives a real server, so on a machine without the binary
 * this file is not "failing", it has nothing to say. `describe.if` is the same
 * idiom test/tmux-bar.ts uses. */
const has = !!Bun.which("tmux");
import {
  runAction, setStatusLine, clearAsk, fitWindow, newWindowRunning, focusPane, selectPane,
  leaveCopyMode, reclaimPinnedWindow, restoreWindows, windowSize, paneCwd,
  deskAttachArgv, attachArgvFor, tmuxWriteCommands, suppressedTmuxWrites,
  forgetSuppressedTmuxWrites, FRAME_ARGV, type TmuxTarget,
} from "../src/tmuxctl.ts";

const SOCK = `/tmp/agx-observe-${process.pid}.sock`;
const SOCKET = ["-S", SOCK];
const T = ["tmux", "-f", "/dev/null", ...SOCKET];

/** The raw CLI, so the fixture is built by something other than the code under
 *  test — a session this app created would prove nothing about the one it did
 *  not. */
const cli = (...args: string[]) => {
  const r = Bun.spawnSync([...T, ...args]);
  return new TextDecoder().decode(r.stdout).trim();
};

/**
 * Everything on this server that any command in tmuxctl.ts could move.
 *
 * Window options and session options are dumped whole (`show-options -w`,
 * `show-options`) rather than named one at a time: the point is to catch a
 * write nobody thought to look for, and a list of the options I remembered
 * would only catch the ones I remembered. `list-keys` is in here because
 * `setStatusLine` rebinds two prefix keys, and a keybinding is the one kind of
 * damage that outlives the session it was done to.
 */
const snapshot = () => {
  const windows = cli("list-windows", "-a", "-F",
    "#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_width}x#{window_height}");
  const opts = windows.split("\n").filter(Boolean)
    .map((l) => `${l.split("\t")[1]}: ${cli("show-options", "-w", "-t", l.split("\t")[1]!)}`);
  return [
    windows,
    cli("list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_windows}"),
    cli("show-options", "-t", "stranger"),
    ...opts,
    cli("list-keys", "-T", "prefix"),
  ].join("\n---\n");
};

const sessionId = () => cli("display-message", "-p", "-t", "stranger", "#{session_id}");
const firstWindow = () => cli("display-message", "-p", "-t", "stranger:^", "#{window_id}");
const firstPane = () => cli("display-message", "-p", "-t", "stranger:^", "#{pane_id}");
const target = (): TmuxTarget => ({ pid: process.pid, socket: SOCKET, session: "stranger", id: sessionId() });

/**
 * Every mutation this module offers, aimed at the stranger's session.
 *
 * `kill` goes last so the control run still has a window for the earlier verbs
 * to land on. The three that take a socket rather than a target are called with
 * this socket explicitly — nothing here goes through `tmuxSockets()`, which
 * would discover socket directories that are none of this suite's business.
 */
const everyKnownWrite = (t: TmuxTarget, win: string, pane: string) => {
  runAction(t, "select", win);
  runAction(t, "new", undefined, undefined, undefined, undefined, undefined, "/tmp");
  runAction(t, "rename", win, "renamed-by-the-app");
  runAction(t, "move", win, "1", undefined, undefined, true);
  runAction(t, "fit", win, undefined, 80, 24);
  runAction(t, "takeover", win);
  setStatusLine(t, false);
  clearAsk(t, win);
  fitWindow(t.socket, t.id, win, 80, 24);
  newWindowRunning(t, "/tmp", "spawned-by-the-app", ["sleep", "300"]);
  focusPane(t.socket, t.id, win, pane);
  selectPane(t, pane);
  leaveCopyMode(t.socket, pane);
  reclaimPinnedWindow(t.socket, t.id, win, true);
  restoreWindows(t.socket, t.id, { [win]: "largest" });
  runAction(t, "kill", win);
};

/** The mode's stderr line is half of what it promises, so it is captured rather
 *  than left to scroll past — and capturing it also keeps a hundred of them out
 *  of the suite's output. */
let warned: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  cli("kill-server");
  // A session with two windows, made by the CLI and never by this app: the
  // thing a user already had open when they started agentglass.
  cli("new-session", "-d", "-s", "stranger", "-x", "200", "-y", "50", "sleep 300");
  cli("new-window", "-t", "stranger", "-n", "notes", "sleep 300");
  forgetSuppressedTmuxWrites();
  warned = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
});

afterEach(() => {
  console.warn = realWarn;
  delete process.env.AGENTGLASS_TMUX_OBSERVE_ONLY;
  cli("kill-server");
});

afterAll(() => { cli("kill-server"); });

describe.if(has)("what the app can do to a session it did not create", () => {
  it("mangles it, with the switch off — the control", () => {
    const before = snapshot();
    everyKnownWrite(target(), firstWindow(), firstPane());
    const after = snapshot();

    // Not merely "different": named, so this cannot pass because a window id
    // was reused or a clock ticked.
    expect(after).not.toBe(before);
    expect(before).toContain("notes");
    expect(after).toContain("spawned-by-the-app");
    // `setStatusLine` took the bar and the two prefix keys that go with it.
    expect(after).toContain("@agx-owned");
    expect(after).toContain("@agx-ask");
  });

  it("leaves it byte-identical, with the switch on", () => {
    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    const before = snapshot();
    everyKnownWrite(target(), firstWindow(), firstPane());

    expect(snapshot()).toBe(before);
  });

  it("still says what it would have done", () => {
    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    everyKnownWrite(target(), firstWindow(), firstPane());
    const verbs = new Set(suppressedTmuxWrites().map((c) => c[c.indexOf(SOCK) + 1]));

    // The commands this file's own bug history is made of, all of them recorded
    // as attempted. A run that recorded nothing would pass the test above by
    // doing nothing, which is the failure mode that test cannot see.
    for (const v of ["select-window", "new-window", "rename-window", "move-window",
      "resize-window", "set-option", "kill-window", "select-pane", "switch-client"]) {
      expect([...verbs]).toContain(v);
    }
    // And every one of them names the socket it was aimed at, because "would
    // have run kill-window" is a different sentence depending on whose server
    // that is.
    expect(suppressedTmuxWrites().every((c) => c.includes(SOCK))).toBe(true);
    expect(warned.some((l) => l.includes("observe-only") && l.includes(SOCK))).toBe(true);
  });

  it("keeps every read working", () => {
    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    // The two questions the panel asks constantly, both answered from the real
    // server. A mode that blinded the reads too would be indistinguishable from
    // the app being switched off, and would not be worth shipping.
    expect(windowSize(SOCKET, firstWindow())).toEqual({ cols: 200, rows: 50 });
    expect(paneCwd(SOCKET, firstPane())?.startsWith("/")).toBe(true);
    expect(suppressedTmuxWrites()).toEqual([]);
  });

  it("refuses the command lines it hands back to a shell", () => {
    // The second kind of write: an argv this module builds and something else
    // runs, so the guard inside `tmux()` never sees it. `attach-session` is
    // what resized a real session to 80x24 in the first place.
    expect(deskAttachArgv(SOCK, "stranger")).toEqual(["tmux", ...SOCKET, "attach-session", "-t", sessionId()]);

    process.env.AGENTGLASS_TMUX_OBSERVE_ONLY = "1";
    expect(deskAttachArgv(SOCK, "stranger")).toBeNull();
    expect(attachArgvFor(SOCKET, "%0")).toBeNull();
    // Recorded as the session and the pane that were asked for, not as a
    // resolved id: nothing was asked of the server, so there is no id to
    // resolve — which is the whole of what "no writes" costs here.
    expect(suppressedTmuxWrites()).toContainEqual(["tmux", ...SOCKET, "attach-session", "-t", "stranger"]);
    expect(suppressedTmuxWrites().map((c) => c[c.length - 1])).toContain("%0");
  });
});

/* Unguarded on purpose: this suite only exercises `tmuxWriteCommands`, which is
 * string parsing and never launches anything. */
describe("what counts as a write", () => {
  it("lets the whole frame through", () => {
    // The sweep's command list runs twice a second per attached client. If one
    // line of it were classified as a write the tab strip would empty in
    // observe-only mode, and the mode would look broken rather than careful.
    expect(tmuxWriteCommands(FRAME_ARGV)).toEqual([]);
  });

  it("splits a command list and judges each command on its own", () => {
    expect(tmuxWriteCommands(["show-options", "-gv", "prefix", ";", "kill-session", "-t", "=x"]))
      .toEqual([["kill-session", "-t", "=x"]]);
  });

  it("reads `display-message -p` and writes `display-message`", () => {
    // Same command, opposite blast radius: with `-p` it prints to our stdout,
    // without it it paints over the top line of somebody's shell.
    expect(tmuxWriteCommands(["display-message", "-p", "-t", "@1", "#{window_width}"])).toEqual([]);
    expect(tmuxWriteCommands(["display-message", "deploying"])).toEqual([["display-message", "deploying"]]);
  });

  it("calls a verb it has never heard of a write", () => {
    // Fails closed on purpose. tmux has a hundred commands and this file uses
    // nine; the ones it does not know about are the ones a future change will
    // reach for.
    expect(tmuxWriteCommands(["respawn-pane", "-k", "-t", "%3"])).toEqual([["respawn-pane", "-k", "-t", "%3"]]);
  });
});
