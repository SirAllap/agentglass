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
  // Identify the new entry by its id, not by the list getting longer: the ring
  // is capped (AGENTGLASS_GITLOG_SIZE, 400 by default) and the rest of the
  // suite runs enough real git to fill it, after which recording one more
  // evicts one more and the length never moves. The id is monotonic either way.
  const before = recent().at(-1)?.id ?? 0;
  record("/repo", ["commit", "-m", "x"], 1, 12.5, "fatal: nothing to commit\nsecond line\n");
  const all = recent();
  expect(all.at(-1)!.id).toBe(before + 1);
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

test("a since-poll returns the OLDEST entries after the cursor, so a burst loses nothing", () => {
  // The bug: recent() returned the newest `limit` after `since` while the client
  // advances `since` to the last id it received — so a burst of more than
  // `limit` entries between two polls dropped everything between `since` and the
  // newest page, for good. Poll incrementally the way the client does and assert
  // every id is delivered exactly once, contiguous, in order.
  const start = recent().at(-1)?.id ?? 0;
  for (let i = 0; i < 25; i++) record("/repo", ["status"], 0, 1, "");
  let since = start;
  const seen: number[] = [];
  for (let poll = 0; poll < 20; poll++) {
    const batch = recent(since, 10);
    if (!batch.length) break;
    for (let i = 1; i < batch.length; i++) expect(batch[i]!.id).toBeGreaterThan(batch[i - 1]!.id); // ascending
    for (const e of batch) seen.push(e.id);
    since = batch[batch.length - 1]!.id;
  }
  const mine = seen.filter((id) => id > start);
  expect(mine.length).toBeGreaterThanOrEqual(25); // all of them, not just the newest page
  for (let i = 1; i < mine.length; i++) expect(mine[i]).toBe(mine[i - 1]! + 1); // no gap
});

test("a first load (no cursor) still shows the most recent activity", () => {
  for (let i = 0; i < 5; i++) record("/repo", ["status"], 0, 1, "");
  const newest = recent().at(-1)!.id;
  // With a small limit and no cursor, the page ends at the newest entry.
  expect(recent(0, 3).at(-1)!.id).toBe(newest);
});

test("a non-numeric AGENTGLASS_GITLOG_SIZE falls back to the default, staying bounded", async () => {
  // NaN used to skip BOTH the disable guard (`NaN <= 0` is false) and the trim
  // (`length > NaN` is false), so the ring grew without any bound at all.
  const prev = process.env.AGENTGLASS_GITLOG_SIZE;
  process.env.AGENTGLASS_GITLOG_SIZE = "four hundred";
  try {
    const gl = await import(`../src/gitlog.ts?u=${Math.random()}`);
    for (let i = 0; i < 500; i++) gl.record("/r", ["status"], 0, 1, "");
    expect(gl.recent(0, 1000).length).toBeLessThanOrEqual(400);
  } finally {
    if (prev === undefined) delete process.env.AGENTGLASS_GITLOG_SIZE;
    else process.env.AGENTGLASS_GITLOG_SIZE = prev;
  }
});
