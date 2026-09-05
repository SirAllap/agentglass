/**
 * A run that died because a tool was missing has to say so.
 *
 * Measured today: a run threw `ENOENT: no such file or directory,
 * posix_spawn 'bun'`, its worktree was empty because it died before its
 * first commit, and the row that came out the other end of `settleAbandoned`
 * said "the branch it worked on is gone — merged and tidied, swept as empty,
 * or thrown away" — three sentences, none of which named `bun`. That text is
 * a guess about the branch; ENOENT is a fact about the machine, and the
 * fact was cheap to check.
 */
import { test, expect, beforeEach } from "bun:test";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import { setGitHook, setBunHook, settleAbandoned } from "../src/understudy-watchdog.ts";

const REPO = "/tmp/understudy-missing-tool-probe";

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  // A branch that does not exist: the shape of a run killed before its
  // first commit, same as `understudy-survives-restart.test.ts` uses.
  setGitHook(async () => ({ ok: false, out: "" }));
});

function orphanedRun(title: string) {
  const item = { source: "asked", id: `asked:${title}`, title, detail: "", repo: REPO, weight: 1 };
  const id = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-${title}`, branch: `feat/${title}` });
  Work.finishRun(id!, "abandoned", "the server restarted while this was running — nobody was left to record how it ended");
  return id!;
}

test("a missing bun is named, not theorised about", async () => {
  const id = orphanedRun("missing-bun");
  setBunHook(() => "");

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state).toBe("empty");
  expect(row?.outcome).toContain("bun");
  expect(row?.outcome).not.toContain("branch it worked on (feat/bun-fine) is gone");

  setBunHook(() => "/usr/bin/bun");
});

test("bun present keeps the ordinary branch-gone verdict — no false alarm", async () => {
  const id = orphanedRun("bun-fine");
  setBunHook(() => "/usr/bin/bun");

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state).toBe("empty");
  expect(row?.outcome).toContain("branch it worked on (feat/bun-fine) is gone");
  expect(row?.outcome).not.toContain("could not be found");
});
