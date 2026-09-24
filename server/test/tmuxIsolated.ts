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

/**
 * `new-session`, repeated until tmux has actually made it.
 *
 * A server ends when its last session does, and it finishes ending after the
 * client that killed it has returned. A `new-session` sent in that gap reaches
 * a server on its way out and fails — "server exited unexpectedly", or "no
 * server running" after `kill-server`. Measured with the raw CLI, a re-creation
 * straight after the kill failed 131 times in 300 after `kill-session` and 67
 * in 300 after `kill-server`. A suite that ends its session in one test and
 * makes it again in the next is in that gap every time, and whether it loses
 * depends on how busy the machine is: green alone, a different test red in each
 * full run. So the fixture does not assume its own setup worked.
 *
 * "duplicate session" on a retry is success: an earlier attempt the server may
 * have taken. On the first attempt it is not — the session was there before
 * this call, which means the last test's kill did not happen, and a fixture
 * that quietly reuses its windows and options fails later on an unrelated
 * assert. That throws, and so does anything else past `tries`, so a flag tmux
 * will never accept is an error and not a two-second wait.
 */
export function startSession(argv: string[], env: Record<string, string | undefined>, tries = 100): void {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = Bun.spawnSync(argv, { env, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode === 0) return;
    last = new TextDecoder().decode(r.stderr).trim();
    if (last.startsWith("duplicate session")) {
      if (i > 0) return;
      throw new Error(`${argv.join(" ")}: ${last} before the first attempt — left over from an earlier test`);
    }
    Bun.sleepSync(20);
  }
  throw new Error(`${argv.join(" ")} failed ${tries} times: ${last}`);
}
