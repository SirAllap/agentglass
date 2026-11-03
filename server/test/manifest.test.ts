/*
 * WHAT THE TRUNK SAYS, AND WHICH ROWS WAIT FOR A VERDICT.
 *
 * The window, the boundary and the 24-hour move are rules the write guard and
 * the view both read, so they are pinned here on fabricated commits: no clock,
 * no repository, one behaviour per test.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  WINDOW_MS, SIGNED_TO_TEST_MS, ancestorsOf, deriveRows, readTrunk, ticketOf, type Commit, type Verdict,
} from "../src/manifest.ts";

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);
const sha = (n: number) => n.toString(16).padStart(40, "0");
const commit = (n: number, ms: number, subject = `change ${n}`): Commit =>
  ({ sha: sha(n), time: Math.floor(ms / 1000), parents: [sha(n - 1)], subject });

describe("the 7-day window", () => {
  test("a commit exactly at the start is in, and one second earlier is out", () => {
    const rows = deriveRows({
      now: NOW,
      verdicts: new Map(),
      ancestors: null,
      commits: [commit(2, NOW - WINDOW_MS), commit(1, NOW - WINDOW_MS - 1000)],
    });
    expect(rows.map((r) => r.sha)).toEqual([sha(2)]);
  });

  test("a committer time in the future is in the window and sorts first", () => {
    const rows = deriveRows({
      now: NOW,
      verdicts: new Map(),
      ancestors: null,
      commits: [commit(1, NOW - 1000), commit(2, NOW + 60_000)],
    });
    expect(rows.map((r) => r.sha)).toEqual([sha(2), sha(1)]);
  });
});

describe("To test and Done", () => {
  test("an unsigned row stays in To test for the whole window", () => {
    const rows = deriveRows({ now: NOW, verdicts: new Map(), ancestors: null, commits: [commit(1, NOW - WINDOW_MS + 1)] });
    expect(rows[0]!.group).toBe("toTest");
  });

  test("a verdict 25 hours old is Done, is not counted, and stays out of left", () => {
    const verdicts = new Map<string, Verdict>([[sha(1), { verdict: "tested", at: NOW - SIGNED_TO_TEST_MS - 3_600_000, kind: "person", note: "fine" }]]);
    const rows = deriveRows({ now: NOW, verdicts, ancestors: null, commits: [commit(1, NOW - 60_000)] });
    expect(rows[0]!.group).toBe("done");
    expect(rows.filter((r) => r.group === "toTest" && !r.verdict)).toHaveLength(0);
  });

  test("a verdict under 24 hours old keeps the row in To test, so Undo is reachable", () => {
    const verdicts = new Map<string, Verdict>([[sha(1), { verdict: "failed", at: NOW - SIGNED_TO_TEST_MS + 60_000, kind: "person", note: null }]]);
    const rows = deriveRows({ now: NOW, verdicts, ancestors: null, commits: [commit(1, NOW - 60_000)] });
    expect(rows[0]!.group).toBe("toTest");
    expect(rows[0]!.verdict).toBe("failed");
  });
});

describe("the install boundary", () => {
  test("with no boundary every window row is To test, signable, and none waits for a build", () => {
    const rows = deriveRows({
      now: NOW, verdicts: new Map(), ancestors: null,
      commits: [commit(1, NOW - 60_000), commit(2, NOW - 120_000)],
    });
    expect(rows.every((r) => r.group === "toTest")).toBe(true);
    expect(rows.every((r) => r.inBuild === null)).toBe(true);
    expect(rows.filter((r) => !r.verdict)).toHaveLength(2);
  });

  test("with a boundary a row the build does not contain waits in ready, not To test", () => {
    const rows = deriveRows({
      now: NOW, verdicts: new Map(), ancestors: new Set([sha(1)]),
      commits: [commit(1, NOW - 60_000), commit(2, NOW - 120_000)],
    });
    expect(rows.find((r) => r.sha === sha(1))!.group).toBe("toTest");
    expect(rows.find((r) => r.sha === sha(2))!.group).toBe("ready");
    expect(rows.find((r) => r.sha === sha(2))!.inBuild).toBe(false);
  });
});

describe("the start line", () => {
  const newest = commit(3, NOW - 60_000);
  const middle = commit(2, NOW - 120_000);
  const oldest = commit(1, NOW - 180_000);
  const commits = [newest, middle, oldest];

  test("only commits after the line are rows", () => {
    const rows = deriveRows({ now: NOW, verdicts: new Map(), ancestors: null, commits, start: { sha: middle.sha, at: middle.time * 1000 } });
    expect(rows.map((r) => r.sha)).toEqual([newest.sha]);
  });

  test("a verdict already given stays behind the line, and the line's own commit is not a row", () => {
    const verdicts = new Map<string, Verdict>([[oldest.sha, { verdict: "tested", at: NOW - 60_000, kind: "person", note: null }]]);
    const rows = deriveRows({ now: NOW, verdicts, ancestors: null, commits, start: { sha: middle.sha, at: middle.time * 1000 } });
    expect(rows.map((r) => r.sha)).toEqual([newest.sha, oldest.sha]);
    expect(rows.find((r) => r.sha === oldest.sha)!.verdict).toBe("tested");
    expect(rows.some((r) => r.sha === middle.sha)).toBe(false);
  });

  test("a line whose commit is outside the list falls back to its time", () => {
    const rows = deriveRows({ now: NOW, verdicts: new Map(), ancestors: null, commits, start: { sha: "e".repeat(40), at: middle.time * 1000 } });
    expect(rows.map((r) => r.sha)).toEqual([newest.sha]);
  });
});

describe("a ticket id", () => {
  test("is the first one that is not an encoding or a standard", () => {
    expect(ticketOf("fix ORBIT-1042 in the manifest")).toBe("ORBIT-1042");
    expect(ticketOf("decode UTF-8 and SHA-256 from ISO-8601")).toBeNull();
    expect(ticketOf("UTF-8 is not a ticket, AC-42 is")).toBe("AC-42");
  });
});

describe("reading a real trunk", () => {
  let dir = "";
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

  test("a merge row shows its second parent's subject; a plain row shows its own", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-manifest-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A"); git("commit", "-qm", "seed the repo");
    git("checkout", "-q", "-b", "orbit");
    writeFileSync(join(dir, "b.txt"), "two\n");
    git("add", "-A"); git("commit", "-qm", "ORBIT-1042 the fix that landed");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "orbit", "-m", "Merge branch orbit");
    const { branch, commits } = await readTrunk(dir, Date.now());
    expect(branch).toBe("main");
    expect(commits[0]!.subject).toBe("ORBIT-1042 the fix that landed");
    expect(commits[1]!.subject).toBe("seed the repo");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a build commit this checkout does not have claims no boundary", async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-manifest2-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git("add", "-A"); git("commit", "-qm", "seed");
    const head = git("rev-parse", "HEAD").stdout.trim();
    expect(await ancestorsOf(dir, head)).toEqual(new Set([head]));
    expect(await ancestorsOf(dir, "f".repeat(40))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
