/**
 * `panesWithPids`/`activePane` stop at the known socket when it already has
 * the window.
 *
 * Before this, `windowPanesEverywhere` ran `list-panes` on every live tmux
 * server before looking at any answer, in `tmuxSockets` order -- the known
 * socket first, then the rest, each spawned regardless of whether the first
 * one already answered. With one tab open that is one wasted spawn; with a
 * socket directory holding several live servers (a second checkout, an old
 * run) it is one per poll for every window hover. The known socket is asked
 * alone first; the rest are only asked when it comes back empty.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { panesWithPids, activePane } from "../src/tmuxctl.ts";

const uid = process.getuid?.() ?? 0;
let tmpdir = "";
let sockDir = "";
const savedTmp = process.env.TMUX_TMPDIR;

const tmuxEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") env[k] = v;
  env.TMUX_TMPDIR = tmpdir;
  return env;
};

const tmux = (label: string, ...args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", "-L", label, ...args], { env: tmuxEnv(), stdout: "pipe", stderr: "ignore" });

let socketA = "";
let socketB = "";
let windowId = "";

describe("panesWithPids/activePane ask the known socket alone first", () => {
  beforeAll(() => {
    tmpdir = mkdtempSync("/tmp/agx-firstsock-");
    sockDir = join(tmpdir, `tmux-${uid}`);
    if (tmux("agx-first-a", "new-session", "-d", "sleep", "60").exitCode !== 0) {
      throw new Error("could not start server A");
    }
    if (tmux("agx-first-b", "new-session", "-d", "sleep", "60").exitCode !== 0) {
      throw new Error("could not start server B");
    }
    socketA = join(sockDir, "agx-first-a");
    socketB = join(sockDir, "agx-first-b");
    windowId = tmux("agx-first-a", "display-message", "-p", "#{window_id}").stdout.toString().trim();
    // Both fresh servers hand out the same first window id -- exactly the
    // case where asking every socket instead of stopping at the first would
    // silently describe the wrong server's window.
    const idB = tmux("agx-first-b", "display-message", "-p", "#{window_id}").stdout.toString().trim();
    expect(idB).toBe(windowId);
    process.env.TMUX_TMPDIR = tmpdir;
  });

  afterAll(() => {
    tmux("agx-first-a", "kill-server");
    tmux("agx-first-b", "kill-server");
    if (savedTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = savedTmp;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  test("no spawn reaches the other live server once the known one answers", async () => {
    const origSpawn = Bun.spawn.bind(Bun);
    let spawnedB = false;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      const cmd = args[0];
      if (Array.isArray(cmd) && cmd.includes(socketB) && cmd.includes("list-panes")) spawnedB = true;
      return origSpawn(...args);
    }) as typeof Bun.spawn;
    try {
      const known = ["-S", socketA];
      const rows = await panesWithPids(known, windowId);
      expect(rows.length).toBeGreaterThan(0);
      expect(spawnedB).toBe(false);

      spawnedB = false;
      const active = await activePane(known, windowId);
      expect(active).not.toBeNull();
      expect(spawnedB).toBe(false);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    }
  });
});
