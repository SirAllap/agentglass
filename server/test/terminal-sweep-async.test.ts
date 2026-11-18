import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findTmuxBelowAsync, tmuxRunningAsync } from "../src/procchildren.ts";

test("a walk that hangs gives the last known answer after the timeout", async () => {
  const never = () => new Promise<number | null>(() => {});
  expect(await tmuxRunningAsync(1, true, 20, never)).toBe(true);
  expect(await tmuxRunningAsync(1, false, 20, never)).toBe(false);
});

test("a walk that answers wins, and a failing walk gives the fallback", async () => {
  expect(await tmuxRunningAsync(1, false, 1000, async () => 42)).toBe(true);
  expect(await tmuxRunningAsync(1, true, 1000, async () => null)).toBe(false);
  expect(await tmuxRunningAsync(1, true, 1000, async () => { throw new Error("x"); })).toBe(true);
});

test("the async walk finds nothing below a shell with no tmux", async () => {
  expect(await findTmuxBelowAsync(process.pid)).toBeNull();
  expect(await findTmuxBelowAsync(-1)).toBeNull();
});

test("the terminal sweep no longer reads /proc on the loop", () => {
  const t = readFileSync(join(import.meta.dir, "../src/terminal.ts"), "utf8");
  expect(t).toContain("tmuxRunningAsync(proc.pid");
  expect(t).not.toMatch(/\btmuxRunning\(proc\.pid\)/);
  expect(t).not.toContain("findTmuxBelow(");
});
