/*
 * Moving a phone's pane through its scrollback without typing into it.
 *
 * The defect this exists for was on the phone and its cause was the absence of
 * anything here: a finger was turned into wheel events and handed to xterm, and
 * xterm's answer to a wheel on the alternate screen with no scrollback of its
 * own is a CURSOR KEY. Measured through the shipped page against a real pane
 * running `cat -v`, one drag delivered 53 of them — arrows that walk history
 * onto a prompt, and that in an agent's TUI move whatever is selected,
 * including the two buttons on a permission gate.
 *
 * A terminal has no way to say "scroll" that is not a key or a mouse report.
 * tmux does, and this file is the whole of it: `copy-mode -e` plus
 * `send-keys -X … scroll-up`, on the pane the phone's own client is looking at.
 *
 * Everything runs against a real tmux on its own socket with `-f /dev/null`,
 * because every claim here is a claim about tmux's behaviour and a mock would
 * only be able to confirm what I already believed. Three of them were wrong
 * until they were measured — that `-N` takes a repeat count, that `copy-mode`
 * is idempotent, and that `-e` leaves the mode at the bottom of the history.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { leaveCopyMode, scrollPhonePane } from "../src/tmuxctl.ts";

/*
 * A server per test, on a socket of its own.
 *
 * This was one socket and a `kill-server` at the top of every `beforeEach`,
 * which is a race with itself: the old server is still shutting down while the
 * next `new-session` is already talking to it, and the session that command
 * creates dies with the server it landed on. The test that follows then finds a
 * pane with no history, or no pane at all.
 *
 * A new path per test cannot collide with a server that is on its way out, and
 * `-f /dev/null` keeps every one of them out of the user's own configuration.
 */
let seq = 0;
let sock = "";
let SOCKET: string[] = [];
const started: string[] = [];

const on = (where: string, args: string[]): string => {
  const r = Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", where, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
};
const tmux = (...args: string[]): string => on(sock, args);

/** The session name the server makes for a phone. The pattern is checked before
 *  anything is run, so a name of any other shape must do nothing at all. */
const PHONE = "agx-phone-1-abcdef";

const state = (): { inMode: boolean; at: number } => {
  const raw = tmux("display-message", "-p", "-t", "probe", "#{pane_in_mode}\t#{scroll_position}");
  const [mode, at] = raw.split("\t");
  return { inMode: mode === "1", at: Number(at || 0) };
};

/**
 * Wait for a fact about the pane, and say which one when it never arrives.
 *
 * Every claim in this file is a claim about scrollback, so the history has to
 * be THERE before a test starts — and how long a shell takes to print three
 * hundred lines is not something a number in the source can know.
 */
const until = (what: string, ready: () => boolean, ms = 10_000): void => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (ready()) return;
    Bun.sleepSync(25);
  }
  throw new Error(`the pane never ${what} within ${ms}ms`);
};

/*
 * What "the history is there" means, measured rather than assumed: 300 printed
 * lines on a 24-row pane leave 277 above the top, not 300 — the last screenful
 * is still on screen and is not scrollback. Asserting 300 here is a wait that
 * can never end, which is how this was found.
 */
const SCROLLBACK = 277;

/** How many lines are above the top of the pane — the scrollback itself. */
const history = (): number => Number(tmux("display-message", "-p", "-t", "probe", "#{history_size}") || 0);

beforeEach(() => {
  sock = `/tmp/agx-pscroll-${process.pid}-${++seq}.sock`;
  SOCKET = ["-f", "/dev/null", "-S", sock];
  started.push(sock);
  // Three hundred lines to scroll through, then a process that stays put so the
  // pane does not die under the test.
  tmux("new-session", "-d", "-s", "probe", "-x", "80", "-y", "24",
    "sh -c 'for i in $(seq 1 300); do echo LINE-$i; done; sleep 300'");
  /*
   * This was `Bun.sleepSync(500)`, and 500ms is a guess about somebody else's
   * machine. On a GitHub runner — the same run reported `event loop blocked
   * 6620ms` — the shell had not printed yet, so the pane had no scrollback,
   * `scrollPhonePane` correctly refused to open copy mode for a finger with
   * nothing to show, and the test that assumed it had gone back 40 lines read
   * `inMode: false`:
   *
   *     expect(scrollPhonePane(SOCKET, PHONE, 10)?.inMode).toBe(true)
   *     Expected: true / Received: false
   *
   * That is the code being right and the fixture being late. Waiting for the
   * history rather than for a period of time cannot be late, and cannot be
   * slow on a fast machine either: it leaves as soon as the lines are there.
   */
  until("printed its scrollback", () => history() >= SCROLLBACK);
  // The phone's own view of it: a grouped session, named the way the attach
  // names it. `display-message -t <session>` resolves to that session's current
  // window's active pane, which is what the phone is looking at.
  tmux("new-session", "-d", "-t", "probe", "-s", PHONE);
  // And the grouped session has to be answering before a test addresses it —
  // `scrollPhonePane` takes the phone's name, not the probe's.
  until("joined the group", () => tmux("display-message", "-p", "-t", PHONE, "#{pane_id}").startsWith("%"));
});

