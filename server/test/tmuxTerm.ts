/*
 * The TERM a test-made tmux client has to declare, and why it cannot inherit one.
 *
 * Four suites here fabricate a real terminal — a pty from `pty.fork()` sized
 * with TIOCSWINSZ, or one `script(1)` builds — because the claims they make are
 * about how tmux sizes a window to the client looking at it, and there is no
 * way to ask that of a mock. What they did NOT do is say what kind of terminal
 * it is: `TERM` came from whatever shell started `bun test`.
 *
 * On the machine these were written on that is `xterm-256color`, so they passed.
 * They had never run anywhere else — the integration branch was local — and the
 * first time CI saw them, 37 of them failed at once. Measured on ubuntu-latest,
 * where a job step has no terminal and `TERM=dumb`:
 *
 *   TERM=dumb            attach -> "open terminal failed: terminal does not
 *                                   support clear", exit 1, no client
 *   TERM=xterm           attach -> client 200x50, window 200x49
 *   TERM=xterm-256color  attach -> client 200x50, window 200x49
 *
 * tmux refuses `dumb` on purpose: a terminal with no `clear` capability cannot
 * be drawn on. So the client died on the spot, the fixture kept the size
 * `new-session -x 200 -y 50` gave it, and every assertion downstream read as a
 * logic failure. The three shapes it took, none of which named the cause:
 *
 *   - `geom` 200x50 where 200x49 was expected — the missing row is the status
 *     line, which only exists once a client is attached.
 *   - `attachArgvFor` and `readFrame` returning null — `listPanes` deliberately
 *     skips a server nobody is attached to, so no client means no panes.
 *   - `TypeError: null is not an object (evaluating 'built.argv')` — the same
 *     null, one line further on.
 *
 * A terminal emulator sets TERM. A test that builds its own pty is a terminal
 * emulator, so it sets TERM too, and it does so explicitly rather than
 * borrowing the developer's: that borrowing is the whole defect. Same rule as
 * `TMUX_ISOLATED` (do not read the developer's config) and `TMUX_TEST_TMPDIR`
 * (do not find the developer's sockets) — this one is: do not inherit the
 * developer's terminal.
 *
 * The convention already existed in this repository and only the server suites
 * missed it: `mobile/test/pane-line.test.ts` builds the same kind of pty client
 * and its python source opens with `os.environ["TERM"] = "xterm-256color"` and
 * `os.environ.pop("TMUX", None)`. So this is not a new rule being invented
 * after a red build — it is the rule that file was already following, written
 * down and made checkable. `tmux-test-isolation.test.ts` fails the build now if
 * a suite fabricates a client without one.
 *
 * `xterm-256color` rather than `xterm`: both work, and `infocmp` finds both on
 * ubuntu-latest (checked, along with `screen-256color`, `tmux-256color`, `ansi`
 * and `vt100` — all present in ncurses-base). The 256-colour entry is what a
 * real desk client reports, so the fixture matches the thing it stands in for.
 */
export const TEST_TERM = "xterm-256color";
