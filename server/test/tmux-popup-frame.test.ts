/*
 * A popup is a second client, and the desk has to know it is there.
 *
 * Reported with six screenshots: with the scratch open over the terminal, the
 * four buttons this app draws on a pane went on being drawn — over the popup,
 * on a pane nobody can see, following a pointer that is no longer choosing
 * anything. Closing and reopening the scratch brought them straight back.
 *
 * The reason nothing noticed: `display-popup -E "tmux attach -t scratch"` does
 * not change the frame at all. Same windows, same panes, same geometry — tmux
 * paints the popup INTO the screen our client is already attached to. The only
 * thing that changes is that the server now has a second client, and a client
 * started inside tmux reports a tmux TERM. That is the signal, and it is asked
 * for on the call the sweep was already making.
 *
 * Against a real tmux, because the whole claim is about what `list-clients`
 * says while a popup is up.
 */
import { describe, expect, test } from "bun:test";
import { parseFrame, FRAME_ARGV } from "../src/tmuxctl.ts";

/** One client line, as the frame asks for it: tty, session, id, w, h, status,
 *  owned, TERM. */
const client = (tty: string, name: string, term: string) =>
  `c\t${tty}\t${name}\t$1\t200\t50\t\t\t${term}`;
const WINDOW = "w\t$1\t@1\t1\tfish\t1\t\t\t200\t50";
const PANE = "p\t$1\t@1\t1\t%1\t0\t0\t199\t49\t1\t0\t/dev/pts/1";
/** A pane of some OTHER session on the same server, with its own tty. */
const OTHER_PANE = "p\t$2\t@9\t1\t%9\t0\t0\t199\t49\t1\t0\t/dev/pts/9";

const frame = (...lines: string[]) => parseFrame(lines.join("\n"), "/dev/pts/1");

describe("what the frame says about a popup", () => {
  test("the desk alone is no popup", () => {
    const f = frame(client("/dev/pts/1", "orbit", "xterm-256color"), WINDOW, PANE);
    expect(f?.popup).toBe(false);
  });

  test("a second client started INSIDE tmux is one", () => {
    /* `tmux-256color` is what a client inside tmux reports — the same signal
       `outerClientTty` uses to refuse to mistake a nested client for the desk. */
    const f = frame(
      client("/dev/pts/1", "orbit", "xterm-256color"),
      client("/dev/pts/9", "scratch", "tmux-256color"),
      WINDOW, PANE,
    );
    expect(f?.popup).toBe(true);
  });

  test("but an attach typed INSIDE a pane is not", () => {
    /* Both are a second client with a tmux TERM, and only one of them is drawn
       over this terminal. A popup's pty belongs to no pane; an attach running
       in a pane has that pane's tty, and it covers nothing — it is a picture
       inside a rectangle we are already drawing on.

       Measured on his machine: an agent left `tmux attach -t scratch` running
       in a background session, and the pane bar was gone from every pane of an
       unrelated session for as long as it lived. */
    const f = frame(
      client("/dev/pts/1", "orbit", "xterm-256color"),
      client("/dev/pts/9", "scratch", "tmux-256color"),
      WINDOW, PANE, OTHER_PANE,
    );
    expect(f?.popup).toBe(false);
  });

  test("a phone is not", () => {
    /* A phone is also a second client and it covers nobody's screen: it
       attaches from a pty this server made, on a mirror session of its own. */
    const f = frame(
      client("/dev/pts/1", "orbit", "xterm-256color"),
      client("/dev/pts/9", "agx-phone-1-a1b2c3", "tmux-256color"),
      WINDOW, PANE,
    );
    expect(f?.popup).toBe(false);
  });

  test("and neither is our own client, whatever its TERM", () => {
    // The desk itself runs inside a tmux on some setups; it is still the desk.
    const f = frame(client("/dev/pts/1", "orbit", "tmux-256color"), WINDOW, PANE);
    expect(f?.popup).toBe(false);
  });

  test("the sweep asks for the TERM on the call it was already making", () => {
    // Not a second subprocess: this runs twice a second per attached shell.
    const i = FRAME_ARGV.indexOf("list-clients");
    expect(FRAME_ARGV[i + 2]).toContain("#{client_termname}");
  });
});
