/*
 * Which `task` the app runs.
 *
 * The point of the order below is the second rung: local tasks should work on a
 * machine that has never heard of Taskwarrior, the same way the terminal works
 * on a machine with no tmux. A bundled binary has to be FOUND before it can be
 * shipped, and this is the half that finds it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskBin, __resetTaskBin } from "../src/tasks.ts";

const dirs: string[] = [];
const saved = { path: process.env.AGENTGLASS_TASK_PATH, dir: process.env.AGENTGLASS_TASK_DIR };

afterEach(() => {
  process.env.AGENTGLASS_TASK_PATH = saved.path;
  process.env.AGENTGLASS_TASK_DIR = saved.dir;
  if (saved.path === undefined) delete process.env.AGENTGLASS_TASK_PATH;
  if (saved.dir === undefined) delete process.env.AGENTGLASS_TASK_DIR;
  __resetTaskBin();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A directory holding an executable called `task`. */
function withBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "agx-task-"));
  dirs.push(dir);
  const p = join(dir, "task");
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return dir;
}

describe("finding taskwarrior", () => {
  it("prefers the explicit override over everything", () => {
    const dir = withBinary();
    process.env.AGENTGLASS_TASK_PATH = join(dir, "task");
    __resetTaskBin();
    expect(taskBin()).toBe(join(dir, "task"));
  });

  it("finds one bundled beside the app", () => {
    // The whole reason this exists: a machine with no Taskwarrior installed.
    const dir = withBinary();
    process.env.AGENTGLASS_TASK_DIR = dir;
    __resetTaskBin();
    expect(taskBin()).toBe(join(dir, "task"));
  });

  it("ignores an override that is not runnable, rather than failing outright", () => {
    /* A stale path in a config file must not take local tasks away from a
       machine that has a perfectly good `task` on PATH. */
    const dir = mkdtempSync(join(tmpdir(), "agx-task-"));
    dirs.push(dir);
    writeFileSync(join(dir, "task"), "not executable\n");
    process.env.AGENTGLASS_TASK_PATH = join(dir, "task");
    process.env.AGENTGLASS_TASK_DIR = dir;
    __resetTaskBin();
    // Falls through to PATH, which on this machine may or may not have one —
    // what matters is that it did not return the unusable file.
    expect(taskBin()).not.toBe(join(dir, "task"));
  });

  it("says nothing rather than guessing when there is none anywhere", () => {
    const empty = mkdtempSync(join(tmpdir(), "agx-task-"));
    dirs.push(empty);
    process.env.AGENTGLASS_TASK_DIR = empty;
    delete process.env.AGENTGLASS_TASK_PATH;
    const path = process.env.PATH;
    process.env.PATH = empty;
    __resetTaskBin();
    try { expect(taskBin()).toBeNull(); } finally { process.env.PATH = path; }
  });
});