afterEach(() => { tmux("kill-server"); });
// Belt and braces: a test that threw in its own hook still leaves a server, and
// a stray tmux on this machine outlives the run that made it.
afterAll(() => { for (const s of started) on(s, ["kill-server"]); });

describe("a finger asking the machine to scroll", () => {
  it("enters copy mode and moves back by exactly the count it was given", () => {
    expect(state().inMode).toBe(false);
    const did = scrollPhonePane(SOCKET, PHONE, -20);
    expect(did?.entered).toBe(true);
    expect(state()).toEqual({ inMode: true, at: 20 });
  });

  it("keeps going without entering again", () => {
    scrollPhonePane(SOCKET, PHONE, -20);
    const more = scrollPhonePane(SOCKET, PHONE, -15);
    // `entered` is what the caller owes back, so a second request must not
    // claim a debt it did not create.
    expect(more?.entered).toBe(false);
    expect(state().at).toBe(35);
  });

  it("comes forward again, and leaves the mode at the bottom by itself", () => {
    scrollPhonePane(SOCKET, PHONE, -40);
    expect(scrollPhonePane(SOCKET, PHONE, 10)?.inMode).toBe(true);
    expect(state().at).toBe(30);
    // The `-e` on copy-mode. This is the ordinary end of a scroll — somebody
    // reads back and then comes down again — and it means the common case owes
    // nothing on the way out.
    const home = scrollPhonePane(SOCKET, PHONE, 500);
    expect(home?.inMode).toBe(false);
    expect(state().inMode).toBe(false);
  });

  it("does not open copy mode to answer a forward drag at the bottom", () => {
    // A finger travelling that way at the end of the history is not a request.
    // Entering copy mode for it would put the DESK's pane into copy mode — the
    // mode is a property of the shared pane — for a gesture with nothing to
    // show.
    const did = scrollPhonePane(SOCKET, PHONE, 25);
    expect(did).toEqual({ paneId: did!.paneId, entered: false, inMode: false });
    expect(state().inMode).toBe(false);
  });

  it("does nothing at all for a session that is not one of ours", () => {
    // The session name is the only thing addressing this, and it is ours: the
    // client sends a count and nothing else. A name of any other shape is how
    // this would become a way to reach somebody else's pane.
    expect(scrollPhonePane(SOCKET, "probe", -20)).toBe(null);
    expect(scrollPhonePane(SOCKET, "agx-phone-1-abcdef; kill-server", -20)).toBe(null);
    expect(state().inMode).toBe(false);
  });

  it("refuses a count that is not one", () => {
    expect(scrollPhonePane(SOCKET, PHONE, 0)).toBe(null);
    expect(scrollPhonePane(SOCKET, PHONE, Number.NaN)).toBe(null);
    expect(state().inMode).toBe(false);
  });
});

describe("handing copy mode back", () => {
  it("cancels the mode this phone opened", () => {
    const did = scrollPhonePane(SOCKET, PHONE, -20);
    expect(state().inMode).toBe(true);
    expect(leaveCopyMode(SOCKET, did!.paneId)).toBe(true);
    expect(state().inMode).toBe(false);
  });

  it("and says so rather than acting when the pane is not in one", () => {
    // The debt is only owed while the mode is on. Called on a pane somebody has
    // since left, this must not send `cancel` into whatever they are doing now.
    const pane = tmux("display-message", "-p", "-t", "probe", "#{pane_id}");
    expect(leaveCopyMode(SOCKET, pane)).toBe(false);
  });
});
