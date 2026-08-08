/**
 * Keep the mouse mode from being switched off underneath a drag.
 *
 * xterm reports a drag from a `mousemove` listener it puts on `document` when
 * the button goes down, and it takes that listener off again the moment the
 * shell turns mouse tracking off. Turning it back on does not put the listener
 * back — xterm only reassigns its handler, and the `addEventListener` lives in
 * the mousedown path — so a mode that goes off and on again mid-gesture leaves
 * a terminal that is in mouse mode, has the button held, and reports nothing
 * until you let go and grab again.
 *
 * That is not a hypothesis. Measured in the running app over CDP, counting the
 * mousemove listeners on `document` while the drag was a human's: while reports
 * were coming out the count was 1, and from the last report to the end of the
 * gesture it was 0 — 34 more pointer moves in one case, 32 in another, with the
 * button never released. tmux re-synchronises its own mouse mode against the
 * focused pane's, so an agent's TUI redrawing is enough to produce the off/on.
 *
 * So while a drag is in flight the tracking modes are frozen: every change to
 * them is withheld, xterm's view of the protocol never moves, it never unbinds,
 * and the gesture runs to the end. What was withheld is written to the terminal
 * when the button comes up, in order, so a shell that really did change the
 * mode gets its change a gesture later rather than never.
 *
 * Withholding only the resets was tried first and was not enough: the set
 * arrives as ?1000l ?1002l ?1003l then ?1000h ?1002h ?1003h, and ?1000h alone
 * is click-only tracking — no drag bit — so xterm unbinds on the way back up,
 * before the ?1002h that would have restored it. Measured in the app with the
 * partial fix installed: 42 pointer moves, 5 reports, 36 of them orphaned.
 *
 * Bytes rather than text on purpose. These chunks are whatever a program
 * printed; decoding them to filter and re-encoding would corrupt a multi-byte
 * character split across two chunks, and this runs on every chunk of a live
 * terminal.
 */

const ESC = 0x1b, BRACKET = 0x5b, QUESTION = 0x3f, SEMI = 0x3b, LOW_L = 0x6c, LOW_H = 0x68;
const ZERO = 0x30, NINE = 0x39;

/**
 * The modes worth withholding: the ones that carry mouse *tracking*. 1000 is
 * click tracking, 1002 click-and-drag, 1003 any movement, 1001 the highlight
 * variant nobody uses but which xterm still counts.
 *
 * Deliberately not the encodings (1006 SGR, 1005, 1015, 1016). Turning an
 * encoding off does not unbind anything, and withholding one would leave the
 * terminal reporting in a format the shell has stopped expecting — a worse bug
 * than the one being fixed, and a silent one.
 */
const TRACKING = new Set([1000, 1001, 1002, 1003]);

export type MouseModeGuard = {
  /** Filter one chunk on its way to the terminal. Returns what to write. */
  filter(chunk: Uint8Array): Uint8Array;
  /** Everything withheld, to write once the drag is over. Empties itself. */
  flush(): Uint8Array;
};

export function mouseModeGuard(): MouseModeGuard {
  // A sequence can be split across two chunks — the shell writes bytes, not
  // messages. What looks like the start of one is held back rather than passed
  // through and matched too late.
  let partial: number[] = [];
  let withheld: number[] = [];

  /** Does `bytes` starting at `i` spell a private-mode reset we should hold?
   *  Returns the length of the sequence, 0 for "not one", -1 for "cannot tell
   *  yet, the chunk ends inside it". */
  const match = (bytes: number[], i: number): number => {
    if (bytes[i] !== ESC) return 0;
    if (i + 1 >= bytes.length) return -1;
    if (bytes[i + 1] !== BRACKET) return 0;
    if (i + 2 >= bytes.length) return -1;
    if (bytes[i + 2] !== QUESTION) return 0;
    let j = i + 3;
    const nums: number[] = [];
    let cur = -1;
    for (; j < bytes.length; j++) {
      const b = bytes[j];
      if (b >= ZERO && b <= NINE) { cur = (cur < 0 ? 0 : cur) * 10 + (b - ZERO); continue; }
      if (b === SEMI) { nums.push(cur); cur = -1; continue; }
      break;
    }
    if (j >= bytes.length) return -1;          // the digits run off the end
    // Both `l` and `h`. Withholding only the off was not enough, and the
    // measurement says why: the set arrives as ?1000l ?1002l ?1003l then
    // ?1000h ?1002h ?1003h, and the moment ?1000h lands the protocol is
    // click-only — no drag bit — so xterm unbinds there, before the ?1002h
    // that would have restored it. Every step of the walk has to be withheld,
    // not just the ones that spell "off".
    if (bytes[j] !== LOW_L && bytes[j] !== LOW_H) return 0;
    nums.push(cur);
    // A reset can carry several modes at once; hold it only if every one of
    // them is a tracking mode, so `\e[?25;1002l` (cursor + mouse) still gets
    // through rather than having its cursor half silently dropped.
    return nums.length && nums.every((n) => TRACKING.has(n)) ? j - i + 1 : 0;
  };

  return {
    filter(chunk: Uint8Array): Uint8Array {
      const bytes = partial.length ? partial.concat(Array.from(chunk)) : Array.from(chunk);
      partial = [];
      const out: number[] = [];
      for (let i = 0; i < bytes.length; ) {
        const n = match(bytes, i);
        if (n === -1) { partial = bytes.slice(i); break; }   // finish it next chunk
        if (n > 0) { withheld.push(...bytes.slice(i, i + n)); i += n; continue; }
        out.push(bytes[i]!);
        i++;
      }
      return Uint8Array.from(out);
    },
    flush(): Uint8Array {
      // The held-back resets, plus anything still half-read: the drag is over,
      // and a partial sequence sat on any longer is a byte the shell wrote and
      // the terminal never saw.
      const all = withheld.concat(partial);
      withheld = [];
      partial = [];
      return Uint8Array.from(all);
    },
  };
}
