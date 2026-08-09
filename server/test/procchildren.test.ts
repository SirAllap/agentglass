/*
 * Walking a process tree, on a machine that has /proc and on one that does not.
 *
 * This module exists because the walk it replaces opened with
 * `process.platform !== "linux"`, and that line was doing two jobs. For "should
 * the panel hide its own tab strip", answering no on a Mac is right. For "may I
 * send this pull request to an agent" — the same flag, read by a different
 * caller — it was a button that did nothing, on every Mac, with no message.
 *
 * The `ps` half is what could not be tested before and is most of what is here:
 * a Mac's `comm` is a full path with spaces in it, not a bare name, so the
 * parsing is where this would go wrong quietly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { parsePs, isTmuxComm, childrenOf, __setPsSnapshot } from "../src/procchildren.ts";

afterEach(() => { __setPsSnapshot(null); });

describe("reading a ps table", () => {
  it("indexes children by parent", () => {
    const { kids } = parsePs("  1     0 /sbin/launchd\n 42     1 /bin/zsh\n 77    42 /opt/homebrew/bin/tmux\n");
    expect(kids.get(1)).toEqual([42]);
    expect(kids.get(42)).toEqual([77]);
  });

  it("keeps a command with spaces in it whole", () => {
    // Splitting on whitespace would leave "/Applications/My" as the name.
    const { comm } = parsePs("100 1 /Applications/My App.app/Contents/MacOS/My App\n");
    expect(comm.get(100)).toBe("/Applications/My App.app/Contents/MacOS/My App");
  });

  it("ignores anything that is not a row", () => {
    // A header if one slips through, a blank line, a truncated line.
    const { kids, comm } = parsePs("  PID  PPID COMM\n\n   x   y   z\n 9 1 /bin/sh\n");
    expect(comm.get(9)).toBe("/bin/sh");
    expect(kids.get(1)).toEqual([9]);
    expect(comm.size).toBe(1);
  });

  it("does not let a process parent itself", () => {
    // Not a thing that happens, but this parses a table we do not own, and a
    // self-parent is an infinite walk.
    const { kids } = parsePs("5 5 /bin/sh\n");
    expect(kids.get(5)).toBeUndefined();
  });

  it("survives empty and rubbish input", () => {
    expect(parsePs("").kids.size).toBe(0);
    expect(parsePs("\n\n\n").comm.size).toBe(0);
  });
});

describe("what counts as tmux", () => {
  it("takes a bare name and a full path", () => {
    // Linux comm is bare; macOS ps gives the path it was executed from.
    expect(isTmuxComm("tmux")).toBe(true);
    expect(isTmuxComm("/opt/homebrew/bin/tmux")).toBe(true);
    expect(isTmuxComm("/usr/bin/tmux")).toBe(true);
  });

  it("takes tmux's own client and server names", () => {
    expect(isTmuxComm("tmux: client")).toBe(true);
    expect(isTmuxComm("tmux: server")).toBe(true);
  });

  it("is not fooled by something that merely starts with the word", () => {
    // The old test was `comm.startsWith("tmux")`, which these would pass.
    expect(isTmuxComm("tmuxinator")).toBe(false);
    expect(isTmuxComm("/usr/bin/tmuxp")).toBe(false);
    expect(isTmuxComm("")).toBe(false);
  });
});

describe("children of a pid", () => {
  it("reads this machine's own tree", () => {
    // Whatever the platform, the walk has to answer for a real pid without
    // throwing — that is the property the poll loop depends on.
    expect(Array.isArray(childrenOf(process.pid))).toBe(true);
  });

  it("answers empty for a pid that cannot be asked about", () => {
    // "Not found" and "could not look" lead to the same place on purpose: every
    // caller is hunting for something, and a throw in a poll would not.
    expect(childrenOf(0)).toEqual([]);
    expect(childrenOf(-1)).toEqual([]);
    expect(childrenOf(2 ** 31)).toEqual([]);
  });

  it("agrees with `ps` about a real process tree", async () => {
    /*
     * The cross-check this module is worth having.
     *
     * `parsePs` is the macOS path and cannot be exercised through `childrenOf`
     * on a Linux runner, so it would otherwise be tested only against strings
     * written by the same person who wrote the parser. Here it parses the
     * output of a real `ps` and has to reach the same answer /proc does, about
     * a tree made on purpose a moment earlier.
     *
     * `; true` matters: dash exec's a lone command, so `sh -c 'sleep 4'` leaves
     * no child at all and the test would pass by finding nothing twice.
     */
    const proc = Bun.spawn(["sh", "-c", "sleep 4; true"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(400);
      const viaProc = [...childrenOf(proc.pid)].sort();
      const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="], { stdout: "pipe" });
      const { kids, comm } = parsePs(new TextDecoder().decode(out.stdout));
      const viaPs = [...(kids.get(proc.pid) ?? [])].sort();

      expect(viaPs.length).toBe(1);
      expect(comm.get(viaPs[0]!) ?? "").toContain("sleep");
      // On Linux both are real answers and must match. Anywhere else
      // `childrenOf` IS the ps path, so this is the same list twice.
      expect(viaProc).toEqual(viaPs);
    } finally {
      proc.kill();
    }
  });
});
