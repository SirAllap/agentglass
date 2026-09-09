/**
 * Stopping a turn has to reach the whole job tree, on every platform.
 *
 * `claude`, `codex` and `agy` all spawn work of their own — a test run, a dev
 * server, a build — and the promise the Stop button makes is that pressing it
 * ends the job, not just the CLI that launched it. On POSIX that is what the
 * `setsid` prefix at each spawn site buys: the child leads its own process
 * group, so one signal to `-pid` reaches everything it started.
 *
 * `setsid` does not exist on Windows, and the fallback there killed only the
 * direct child (#195). Everything below it survived, still holding the CPU, the
 * port, or the lock — and nothing on screen said so, because the CLI it was
 * launched by had gone. `taskkill /T` is the equivalent that does exist:
 * `/T` walks the tree, `/F` does not ask twice.
 *
 * One place rather than three, because it was written three times — chat.ts,
 * codex.ts, antigravity.ts, each with the same comment about the group and the
 * same Windows hole underneath it.
 */

export interface Stoppable {
  readonly pid: number;
  kill(): void;
}

/** Injected in tests so the Windows branch can be asserted from any host. */
export type Runner = (cmd: string[]) => { exitCode: number | null };

const defaultRunner: Runner = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
  return { exitCode: r.exitCode };
};

/**
 * End a spawned turn and everything it started.
 *
 * `grouped` is whether the process was launched under `setsid` — the caller
 * knows, because it is the one that decided. A process that is not grouped can
 * only be killed directly, which is the honest limit of that spawn rather than
 * something to paper over here.
 *
 * Best-effort by design: a tree that has already exited is the normal case at
 * every one of these call sites, and a stop that throws because the job it was
 * stopping had finished would turn a success into an error.
 */
export function stopTree(
  proc: Stoppable,
  grouped: boolean,
  platform: string = process.platform,
  run: Runner = defaultRunner,
): void {
  if (platform === "win32") {
    // The direct kill first, so a missing taskkill (Windows Nano, a stripped
    // container image) still stops the CLI itself rather than nothing at all.
    try { proc.kill(); } catch { /* already gone */ }
    try { run(["taskkill", "/T", "/F", "/PID", String(proc.pid)]); } catch { /* no taskkill; the direct kill above stands */ }
    return;
  }
  try {
    if (grouped) process.kill(-proc.pid, "SIGTERM"); // the group, not just the CLI
    else proc.kill();
  } catch { /* gone */ }
}
