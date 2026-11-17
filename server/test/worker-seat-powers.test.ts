/*
 * A worker can do what its seat can. The floor is only what the seat lacks too;
 * the rest is a narrowing a seat chooses at start, or a rule.
 */
import { describe, expect, test } from "bun:test";
import { deniedFor } from "../src/agents/envelope.ts";
import { DEFAULT_CEILING, DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { DENIED_COMMANDS, NEVER_LIFTABLE, workerRole } from "../../shared/workerRoles.ts";

const builder = workerRole("builder")!;

describe("section 1: the floor and the defaults", () => {
  test("the default envelope is the seat's: commit and worktree ops are on; network and docker are the two that drop the sandbox", () => {
    expect([DEFAULT_WORKER_ENVELOPE.commit, DEFAULT_WORKER_ENVELOPE.worktreeOps]).toEqual([true, true]);
    expect([DEFAULT_CEILING.commit, DEFAULT_CEILING.worktreeOps, DEFAULT_CEILING.network, DEFAULT_CEILING.docker]).toEqual([true, true, true, true]);
  });
  test("a default worker is denied only the real floor", () => {
    const open = (c: string) => deniedFor(DEFAULT_WORKER_ENVELOPE, builder, ["rm", "ssh", "scp", "kill", "pkill", "killall", "killall5", "xkill"], true).includes(c);
    for (const c of ["git push", "git commit", "gh", "curl", "git merge", "aws", "rm", "ssh"]) expect(open(c), c).toBe(false);
    for (const c of ["sudo", "git worktree repair", "git worktree lock"]) expect(open(c), c).toBe(true);
  });
  test("the floor is small and cannot be granted", () => {
    expect([...DENIED_COMMANDS].sort()).toEqual(["git worktree lock", "git worktree move", "git worktree repair", "git worktree unlock", "sudo"]);
    expect([...NEVER_LIFTABLE]).toEqual([...DENIED_COMMANDS]);
  });
  test("a seat narrows at start: an envelope with commit off denies git commit", () => {
    expect(deniedFor({ ...DEFAULT_WORKER_ENVELOPE, commit: false }, builder)).toContain("git commit");
    expect(deniedFor({ ...DEFAULT_WORKER_ENVELOPE, network: false }, builder)).toContain("curl");
    expect(deniedFor({ ...DEFAULT_WORKER_ENVELOPE, worktreeOps: false }, builder)).toContain("git merge");
  });
});
