/*
 * WHILE A LOOP IS IN A DIRECTORY, NOTHING SWEEPS IT.
 *
 * Three runs died of `ENOENT … posix_spawn '/home/…/bun'` in one afternoon,
 * with 102 MB of `bun` sitting exactly where the message said it was not. What
 * was gone was the checkout, and it went in a single watchdog tick:
 *
 *   1. The agent's tmux window is gone — TRUE, an agent exits the moment it
 *      has said its last word — so `sweepVanishedRuns` ends the row `failed`.
 *   2. `sweepEmptyWorktrees` now sees an ENDED row with no commits, and
 *      removes the directory.
 *   3. The loop, still in there running the suite the work has to pass, spawns
 *      into nothing.
 *
 * The run table cannot answer this: between the agent leaving and the verdict
 * being written the row is legitimately not `running`. Only the loop knows,
 * so the loop says so.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/db.ts";
import * as Work from "../src/understudy-work.ts";
import {
  sweepEmptyWorktrees, sweepVanishedRuns, setGitHook, setAliveHook, setBusyHook, VANISHED_GRACE_MS,
} from "../src/understudy-watchdog.ts";

const REPO = "/tmp/understudy-busy-probe";
let worktree: string;

beforeEach(() => {
  db.exec("DELETE FROM understudy_work");
  worktree = mkdtempSync(join(tmpdir(), "understudy-busy-"));
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "status") return { ok: true, out: "" };
    return { ok: true, out: "" };
  });
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
  setBusyHook(null);
  setAliveHook(null);
  setGitHook(async () => ({ ok: true, out: "" }));
});

function runIn(state: "running" | "failed") {
  const item = { source: "asked", id: "asked:busy", title: "a task", detail: "", repo: REPO, weight: 1 };
  const id = Work.beginRun({ shiftId: 1, item, repo: REPO, worktree, branch: "feat/busy" })!;
  if (state === "failed") Work.finishRun(id, "failed", "its window closed");
  return id;
}

test("an ended row whose directory a loop is still in is not swept", async () => {
  /* This is the exact row the chain produced: ended, no commits, clean — and
     a live process inside it. */
  runIn("failed");
  let removed = false;
  setGitHook(async (args) => {
    if (args[0] === "rev-list") return { ok: true, out: "0\n" };
    if (args[0] === "status") return { ok: true, out: "" };
    if (args[0] === "worktree" && args[1] === "remove") { removed = true; return { ok: true, out: "" }; }
    return { ok: true, out: "" };
  });
  setBusyHook((p) => p === worktree);

  expect(await sweepEmptyWorktrees()).toEqual([]);
  expect(removed, "the loop is standing in it").toBe(false);

  /* And when the loop steps out, the same row is swept as before. */
  setBusyHook(() => false);
  const swept = await sweepEmptyWorktrees();
  expect(swept.length).toBe(1);
  expect(removed).toBe(true);
});

test("a run whose window is gone is left alone while its loop is still working", async () => {
  /* The first domino. The window really has closed — the sweep is right about
     that and wrong about what it means. */
  const id = runIn("running");
  setAliveHook(async () => false);
  setBusyHook((p) => p === worktree);

  const gone = await sweepVanishedRuns(Date.now() + VANISHED_GRACE_MS + 1_000);
  expect(gone).toEqual([]);
  expect(Work.runs(5).find((r) => r.id === id)?.state, "the loop writes the verdict, not the sweep").toBe("running");
});

test("and a run nobody is working on is still ended when its window goes", async () => {
  /* The reason the sweep exists: a row left `running` by a restart used to sit
     there for an hour while the install refused and the screen said busy. */
  const id = runIn("running");
  setAliveHook(async () => false);
  setBusyHook(() => false);

  const gone = await sweepVanishedRuns(Date.now() + VANISHED_GRACE_MS + 1_000);
  expect(gone.length).toBe(1);
  expect(Work.runs(5).find((r) => r.id === id)?.state).not.toBe("running");
});

test("a busy hook that throws is read as busy", async () => {
  /* Fails closed, like every other reader here: declaring a live agent dead is
     the expensive mistake. */
  runIn("failed");
  setBusyHook(() => { throw new Error("no idea"); });
  expect(await sweepEmptyWorktrees()).toEqual([]);
});
