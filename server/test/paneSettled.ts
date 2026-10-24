/*
 * A new pane's directory and command are set by tmux's CHILD, after the fork,
 * and the command that made the pane has already returned by then. Read
 * straight away, a pane forked a moment ago still reports the tmux server's own
 * directory (the test's cwd, `server`) and the tmux binary. On a fast machine
 * the window is too short to hit; on GitHub's 2-core runner it reddened four
 * suites in one run — the newest pane or two of a fixture, never the older
 * ones — and the CI replica, the same image and tmux, never hit it in 260
 * tries.
 *
 * So a test that reads a pane it just made waits for it, bounded, and then
 * asserts on what it got: a pane that never reaches the directory still fails,
 * with the value it had at the deadline.
 */
export async function settled<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 2000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() >= end) return v;
    await Bun.sleep(50);
  }
}
