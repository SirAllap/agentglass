/*
 * What a run that never got to sweep leaves behind, taken away by the next one.
 *
 * tmpsweep.ts removes what its own process made, on the way out. A SIGKILL, an
 * out-of-memory kill or a machine that lost power has no way out: measured on
 * the machine this was written for, /tmp held 2,000+ `agx-test-*` directories
 * from runs that were stopped that way, and /tmp there is RAM. Three things
 * outlive such a run:
 *
 *   - the scratch directories `mkdtemp` named at random, which carry nothing
 *     that says whose they are. Each run keeps a manifest of them, one path per
 *     line, in a file named after its pid.
 *   - the directories and sockets the suites name after their own pid
 *     (`agx-tmux-tabs-<pid>`, `agx-wsize-<pid>.sock`), which need no manifest.
 *   - the tmux servers listening on sockets inside those, which keep running
 *     with nobody left to kill them: 19 of them, 29-73 hours old, when counted.
 *
 * The rule that keeps this from taking a live run's files is the pid: nothing is
 * touched unless its owner is dead. A name whose number is not a pid at all —
 * `mkdtemp` can happen to draw six digits — is spared by age as well, so a
 * directory younger than an hour is never reaped by name.
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

type Fs = {
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { mtimeMs: number; isSocket(): boolean };
  readFileSync: (p: string, e: "utf8") => string;
  appendFileSync: (p: string, d: string) => void;
  rmSync: (p: string, o: { recursive: true; force: true }) => void;
};
const fs = createRequire(import.meta.url)("node:fs") as Fs;

export const MANIFEST_PREFIX = "agx-sweep-manifest-";
const HOUR = 60 * 60_000;

export const manifestPath = (root: string, pid: number): string => join(root, `${MANIFEST_PREFIX}${pid}`);

/** Recorded before the directory is used, so a kill a moment later still finds it. */
export function record(root: string, pid: number, path: string): void {
  try { fs.appendFileSync(manifestPath(root, pid), path + "\n"); } catch { /* best-effort */ }
}

/**
 * The pid a suite stamped into a name: `agx-tmux-tabs-123`, `agx-wsize-123.sock`,
 * `agx-pscroll-123-3.sock`. Lazy, so the first number that lets the rest match wins.
 */
export function pidOf(name: string): number | null {
  const m = /^agx-.*?-(\d{1,8})(?:-\d+)?(?:\.sock)?$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** EPERM means it exists and is somebody else's: alive. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * `kill-server` on every tmux server whose socket is at or under `path`.
 *
 * Always `-S <socket>`, never a bare `kill-server`: the one without a socket is
 * the developer's own server. `TMUX` is dropped so tmux does not take the
 * socket of the session this runs in.
 */
export function killServersUnder(path: string): void {
  const sockets: string[] = [];
  const add = (p: string) => { try { if (fs.statSync(p).isSocket()) sockets.push(p); } catch { /* gone */ } };
  add(path);
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      add(p);
      if (depth > 0) walk(p, depth - 1);
    }
  };
  walk(path, 1);
  const { TMUX: _t, ...env } = process.env;
  for (const s of sockets) {
    try {
      Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", s, "kill-server"],
        { env, stdout: "ignore", stderr: "ignore", timeout: 5000 });
    } catch { /* no tmux, or it hung: the files still go */ }
  }
}

const remove = (p: string) => { killServersUnder(p); try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* not ours */ } };

export function reapDead(
  root: string,
  o: { alive?: (pid: number) => boolean; now?: number; minAgeMs?: number } = {},
): number {
  const alive = o.alive ?? isAlive;
  const now = o.now ?? Date.now();
  const minAgeMs = o.minAgeMs ?? HOUR;
  const base = resolve(root);
  let names: string[];
  try { names = fs.readdirSync(base); } catch { return 0; }
  let reaped = 0;
  for (const name of names) {
    if (name.startsWith(MANIFEST_PREFIX)) {
      const pid = Number(name.slice(MANIFEST_PREFIX.length));
      if (!Number.isInteger(pid) || alive(pid)) continue;
      const file = join(base, name);
      let lines: string[] = [];
      try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { /* unreadable: drop it */ }
      for (const p of lines) {
        if (p && resolve(p).startsWith(base + "/")) { remove(p); reaped++; }
      }
      remove(file);
      continue;
    }
    const pid = pidOf(name);
    if (pid === null || alive(pid)) continue;
    const p = join(base, name);
    try { if (now - fs.statSync(p).mtimeMs < minAgeMs) continue; } catch { continue; }
    remove(p);
    reaped++;
  }
  return reaped;
}
