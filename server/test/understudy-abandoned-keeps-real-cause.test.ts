/**
 * The first sentence of a settled row has to be what actually killed the run,
 * not a theory about its branch.
 *
 * Measured today: rows read "the branch it worked on is gone — merged and
 * tidied, swept as empty, or thrown away" for runs that had already written
 * down a real cause — an ENOENT on the worktree directory, an interactive
 * prompt nobody answered, a branch another run still had checked out —
 * before `settleAbandoned` ever looked at git. `settleAbandoned` threw that
 * sentence away every time and replaced it wholesale with the branch guess.
 * A cause measured at the moment of failure outranks a diff run minutes
 * later, so it has to survive being settled, with the branch fact (if any)
 * added after it rather than instead of it.
 */
import { test, expect, beforeEach } from "bun:test";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import { setGitHook, setBunHook, settleAbandoned } from "../src/understudy-watchdog.ts";

const REPO = "/tmp/understudy-real-cause-probe";

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  setBunHook(() => "/usr/bin/bun");
});

function orphanedRun(title: string, outcome: string) {
  const item = { source: "asked", id: `asked:${title}`, title, detail: "", repo: REPO, weight: 1 };
  const id = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree: `${REPO}-${title}`, branch: `feat/${title}` });
  Work.finishRun(id!, "abandoned", outcome);
  return id!;
}

test("an ENOENT on the worktree directory survives being settled", async () => {
  const id = orphanedRun(
    "enoent",
    "the run threw and could not finish: ENOENT: no such file or directory, uv_cwd",
  );
  // No branch was ever cut — the shape of a run that died before it could.
  setGitHook(async () => ({ ok: false, out: "" }));

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state).toBe("empty");
  expect(row?.outcome).toContain("ENOENT: no such file or directory, uv_cwd");
  // The branch theory may still follow, but it is not the whole sentence.
  expect(row?.outcome?.startsWith("the run threw and could not finish: ENOENT")).toBe(true);
});

test("an unanswered interactive prompt survives being settled", async () => {
  const id = orphanedRun(
    "prompt",
    "this opened an interactive prompt only a person can answer, and nobody is watching this pane to give one",
  );
  setGitHook(async () => ({ ok: false, out: "" }));

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state).toBe("empty");
  expect(row?.outcome).toContain("interactive prompt only a person can answer");
  expect(row?.outcome?.indexOf("interactive prompt")).toBeLessThan(20);
});

test("a branch another run still has checked out survives being settled", async () => {
  const id = orphanedRun(
    "occupied",
    "feat/occupied is checked out in another worktree — that run is still going or its directory is still there",
  );
  // The branch is very much still there, with commits nobody has merged.
  setGitHook(async (args) => {
    if (args[0] === "rev-parse") return { ok: true, out: "deadbeef\n" };
    if (args[0] === "rev-list") return { ok: true, out: "3\n" };
    return { ok: true, out: "" };
  });

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state, "unmerged work is still waiting, not swallowed by the branch note").toBe("abandoned");
  expect(row?.outcome).toContain("checked out in another worktree");
  expect(row?.outcome?.startsWith("feat/occupied is checked out in another worktree")).toBe(true);
  // The branch fact comes second, not instead of the real cause.
  expect(row?.outcome).toContain("3 commits");
});

test("the generic restart placeholder still yields the ordinary branch-gone verdict", async () => {
  const id = orphanedRun(
    "placeholder",
    "the server restarted while this was running — nobody was left to record how it ended",
  );
  setGitHook(async () => ({ ok: false, out: "" }));

  await settleAbandoned();

  const row = Work.runs(50).find((r) => r.id === id);
  expect(row?.state).toBe("empty");
  expect(row?.outcome).toContain("branch it worked on (feat/placeholder) is gone");
  expect(row?.outcome).not.toContain("nobody was left to record how it ended");
});
