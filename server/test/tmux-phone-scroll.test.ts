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
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { leaveCopyMode, scrollPhonePane } from "../src/tmuxctl.ts";

const SOCK = `/tmp/agx-pscroll-${process.pid}.sock`;
/** The form tmuxctl takes: the socket flags on their own, with `tmux` and the
 *  command added around them. */
const SOCKET = ["-f", "/dev/null", "-S", SOCK];

const tmux = (...args: string[]): string => {
  const r = Bun.spawnSync(["tmux", ...SOCKET, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
};

/** The session name the server makes for a phone. The pattern is checked before
 *  anything is run, so a name of any other shape must do nothing at all. */
const PHONE = "agx-phone-1-abcdef";

const state = (): { inMode: boolean; at: number } => {
  const raw = tmux("display-message", "-p", "-t", "probe", "#{pane_in_mode}\t#{scroll_position}");
  const [mode, at] = raw.split("\t");
  return { inMode: mode === "1", at: Number(at || 0) };
};

beforeEach(() => {
  tmux("kill-server");
  // Three hundred lines to scroll through, then a process that stays put so the
  // pane does not die under the test.
  tmux("new-session", "-d", "-s", "probe", "-x", "80", "-y", "24",
    "sh -c 'for i in $(seq 1 300); do echo LINE-$i; done; sleep 300'");
  Bun.sleepSync(500);
  // The phone's own view of it: a grouped session, named the way the attach
  // names it. `display-message -t <session>` resolves to that session's current
  // window's active pane, which is what the phone is looking at.
  tmux("new-session", "-d", "-t", "probe", "-s", PHONE);
  Bun.sleepSync(300);
});

afterAll(() => { tmux("kill-server"); });

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
