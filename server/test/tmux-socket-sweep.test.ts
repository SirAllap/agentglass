/*
 * The test socket directory does not grow without bound.
 *
 * `kill-server` does NOT remove the socket file — measured on tmux 3.6a, a
 * server started and killed cleanly leaves it behind exactly as a SIGKILLed one
 * does. So one fixed directory shared by every suite gains one file per run,
 * forever. It held 323 when somebody first counted, 297 of them from a single
 * test file, and `tmuxTmp.ts` said in writing that it "stays empty".
 *
 * The two conditions are the whole design, and each is tested on its own
 * because either alone deletes something it should not: age without liveness
 * takes a long-running server's socket, liveness without age races a suite
 * whose server is still booting and whose `list-sessions` therefore fails.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketDirUnder, sweepDeadSockets, TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const HOUR = 60 * 60_000;
const have = Boolean(Bun.which("tmux"));

/** A dead socket of a given age, made by starting a server and killing it —
 *  a real socket file, because `isSocket()` is half of what is under test. */
function deadSocket(dir: string, name: string, ageMs: number): string {
  const path = join(dir, name);
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", path, "new-session", "-d", "-s", "x"]);
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", path, "kill-server"]);
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
  return path;
}

describe("sweeping the test socket directory", () => {
  test("takes a stale socket whose server is gone", () => {
    if (!have) return;
    const dir = mkdtempSync(join(tmpdir(), "agx-sweep-"));
    try {
      deadSocket(dir, "old-and-dead", 3 * HOUR);
      const r = sweepDeadSockets(dir);
      expect(r.removed).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("but leaves a recent one alone, however dead it looks", () => {
    /* The race this guards: a second suite has just created its socket and its
       server may still be booting, which makes `list-sessions` fail on a server
       that is about to be perfectly fine. */
    if (!have) return;
    const dir = mkdtempSync(join(tmpdir(), "agx-sweep-"));
    try {
      deadSocket(dir, "young-and-dead", 5_000);
      expect(sweepDeadSockets(dir).removed).toBe(0);
      expect(readdirSync(dir)).toEqual(["young-and-dead"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("and leaves an old socket whose server is still running", () => {
    // Age alone is not death. A suite that takes hours keeps its server.
    if (!have) return;
    const dir = mkdtempSync(join(tmpdir(), "agx-sweep-"));
    const path = join(dir, "old-and-alive");
    try {
      Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", path, "new-session", "-d", "-s", "x"]);
      const when = new Date(Date.now() - 3 * HOUR);
      utimesSync(path, when, when);
      expect(sweepDeadSockets(dir).removed).toBe(0);
      expect(readdirSync(dir)).toEqual(["old-and-alive"]);
    } finally {
      Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", path, "kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never touches a file that is not a socket", () => {
    // The directory is tmux's, but a stray file in it is somebody's, and this
    // runs unattended at import.
    const dir = mkdtempSync(join(tmpdir(), "agx-sweep-"));
    try {
      const path = join(dir, "notes.txt");
      writeFileSync(path, "not a socket");
      const when = new Date(Date.now() - 3 * HOUR);
      utimesSync(path, when, when);
      expect(sweepDeadSockets(dir).removed).toBe(0);
      expect(readdirSync(dir)).toEqual(["notes.txt"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a missing directory is nothing to do, not a throw", () => {
    // It runs at import; a throw here takes down every suite that needs a tmux.
    expect(sweepDeadSockets(join(tmpdir(), "agx-sweep-does-not-exist"))).toEqual({ removed: 0, kept: 0 });
  });

  test("and it sweeps where tmux actually puts them, one level down", () => {
    /*
     * The silent failure this file exists to stop. tmux writes its sockets to
     * `$TMUX_TMPDIR/tmux-<uid>`, and the first draft swept the parent: it found
     * one entry, a directory, removed nothing, and returned a perfectly healthy
     * `{removed: 0}` — indistinguishable from a directory that was already
     * clean. Only counting the files on disk afterwards would have caught it.
     */
    expect(socketDirUnder(TMUX_TEST_TMPDIR)).toBe(`${TMUX_TEST_TMPDIR}/tmux-${process.getuid?.() ?? 0}`);
    expect(socketDirUnder("/x")).not.toBe("/x");
  });
});
