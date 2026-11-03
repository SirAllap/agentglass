/*
 * Whose command line still names a test's own temp directory, read from /proc.
 *
 * A test server starts two long-lived helpers, `udisksctl monitor` and
 * `gio mount -m`, through `setpriv --pdeathsig TERM` (volumes.ts → pdeathsig.ts).
 * That tie is the kernel's and it is Linux AND util-linux only: on a box without
 * the option the prefix is empty, and when the server is killed without running
 * its exit hook the stub it started is left with systemd as its parent.
 * Measured on one machine: 43 `/bin/sh /tmp/agx-volumes-<x>/bin/gio mount -m`
 * alive, the oldest 3.2 days, every one of them older than the tie.
 *
 * The directory is the identity. `mkdtempSync(join(tmpdir(), "agx-volumes-"))`
 * makes a path nothing else on the machine can name, so a process whose argv
 * carries it was started by this file's server and by nothing else — which is
 * the only reason a test may stop those pids and no others. Nothing here signals
 * anything on its own: reading is all this module does.
 */
import { readdirSync, readFileSync } from "node:fs";

/**
 * Pids whose argv names `dir`. `null` where `/proc` does not exist (macOS, and
 * the packaged targets): that is "cannot tell", not "none", so a caller skips
 * the check instead of passing on nothing.
 */
export function processesNaming(dir: string): number[] | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  const out: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      if (readFileSync(`/proc/${e}/cmdline`, "utf8").includes(dir)) out.push(Number(e));
    } catch { /* gone, or another user's: neither is ours to judge */ }
  }
  return out;
}

/**
 * SIGTERM, then SIGKILL after `graceMs`, every pid whose argv names `dir`, and
 * resolved with whoever is still there once the grace has run out — the caller
 * asserts on that list, which is what makes the check a guard and not a wish.
 * Only ever called with a directory the caller made. `null` where /proc is
 * absent, for the same reason as above.
 */
export async function stopNaming(dir: string, graceMs = 2000): Promise<number[] | null> {
  const first = processesNaming(dir);
  if (first === null) return null;
  const stop = (pids: number[], sig: NodeJS.Signals) => {
    for (const pid of pids) {
      // A pid this scan just read is ours by the argument above; the catch is
      // for the one that exited between the read and the signal.
      try { process.kill(pid, sig); } catch { /* gone */ }
    }
  };
  stop(first, "SIGTERM");
  const until = Date.now() + graceMs;
  let left = first;
  while (left.length && Date.now() < until) {
    await Bun.sleep(25);
    left = processesNaming(dir) ?? [];
  }
  if (left.length) {
    stop(left, "SIGKILL");
    const hard = Date.now() + 1000;
    while (left.length && Date.now() < hard) {
      await Bun.sleep(25);
      left = processesNaming(dir) ?? [];
    }
  }
  return left;
}

/**
 * The server a test spawned, gone before the next step. `kill()` only asks;
 * `afterAll` that removes the temp directory straight after was removing it from
 * under a server still shutting down, and a helper read from that directory
 * (`gio` writing into it) can then see a path that is not there.
 *
 * Resolved with whether it went, so a caller can say so rather than wait on a
 * process that ignored the signal.
 */
export async function stopServer(proc: { kill: () => void; exited: Promise<number> } | null, ms = 5000): Promise<boolean> {
  if (!proc) return true;
  try { proc.kill(); } catch { /* gone already */ }
  const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  return gone;
}
