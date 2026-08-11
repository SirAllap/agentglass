/*
 * Which shells get the tmux session the desk was last in — and which must not.
 *
 * Reported with two screenshots: the console docked under Docker's logs was
 * showing the tab selected in the terminal view, live, including the agent
 * running in it. Measured on the machine while it was happening:
 *
 *   tmux -S /tmp/tmux-1000/default list-clients
 *     /dev/pts/0  | session=orbit
 *     /dev/pts/14 | session=orbit
 *     /dev/pts/16 | session=orbit
 *
 *   ps: all three were `tmux -S … attach-session -t $6`, started by agentglass.
 *
 * Three clients on one session is one screen: tmux clients on a session share
 * its current window, so the console mirrored the terminal view — and anything
 * typed into the console would have gone to the pane the terminal was showing.
 * The console that pre-types an install command was on the same footing.
 *
 * The resume itself is right; it is what makes reopening the app land back in
 * the work. What was missing was a way for a caller to say "a shell in this
 * directory, and nothing clever".
 */
import { describe, expect, it } from "bun:test";
import { wantsDeskResume } from "../src/terminal.ts";

const nothing = { attach: false, agent: false, editor: false };

describe("resuming the session the desk was left in", () => {
  it("happens when nobody asked for anything else", () => {
    // The terminal view opening: no pane, no ticket, no file. "The session you
    // left running" beats a fresh prompt, and that is the whole feature.
    expect(wantsDeskResume({}, nothing)).toBe(true);
  });

  it("does not happen for a console that asked for a plain shell", () => {
    /* The bug. A docked console with no way to say so joined the desk's
       session as a second client. */
    expect(wantsDeskResume({ fresh: true }, nothing)).toBe(false);
  });

  it("still stands aside for a pane, an agent and a file", () => {
    // Each of these is somebody asking for a particular thing, and each of them
    // already won before `fresh` existed.
    expect(wantsDeskResume({ pane: "%58" }, nothing)).toBe(false);
    expect(wantsDeskResume({}, { ...nothing, attach: true })).toBe(false);
    expect(wantsDeskResume({}, { ...nothing, agent: true })).toBe(false);
    expect(wantsDeskResume({}, { ...nothing, editor: true })).toBe(false);
  });

  it("is opt-out, because the phone connects with a root and no pane", () => {
    /*
     * mobile/src/terminal/TerminalView.tsx sends `root` alone when it is not
     * opening a listed pane, and the desk's session is exactly what somebody
     * looking at their machine from a phone wants. Flipping the default would
     * have taken that away from a client that cannot be updated in step.
     */
    expect(wantsDeskResume({ root: "/home/me/code" } as { pane?: string; fresh?: boolean }, nothing)).toBe(true);
  });
});
