/*
 * The flags that stop a test's tmux from being the developer's tmux.
 *
 * `-L <name>` is not enough, and believing it was cost three hours of somebody
 * else's machine. It picks a socket; it says nothing about configuration. A
 * `tmux` invoked without `-f` reads `~/.tmux.conf` like any other, and a
 * developer's config is not inert: with tmux-continuum installed, a brand-new
 * server **restores their saved workspace into itself** the instant it starts.
 *
 * That is exactly what happened. A suite spawned a server on its own socket at
 * 09:48:40; one second later that server held the developer's editor and five
 * agent CLIs, relaunched with `--resume` by their restore hook. The suite then
 * killed its own session and exited, and the server stayed up for hours because
 * it now had somebody's work in it — which the "a machine with no panes"
 * assertions duly counted.
 *
 * `-f /dev/null` is the missing half: an empty configuration, so a server this
 * suite starts contains only what this suite puts in it. The pane engine has
 * always done this (`-f ensureConf()` in tmuxpane.ts); only the tests had not.
 *
 * Spread before `-L`, because tmux wants its options before the command.
 */
export const TMUX_ISOLATED = ["-f", "/dev/null"] as const;
