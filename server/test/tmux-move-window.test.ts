/*
 * Reordering a tab, against the real tmux.
 *
 * Three things were measured on 3.6a before any of this was written, and each
 * of them was already wrong in the code:
 *
 *   - `move-window -t 3` onto an OCCUPIED index answers "index in use: 3" and
 *     moves nothing. Every index in a strip is occupied, so the number box in
 *     the tab strip did nothing at all — silently — for its whole life. The
 *     comment above it claimed tmux would "renumber around it".
 *   - `renumber-windows on` fires on a CLOSE, not on a move. A move alone
 *     leaves `1 3 4 5 6 7 8`: a hole, and a number past the end.
 *   - `-b` against an index one past the last — the obvious way to spell "put
 *     it at the end" — silently moves the window to the FRONT.
 *
 * Real tmux on a socket of this file's own, because all three are claims about
 * what tmux does and a mock would only repeat what I believed.
 */
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "agx-move-"));
const SOCKET = `agx-move-${process.pid}`;
const BIN = Bun.which("tmux") ?? "tmux";

const tmux = (...args: string[]): string => {
  const r = Bun.spawnSync([BIN, "-L", SOCKET, "-f", "/dev/null", ...args], {
    env: { ...process.env, TMUX_TMPDIR: DIR }, stdout: "pipe", stderr: "pipe",
  });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
};

/** The strip as a person reads it: `1:api 2:web 3:logs`. */
const strip = (): string => tmux("list-windows", "-t", "desk", "-F", "#{window_index}:#{window_name}").split("\n").join(" ");

/** What runAction's `move` case does, in the same order. */
const move = (name: string, to: number, after = false): void => {
  tmux("move-window", after ? "-a" : "-b", "-s", `desk:${name}`, "-t", `desk:${to}`);
  tmux("move-window", "-r", "-t", "desk");
};

beforeEach(() => {
  tmux("kill-session", "-t", "=desk");
  tmux("new-session", "-d", "-s", "desk", "-n", "w1");
  tmux("set", "-g", "base-index", "1");
  tmux("move-window", "-r", "-t", "desk");
  for (const n of [2, 3, 4, 5]) tmux("new-window", "-d", "-t", "desk:", "-n", `w${n}`);
});

afterAll(() => {
  tmux("kill-server");
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* gone */ }
});

describe("dragging a tab", () => {
  it("starts from a strip numbered 1..N", () => {
    expect(strip()).toBe("1:w1 2:w2 3:w3 4:w4 5:w5");
  });

  it("dropped leftwards, lands where the line was and pushes the rest along", () => {
    // His words: "muevo la 7 al 3, entonces el 3 pasa a ser 4".
    move("w5", 2);
    expect(strip()).toBe("1:w1 2:w5 3:w2 4:w3 5:w4");
  });

  it("dropped rightwards, the same rule reads the other way", () => {
    // Insert BEFORE the tab you dropped on, which is what the indicator on its
    // leading edge promises. w2 lands before w5, so at 4.
    move("w2", 5);
    expect(strip()).toBe("1:w1 2:w3 3:w4 4:w2 5:w5");
  });

  it("dropped on the end zone, becomes the last one", () => {
    // The only way to get there: `-b` one past the end moves it to the FRONT.
    move("w2", 5, true);
    expect(strip()).toBe("1:w1 2:w3 3:w4 4:w5 5:w2");
  });

  it("leaves no holes, whichever way it went", () => {
    move("w4", 1);
    move("w3", 5, true);
    move("w1", 2);
    const idx = strip().split(" ").map((s) => Number(s.split(":")[0]));
    expect(idx).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("what tmux does on its own, and does not", () => {
  it("refuses a bare move onto an occupied index", () => {
    // The bug the number box had: this is every index in a real strip.
    const before = strip();
    const r = Bun.spawnSync([BIN, "-L", SOCKET, "-f", "/dev/null", "move-window", "-s", "desk:w5", "-t", "desk:2"], {
      env: { ...process.env, TMUX_TMPDIR: DIR }, stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(r.stderr)).toContain("index in use");
    expect(strip()).toBe(before);
  });

  it("does not renumber on a move, only on a close", () => {
    tmux("set", "-g", "renumber-windows", "on");
    tmux("move-window", "-b", "-s", "desk:w2", "-t", "desk:5");
    // The hole is the point: 2 is gone and 6 is past the end.
    expect(strip()).toBe("1:w1 3:w3 4:w4 5:w2 6:w5");
    tmux("move-window", "-r", "-t", "desk");
    expect(strip()).toBe("1:w1 2:w3 3:w4 4:w2 5:w5");
  });

  it("puts a window at the FRONT when -b names an index past the end", () => {
    // Which is why the end zone sends `after` on the last window instead.
    tmux("move-window", "-b", "-s", "desk:w2", "-t", "desk:6");
    tmux("move-window", "-r", "-t", "desk");
    expect(strip().startsWith("1:w2")).toBe(true);
  });
});
