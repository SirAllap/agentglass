// Answer DECRQM ourselves, because xterm 6.0.0 throws trying to.
//
// `CSI ? Ps $ p` is how a program asks "do you support mode Ps?". Neovim asks
// four of them the moment it starts — 2026 (synchronized output), 2027, 2031,
// 2048 — and xterm 6.0.0's own handler dies on them with `ReferenceError: r is
// not defined`, thrown inside the escape-sequence parser. The parser is in the
// middle of a write when it happens, so the whole write dies with it and the
// editor never draws a character: a blank pane, nothing wrong in the network
// log, and a stack made entirely of minified library frames.
//
// It does not show up in the terminal panel because that one is usually running
// tmux, and tmux answers these itself instead of passing them through.
//
// Handled on the instance rather than fixed upstream: the only published
// versions with the fix are 6.1.0 betas, and a beta of the component the whole
// terminal is built on is a worse bet than these few lines. A handler that
// returns true replaces the built-in — which is what xterm's parser API is for
// — so the broken one never runs.

/** Terminal, narrowed to the two things this needs. */
type WithParser = {
  parser: {
    registerCsiHandler: (
      id: { prefix?: string; intermediates?: string; final: string },
      cb: (params: (number | number[])[]) => boolean,
    ) => { dispose(): void };
  };
  write(data: string): void;
};

/** DECRPM's "not recognised". Honest: we do not implement these modes, and a
 *  definite no is better for the program asking than a silence it has to time
 *  out on. */
const NOT_RECOGNISED = 0;

export function answerDecrqm(term: WithParser): { dispose(): void } {
  return term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, (params) => {
    const first = params[0];
    const mode = Array.isArray(first) ? first[0] : first;
    if (typeof mode === "number") term.write(`\x1b[?${mode};${NOT_RECOGNISED}$y`);
    return true;
  });
}
