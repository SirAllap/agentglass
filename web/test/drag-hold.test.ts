/*
 * The latch that stops a refit landing on top of a drag.
 *
 * Reported as two bugs, and measured as one: with tmux's mouse mode on, both a
 * text selection and a divider drag live inside tmux, and both are dropped the
 * moment tmux's client changes size. A refit is exactly that change — it calls
 * `term.resize()`, which reaches the shell as a SIGWINCH. Measured against a
 * real tmux over a real pty, with the gesture sent as the SGR reports xterm
 * produces: a 30-column divider drag moves 30 columns untouched and 13 with one
 * resize dropped in at column 15; a 25-row selection holds all 25 rows
 * untouched and 11 with one resize dropped in at row 12.
 *
 * The properties below are the ones that decide whether the cure is worse than
 * the disease: the work must not be lost (it is owed, not cancelled), it must
 * not be replayed once per request (a drag asks for dozens of fits and there is
 * only ever one answer), and the latch must not be able to stick — a window
 * that loses focus mid-drag never sees the mouseup, and a latch left set would
 * hold every fit for the rest of the session.
 */
import { describe, expect, it } from "bun:test";
import { dragHold } from "../src/lib/dragHold.ts";

describe("dragHold", () => {
  it("runs work straight through when nothing is being dragged", () => {
    const ran: string[] = [];
    const h = dragHold<string>((x) => ran.push(x));
    expect(h.hold("a")).toBe(false);
    expect(h.active()).toBe(false);
    expect(ran).toEqual([]);
  });

  it("holds work while the button is down and owes it to the release", () => {
    const ran: string[] = [];
    const h = dragHold<string>((x) => ran.push(x));
    h.begin();
    expect(h.hold("a")).toBe(true);
    expect(ran).toEqual([]);       // nothing lands during the gesture
    h.end();
    expect(ran).toEqual(["a"]);    // and nothing is lost by the end of it
  });

  it("owes one replay per item however many times it was asked for", () => {
    // The case this is really about: a ResizeObserver firing on every frame of
    // a drag. Fifty fits asked for is one fit owed — replaying all fifty would
    // be fifty reflows of the scrollback for a size with a single answer.
    const ran: string[] = [];
    const h = dragHold<string>((x) => ran.push(x));
    h.begin();
    for (let i = 0; i < 50; i++) h.hold("a");
    h.hold("b");
    h.end();
    expect(ran.sort()).toEqual(["a", "b"]);
  });

  it("goes back to running work straight through after the release", () => {
    const ran: string[] = [];
    const h = dragHold<string>((x) => ran.push(x));
    h.begin();
    h.hold("a");
    h.end();
    expect(h.active()).toBe(false);
    expect(h.hold("b")).toBe(false);
    expect(ran).toEqual(["a"]);
  });

  it("ignores a release with no drag behind it", () => {
    // The release is listened for on the window, so it hears mouseups that had
    // nothing to do with a terminal.
    const ran: string[] = [];
    const h = dragHold<string>((x) => ran.push(x));
    h.end();
    h.end();
    expect(ran).toEqual([]);
    expect(h.active()).toBe(false);
  });

  it("keeps replaying the rest when one item throws", () => {
    // A terminal disposed while the button was down is exactly the case where
    // the others still need their fit.
    const ran: string[] = [];
    const h = dragHold<string>((x) => { if (x === "boom") throw new Error("disposed"); ran.push(x); });
    h.begin();
    h.hold("a"); h.hold("boom"); h.hold("b");
    expect(() => h.end()).not.toThrow();
    expect(ran.sort()).toEqual(["a", "b"]);
    expect(h.active()).toBe(false);
  });

  it("does not re-hold work that arrives during the replay", () => {
    // The replay calls the very function that asks to be held; if `end` cleared
    // the flag after running instead of before, a fit would re-hold itself and
    // never land.
    const ran: string[] = [];
    const h: ReturnType<typeof dragHold<string>> = dragHold<string>((x) => {
      expect(h.hold(x)).toBe(false);
      ran.push(x);
    });
    h.begin();
    h.hold("a");
    h.end();
    expect(ran).toEqual(["a"]);
  });
});
