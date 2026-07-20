import { test, expect } from "bun:test";
import { isWrite, record, recent } from "../src/gitlog.ts";

test("plain reads are not writes", () => {
  for (const args of [["status", "--porcelain"], ["log", "-n10"], ["diff", "--cached"], ["for-each-ref", "refs/heads"], ["rev-list", "--count", "HEAD"]]) {
    expect(isWrite(args)).toBe(false);
  }
});

test("mutating commands are writes", () => {
  for (const args of [["add", "."], ["commit", "-m", "x"], ["push"], ["pull"], ["fetch", "--all"], ["reset", "--hard"], ["rebase", "main"], ["cherry-pick", "abc"], ["clean", "-fd"]]) {
    expect(isWrite(args)).toBe(true);
  }
});

test("leading -c config pairs don't hide the subcommand", () => {
  expect(isWrite(["-c", "core.quotePath=false", "commit", "-m", "x"])).toBe(true);
  expect(isWrite(["-c", "core.quotePath=false", "diff", "--cached"])).toBe(false);
});

// The dual-purpose ones: same subcommand reads or writes depending on the verb.
test("stash list reads, stash push writes", () => {
  expect(isWrite(["stash", "list"])).toBe(false);
  expect(isWrite(["stash", "push"])).toBe(true);
  expect(isWrite(["stash", "drop", "0"])).toBe(true);
});

test("remote -v reads, remote add writes", () => {
  expect(isWrite(["remote", "-v"])).toBe(false);
  expect(isWrite(["remote", "add", "origin", "url"])).toBe(true);
});

test("branch and tag listing read; creating and deleting write", () => {
  expect(isWrite(["branch", "--list"])).toBe(false);
  expect(isWrite(["branch", "-d", "old"])).toBe(true);
  expect(isWrite(["tag", "--list"])).toBe(false);
  expect(isWrite(["tag", "v1.0"])).toBe(true);
});

test("worktree list reads, worktree add writes", () => {
  expect(isWrite(["worktree", "list", "--porcelain"])).toBe(false);
  expect(isWrite(["worktree", "add", "/tmp/x", "br"])).toBe(true);
});

test("an unknown subcommand is treated as a read", () => {
  // The allowlist is deliberately about writes: a command we don't know is far
  // more likely to be another query, and over-reporting writes would bury the
  // lines the log exists to surface.
  expect(isWrite(["shortlog"])).toBe(false);
});

test("records exit code, duration and the first stderr line on failure", () => {
  const before = recent().length;
  record("/repo", ["commit", "-m", "x"], 1, 12.5, "fatal: nothing to commit\nsecond line\n");
  const all = recent();
  expect(all.length).toBe(before + 1);
  const e = all[all.length - 1];
  expect(e.args).toEqual(["commit", "-m", "x"]);
  expect(e.exitCode).toBe(1);
  expect(e.write).toBe(true);
  expect(e.error).toBe("fatal: nothing to commit");
});

test("a successful command carries no error", () => {
  record("/repo", ["status"], 0, 3, "");
  const e = recent().at(-1)!;
  expect(e.error).toBeUndefined();
});

test("since returns only newer entries", () => {
  record("/repo", ["status"], 0, 1, "");
  const mark = recent().at(-1)!.id;
  record("/repo", ["log"], 0, 1, "");
  record("/repo", ["diff"], 0, 1, "");
  const after = recent(mark);
  expect(after).toHaveLength(2);
  expect(after.every((e) => e.id > mark)).toBe(true);
});
