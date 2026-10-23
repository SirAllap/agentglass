/**
 * A TAB THE APP OPENS LANDS NEXT TO ITS GROUP, not at the end of the bar.
 *
 * `new-window` with no `-a` took the first free index. With tabs `pr-1042`,
 * `pr-1043`, `orbit-a`, `orbit-b`, a new `pr-1044` appeared after `orbit-b`,
 * away from the tabs it belongs with. The decision is a pure function; the last
 * test drives a real tmux on a socket of its own, because the claim is about the
 * index tmux gives the window.
 */
import { test, expect, afterAll } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupOf, placeAfter, placeArgs, parsePlaceWindows, type PlaceWindow } from "../src/tmuxplace.ts";
import { newWindowRunning } from "../src/tmuxctl.ts";

const bar: PlaceWindow[] = [
  { id: "@1", index: 0, name: "pr-1042" },
  { id: "@2", index: 1, name: "pr-1043" },
  { id: "@3", index: 2, name: "orbit-a" },
  { id: "@4", index: 3, name: "orbit-b" },
];

test("the group is the text before the first dash or the trailing digits", () => {
  expect(groupOf("pr-1044")).toBe("pr");
  expect(groupOf("pr1044")).toBe("pr");
  expect(groupOf("orbit-a-2")).toBe("orbit");
  expect(groupOf("1044")).toBe("");
});

test("a grouped name goes after the last window of its group", () => {
  expect(placeAfter(bar, "pr-1044")).toBe("@2");
  expect(placeAfter(bar, "orbit-c")).toBe("@4");
});

test("the last by index wins, not the last listed", () => {
  expect(placeAfter([...bar].reverse(), "pr-1044")).toBe("@2");
});

test("no group match falls back to the window it was opened from, then to the end", () => {
  expect(placeAfter(bar, "solo", "@3")).toBe("@3");
  expect(placeAfter(bar, "solo", "@99")).toBeNull();
  expect(placeAfter(bar, "solo")).toBeNull();
  expect(placeArgs(bar, "solo", "=orbit:")).toEqual(["-t", "=orbit:"]);
  expect(placeArgs(bar, "pr-1044", "=orbit:")).toEqual(["-a", "-t", "@2"]);
});

test("a window name with a space or a tab column survives parsing", () => {
  expect(parsePlaceWindows("@5\t3\tmy tab\nnoise\n@x\t1\tbad")).toEqual([{ id: "@5", index: 3, name: "my tab" }]);
});

const NAME = `agx-place-${process.pid}`;
const tmpdirPrivate = mkdtempSync(join(tmpdir(), "agx-place-"));
const SOCK = ["-f", "/dev/null", "-L", NAME];
const env = { ...process.env, TMUX_TMPDIR: tmpdirPrivate } as Record<string, string>;
delete env.TMUX;
const sh = (args: string[]) => Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", env });
afterAll(() => {
  sh(["kill-server"]);
  try { rmSync(tmpdirPrivate, { recursive: true, force: true }); } catch { /* gone */ }
});

test("a real tmux: the new grouped tab takes the index after its group", () => {
  const saved = { dir: process.env.TMUX_TMPDIR, tmux: process.env.TMUX };
  process.env.TMUX_TMPDIR = tmpdirPrivate;
  delete process.env.TMUX;
  try {
    sh(["new-session", "-d", "-s", "work", "-n", "pr-1042", "sleep", "300"]);
    for (const n of ["pr-1043", "orbit-a", "orbit-b"]) sh(["new-window", "-d", "-t", "work:", "-n", n, "sleep", "300"]);
    const made = newWindowRunning({ pid: 0, socket: SOCK, id: "work" } as never, "/tmp", "pr-1044", ["sleep", "300"]);
    expect(made, "tmux made the window").not.toBeNull();
    const rows = sh(["list-windows", "-t", "work", "-F", "#{window_index} #{window_name}"]).stdout.toString().trim();
    expect(rows).toBe("0 pr-1042\n1 pr-1043\n2 pr-1044\n3 orbit-a\n4 orbit-b");
  } finally {
    if (saved.dir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.dir;
    if (saved.tmux !== undefined) process.env.TMUX = saved.tmux;
  }
});
