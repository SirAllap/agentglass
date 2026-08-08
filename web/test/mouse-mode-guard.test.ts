/*
 * Withholding the mouse-mode reset that kills a drag.
 *
 * Measured in the running app before any of this was written: counting the
 * mousemove listeners on `document` while the drag was a human's, the count was
 * 1 while reports were coming out and 0 from the last report to the end of the
 * gesture — 34 further pointer moves in one case, 32 in another, with the button
 * never released. xterm takes that listener off when mouse tracking is turned
 * off and does not put it back when it is turned on again.
 *
 * The risk in a filter that sits on a live byte stream is not that it fails to
 * fire; it is that it eats something it should not, and does so silently. So
 * most of what is pinned here is what must survive untouched: the encodings, a
 * change that carries a non-mouse mode with it, and a sequence unlucky enough to
 * be split across two chunks. What is withheld is replayed in the order the
 * shell wrote it, so the terminal ends the gesture in the mode the shell last
 * asked for.
 */
import { describe, expect, it } from "bun:test";
import { mouseModeGuard } from "../src/lib/mouseModeGuard.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const through = (g: ReturnType<typeof mouseModeGuard>, s: string) => dec(g.filter(enc(s)));

describe("mouseModeGuard", () => {
  it("withholds the reset that unbinds the drag, and passes the rest", () => {
    const g = mouseModeGuard();
    expect(through(g, "before\x1b[?1002lafter")).toBe("beforeafter");
    expect(dec(g.flush())).toBe("\x1b[?1002l");
  });

  it("freezes the tracking modes in BOTH directions", () => {
    // Withholding only the off was tried and measured, and it was not enough:
    // ?1000h on its own is click-only tracking — no drag bit — so xterm unbinds
    // on that too, before the ?1002h that would have restored it. Encodings
    // still go straight through.
    const g = mouseModeGuard();
    expect(through(g, "\x1b[?1002h\x1b[?1006h")).toBe("\x1b[?1006h");
    expect(dec(g.flush())).toBe("\x1b[?1002h");
  });

  it("leaves the encodings alone", () => {
    // Withholding `?1006l` would leave the terminal reporting in SGR at a shell
    // that had gone back to expecting the old encoding — a worse bug, and a
    // silent one.
    const g = mouseModeGuard();
    expect(through(g, "\x1b[?1006l\x1b[?1015l\x1b[?1016l")).toBe("\x1b[?1006l\x1b[?1015l\x1b[?1016l");
  });

  it("holds the whole set an agent's TUI emits, and nothing else", () => {
    // The exact bytes measured coming out of the app, in order.
    const g = mouseModeGuard();
    const blink = "\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[?1003h";
    expect(through(g, blink)).toBe("\x1b[?1006l\x1b[?1006h");
    // Replayed in the order the shell wrote them, so the mode the terminal ends
    // up in is the one the shell last asked for.
    expect(dec(g.flush())).toBe("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1000h\x1b[?1002h\x1b[?1003h");
  });

  it("passes a reset that carries a non-mouse mode with it", () => {
    // `\e[?25;1002l` hides the cursor as well. Dropping half of it would be
    // dropping something the shell asked for and nobody would connect the two.
    const g = mouseModeGuard();
    expect(through(g, "\x1b[?25;1002l")).toBe("\x1b[?25;1002l");
    expect(through(g, "\x1b[?25l")).toBe("\x1b[?25l");
  });

  it("holds a multi-mode reset when every mode in it is mouse tracking", () => {
    const g = mouseModeGuard();
    expect(through(g, "x\x1b[?1000;1002;1003ly")).toBe("xy");
    expect(dec(g.flush())).toBe("\x1b[?1000;1002;1003l");
  });

  it("survives a sequence split across two chunks", () => {
    // The shell writes bytes, not messages: the split lands wherever the pty
    // read happened to end.
    const g = mouseModeGuard();
    expect(through(g, "aaa\x1b[?10")).toBe("aaa");     // the tail is held back
    expect(through(g, "02lbbb")).toBe("bbb");
    expect(dec(g.flush())).toBe("\x1b[?1002l");
  });

  it("does not eat a split sequence that turns out to be innocent", () => {
    const g = mouseModeGuard();
    expect(through(g, "aaa\x1b[?2")).toBe("aaa");
    expect(through(g, "5hbbb")).toBe("\x1b[?25hbbb");   // the cursor, not the mouse
    expect(dec(g.flush())).toBe("");
  });

  it("gives back a half-read sequence on flush rather than swallowing it", () => {
    // The drag is over; a partial held any longer is a byte the shell wrote and
    // the terminal never sees.
    const g = mouseModeGuard();
    expect(through(g, "aaa\x1b[?10")).toBe("aaa");
    expect(dec(g.flush())).toBe("\x1b[?10");
  });

  it("empties itself, so the next drag starts clean", () => {
    const g = mouseModeGuard();
    through(g, "\x1b[?1002l");
    expect(dec(g.flush())).toBe("\x1b[?1002l");
    expect(dec(g.flush())).toBe("");
  });

  it("leaves ordinary output completely alone", () => {
    const g = mouseModeGuard();
    const noisy = "\x1b[31mred\x1b[0m \x1b[2J\x1b[H \x1b[?1049h ñ→é \x1b[6n";
    expect(through(g, noisy)).toBe(noisy);
    expect(dec(g.flush())).toBe("");
  });
});
