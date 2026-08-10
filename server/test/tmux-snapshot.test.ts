/*
 * The safety copy of the user's last good resurrect save.
 *
 * Written after losing one. resurrect keeps every save and a `last` symlink at
 * the newest; continuum saves on a timer. A save fired while the tmux server
 * was being killed and wrote a file with ONE pane in it, `last` moved to that,
 * and the save from ten minutes earlier — five sessions, nine panes, a running
 * agent — was still on disk and no longer reachable by anything that restores:
 *
 *   19:53:17   1356 bytes   9 panes    <- the work
 *   20:03:10    166 bytes   1 pane     <- `last` now points here
 *
 * resurrect has no notion of "poorer", and agentglass must not race its timer.
 * So it keeps a copy where nothing else writes, and puts `last` back only when
 * it can prove the current one is a clobber.
 *
 * Every path here is under a scratch HOME. The module refuses the real
 * directories under NODE_ENV=test outright — this suite must never be able to
 * read, copy or repoint the developer's own resurrect saves.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestSnapshot, clobbered, KEEP, panesIn, readLast, repairLast, resurrectDir, snapshot, snapshotDir, snapshots,
} from "../src/tmuxsnapshot.ts";

let home = "";

/** A resurrect save with `n` panes in it, in the shape resurrect writes. */
const save = (n: number, session = "workbench"): string => {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`pane\t${session}\t${i}\t1\t:*\t1\ttitle\t:/home/x\t1\tbash\t:`);
  }
  lines.push(`window\t${session}\t1\t:bash\t1\t:*\tc920,205x47,0,0,3\t:`);
  lines.push(`state\t${session}\t`);
  return lines.join("\n") + "\n";
};

