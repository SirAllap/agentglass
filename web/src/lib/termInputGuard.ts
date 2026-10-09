/**
 * Keep a mouse report that was never a real one out of the shell.
 *
 * Measured in headless Chrome against the xterm this app ships: press inside a
 * terminal in mouse mode, take the terminal out of the document, release. The
 * press goes out as `ESC [ < 0 ; 3 ; 1 M` and the release as
 * `ESC [ < 0 ; NaN ; NaN m`. xterm reads the element's padding with
 * `parseInt(getComputedStyle(el).paddingLeft)`, and a detached element has no
 * computed style, so the answer is `NaN` and nothing downstream checks it.
 *
 * In the app that is a click on a link in the terminal that opens the card in
 * another view: the view switch takes the holder out of the document in the
 * middle of the click, the release lands on the detached terminal, and the
 * program that turned mouse tracking on cannot parse `NaN` — Claude Code echoes
 * the tail of it, `aN;NaNm`, into the prompt.
 *
 * A terminal that is not on screen has no pointer position to report, so while
 * it is hidden every mouse report is dropped, and so is any report that is not
 * three whole numbers from 1 up. A release that is dropped for being late is
 * answered with a clean one where the press was, so the program is not left
 * with a button it believes is still held.
 *
 * Whole-string match on purpose: xterm hands every report over as its own
 * string, so what is checked is exactly one report and typed or pasted text
 * that merely contains an escape is never touched.
 *
 * Covers SGR (1006), which Claude Code and tmux ask for, and urxvt (1015)
 * reports. The default encoding goes out through `onBinary`, which the panel
 * does not forward. Focus reports (`ESC [ I`, `ESC [ O`) and bracketed-paste
 * markers are fixed strings with no coordinates to get wrong, so they pass.
 */

const SGR = /^\x1b\[<(\d+);([^;]*);([^;mM]*)([mM])$/;
const URXVT = /^\x1b\[(\d+);([^;]*);([^;mM]*)M$/;
const WHOLE = /^[1-9]\d{0,4}$/;

/** A pointer position xterm could have computed: whole, 1 or more, five digits at most. */
const sane = (x: string, y: string) => WHOLE.test(x) && WHOLE.test(y);

export type TermInputGuard = {
  /** What to send for `d`, or "" for nothing. `shown` is whether the terminal is on screen. */
  filter(d: string, shown: boolean): string;
};

export function termInputGuard(): TermInputGuard {
  // The last press that went through with no release yet.
  let held: { b: number; x: string; y: string } | null = null;
  return {
    filter(d, shown) {
      if (d.charCodeAt(0) !== 0x1b || d.charCodeAt(1) !== 0x5b) return d;
      const sgr = SGR.exec(d);
      const m = sgr ?? URXVT.exec(d);
      if (!m) return d;
      const b = Number(m[1]);
      const x = m[2]!, y = m[3]!;
      if (shown && sane(x, y)) {
        if (sgr) {
          const motionOrWheel = (b & 32) !== 0 || (b & 64) !== 0;
          if (sgr[4] === "m") held = null;
          else if (!motionOrWheel) held = { b, x, y };
        }
        return d;
      }
      if (sgr && sgr[4] === "m" && held) {
        const h = held;
        held = null;
        return `\x1b[<${h.b};${h.x};${h.y}m`;
      }
      return "";
    },
  };
}

/** A grid worth telling the pty about: whole numbers, at least one cell. */
export const gridOk = (cols: number, rows: number) =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1;

/** On screen: attached, and with a box. `getClientRects` is empty for both a
 *  detached element and a `display: none` one. */
export const termShown = (el: Element | null | undefined) =>
  !!el && el.isConnected && el.getClientRects().length > 0;
