import { test, expect, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

/*
 * The crash-loop warning reaches the status the Settings page reads.
 *
 * The boot that declined to restore recorded the fact, and nothing carried it
 * out: `/terminal/tmux-status` had no such field, so after four launches in ten
 * minutes the person had no sessions and no sentence on screen. The log also
 * named a hardcoded state path even when AGENTGLASS_STATE_DIR had moved it.
 */

const STATE = join(tmpdir(), `agx-crashloop-status-${process.pid}`);
const savedStateDir = process.env.AGENTGLASS_STATE_DIR;
process.env.AGENTGLASS_STATE_DIR = STATE;
const restore = await import("../src/tmuxrestore.ts");
const indexSrc = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

afterAll(() => {
  restore.__clearCrashLoop();
  if (savedStateDir === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = savedStateDir;
  rmSync(STATE, { recursive: true, force: true });
});

test("status is null until a boot declines, then names the file that clears it", () => {
  expect(restore.crashLoopStatus()).toBeNull();
  restore.noteCrashLoop(5);
  const s = restore.crashLoopStatus()!;
  expect(s.launches).toBe(5);
  expect(s.file).toBe(restore.launchesPath());
  expect(s.file.startsWith(STATE)).toBe(true);
});

test("the tmux-status route carries it, and the log does not hardcode the path", () => {
  const at = indexSrc.indexOf('pathname === "/terminal/tmux-status"');
  const block = indexSrc.slice(at, indexSrc.indexOf("\n    }\n", at));
  expect(block).toContain("crashLoop: crashLoopStatus()");
  expect(indexSrc).not.toContain('"~/.local/state/agentglass/tmux/restore/launches.json"');
});