/** Write a save into the resurrect directory and point `last` at it. */
const put = (name: string, text: string, asLast = true): string => {
  const dir = resurrectDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  if (asLast) {
    const link = join(dir, "last");
    rmSync(link, { force: true });
    symlinkSync(name, link);
  }
  return path;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agx-snap-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("what a save is worth", () => {
  it("counts panes, not bytes", () => {
    /*
     * `@resurrect-capture-pane-contents` makes the file size depend on how much
     * scrollback happened to be on screen, so a save of an empty server after a
     * busy one can be the LARGER file and still hold nothing. The pane lines
     * are the thing being lost.
     */
    expect(panesIn(save(9))).toBe(9);
    expect(panesIn(save(1))).toBe(1);
    expect(panesIn("state\tx\t\n")).toBe(0);
  });
});

describe("taking a copy", () => {
  it("copies the good save into our own directory", () => {
    put("tmux_resurrect_20260810T195317.txt", save(9));
    const to = snapshot();
    expect(to).toContain(join(".config", "agentglass", "resurrect"));
    expect(panesIn(readFileSync(to!, "utf8"))).toBe(9);
  });

  it("never copies a one-pane save, which is the clobber's own shape", () => {
    // A real session has more than one pane. A single-pane save is a server
    // being born or dying, and keeping it would poison the safety net.
    put("tmux_resurrect_20260810T200310.txt", save(1));
    expect(snapshot()).toBe(null);
    expect(snapshots()).toHaveLength(0);
  });

  it("does not copy the same save twice", () => {
    put("tmux_resurrect_20260810T195317.txt", save(9));
    expect(snapshot()).toBeTruthy();
    expect(snapshot()).toBe(null); // the timer ticks; nothing new happened
    expect(snapshots()).toHaveLength(1);
  });

  it("keeps a bounded number of them, oldest dropped first", () => {
    for (let i = 1; i <= KEEP + 3; i++) {
      put(`tmux_resurrect_2026081${i}T000000.txt`, save(2 + i));
      snapshot();
    }
    const kept = snapshots();
    expect(kept).toHaveLength(KEEP);
    // The oldest names are the ones gone: the directory sorts chronologically.
    expect(kept.some((s) => s.path.endsWith("20260811T000000.txt"))).toBe(false);
  });

  it("says nothing at all when there is no resurrect here", () => {
    // A machine with no plugin installed is not an error and not a warning.
    expect(readLast()).toBe(null);
    expect(snapshot()).toBe(null);
    expect(bestSnapshot()).toBe(null);
    expect(clobbered()).toBe(null);
  });
});

describe("noticing a clobber", () => {
  it("sees one pane standing where nine used to be", () => {
    put("tmux_resurrect_20260810T195317.txt", save(9));
    snapshot();
    put("tmux_resurrect_20260810T200310.txt", save(1)); // the dying server's save
    expect(clobbered()).toMatchObject({ now: 1, had: 9 });
  });

  it("keeps its hands off a smaller save somebody meant", () => {
    /*
     * Closing four sessions on purpose makes a smaller save and means it. Only
     * one-pane-against-several is the signature — two against three is a person
     * closing a pane, and none of our business.
     */
    put("tmux_resurrect_a.txt", save(9));
    snapshot();
    put("tmux_resurrect_b.txt", save(3));
    expect(clobbered()).toBe(null);
  });

  it("is quiet when the newest save is the richest", () => {
    put("tmux_resurrect_a.txt", save(4));
    snapshot();
    put("tmux_resurrect_b.txt", save(9));
    expect(clobbered()).toBe(null);
  });
});

describe("putting last back", () => {
  it("repoints it at the good save, so THEIR restore reads the right file", () => {
    put("tmux_resurrect_20260810T195317.txt", save(9));
    snapshot();
    put("tmux_resurrect_20260810T200310.txt", save(1));

    const done = repairLast();
    expect(done?.restored).toBe("tmux_resurrect_20260810T195317.txt");
    // What `last` resolves to now is the nine-pane save.
    expect(panesIn(readFileSync(realpathSync(join(resurrectDir(), "last")), "utf8"))).toBe(9);
    // Still a symlink, which is what resurrect maintains.
    expect(readlinkSync(join(resurrectDir(), "last"))).toBe("tmux_resurrect_20260810T195317.txt");
  });

  it("keeps what it replaced, in case the judgement was wrong", () => {
    put("tmux_resurrect_a.txt", save(9));
    snapshot();
    put("tmux_resurrect_b.txt", save(1));
    repairLast();
    expect(existsSync(join(resurrectDir(), "last.clobbered"))).toBe(true);
    expect(panesIn(readFileSync(join(resurrectDir(), "last.clobbered"), "utf8"))).toBe(1);
  });

  it("destroys none of the user's saves", () => {
    // The only write into their directory is the pointer. Every file resurrect
    // wrote is still there afterwards.
    put("tmux_resurrect_a.txt", save(9));
    snapshot();
    put("tmux_resurrect_b.txt", save(1));
    repairLast();
    expect(existsSync(join(resurrectDir(), "tmux_resurrect_a.txt"))).toBe(true);
    expect(existsSync(join(resurrectDir(), "tmux_resurrect_b.txt"))).toBe(true);
  });

  it("does nothing when there is nothing to repair", () => {
    put("tmux_resurrect_a.txt", save(9));
    snapshot();
    expect(repairLast()).toBe(null);
    expect(existsSync(join(resurrectDir(), "last.clobbered"))).toBe(false);
  });

  it("leaves last resolvable at every moment", () => {
    /*
     * A symlink cannot be replaced in place, and a `last` that is missing for
     * even an instant is a restore that finds nothing. The repair writes beside
     * it and renames over, so the pointer is never absent — asserted by there
     * being no leftover temporary and the link resolving straight after.
     */
    put("tmux_resurrect_a.txt", save(9));
    snapshot();
    put("tmux_resurrect_b.txt", save(1));
    repairLast();
    const strays = snapshots().filter((s) => s.path.includes(".last.agx-"));
    expect(strays).toHaveLength(0);
    expect(existsSync(realpathSync(join(resurrectDir(), "last")))).toBe(true);
  });
});

describe("the developer's own resurrect is unreachable from a test", () => {
  it("refuses the real directories under NODE_ENV=test", () => {
    // The guard that makes every case above safe to run on a machine with real
    // sessions in it: with HOME pointing at a real home, this module answers
    // nothing rather than reading or repointing anything.
    const scratch = home;
    process.env.HOME = "/home/somebody";
    process.env.XDG_CONFIG_HOME = "/home/somebody/.config";
    expect(process.env.NODE_ENV).toBe("test");
    expect(readLast()).toBe(null);
    expect(snapshot()).toBe(null);
    expect(snapshots()).toHaveLength(0);
    expect(repairLast()).toBe(null);
    expect(snapshotDir().startsWith("/home/somebody")).toBe(true); // it resolved it, and still refused
    process.env.HOME = scratch;
  });
});
