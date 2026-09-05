/**
 * THE FENCE HAS TO SURVIVE A RESTART, or the deputy has no way back.
 *
 * Measured on the real app after a night of reinstalls: the fence resolved to
 * nothing, the deputy declined every task with "it has nowhere to work", and
 * the screen read `MAY CUT IN: agentglass-understudy · 0 checkouts`. Picking a
 * checkout in the UI did not help across a relaunch, and this machine
 * relaunches a dozen times a day.
 *
 * TWO faults, and the first one is why the first version of this test was
 * worthless: it read the SOURCE TEXT of the resolver for a function name and
 * restarted nothing, so it passed happily over a setting that was being erased
 * from disk. What follows drives the store instead.
 *
 *  1. `load()` rebuilt the cache from eight keys while `Store` has eleven, so
 *     `openProject`, `judge` and `proposeScope` were read off disk and dropped
 *     — and the next `save()` wrote the truncated object back. A person's pick
 *     was erased by the first unrelated setting write after it.
 *  2. The resolver only knew the checkouts telemetry had seen and the one the
 *     server process runs from, both empty on an installed app relaunched from
 *     outside a checkout, and the `Pick a checkout` control offers a list built
 *     from that same empty discovery — a closed loop with no way out from
 *     inside the application.
 */
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as U from "../src/understudy.ts";

let store = "";

beforeEach(() => {
  store = join(mkdtempSync(join(tmpdir(), "agx-fence-restart-")), "understudy.json");
  U.__setUnderstudyStorePath(store);
});

/** What a relaunch does: the file stays, everything in memory goes. */
function relaunch(): void {
  U.__setUnderstudyStorePath(store);
}

test("the checkout a person picked is still picked after a restart", () => {
  U.setOpenProject("agentglass-understudy", ["/home/someone/code/agentglass-understudy"]);
  expect(U.openProjectName()).toBe("agentglass-understudy");

  relaunch();
  expect(U.openProjectName(), "the pick did not survive the relaunch").toBe("agentglass-understudy");
});

test("and an unrelated setting write does not erase it from the file", () => {
  U.setOpenProject("agentglass-understudy", ["/home/someone/code/agentglass-understudy"]);
  /* Any other setting. This is the one that made the loss silent: the pick was
     not lost when it was made, it was lost the next time something else was
     saved. */
  U.setJudge(false);

  relaunch();
  expect(U.openProjectName()).toBe("agentglass-understudy");
  expect(existsSync(store)).toBe(true);
  const onDisk = JSON.parse(readFileSync(store, "utf8")) as Record<string, unknown>;
  expect(onDisk.openProject, "the file lost the pick on an unrelated write").toBe("agentglass-understudy");
});

test("the other two deliberate settings survive it too", () => {
  U.setJudge(true);
  U.setProposeScope("everywhere");
  relaunch();
  // Both are decisions somebody took on purpose — whether it may ask a model,
  // and how wide it may propose. A normaliser that drops them silently reverts
  // a person's answer to a question they were asked once.
  expect(U.judgeEnabled()).toBe(true);
  expect(U.proposeScope()).toBe("everywhere");
});

test("a fence name that would match everything is refused on the way IN, not only when set", () => {
  /* A value written before the guard existed, or edited into the file by hand.
     It is read as "nothing open", which is the closed direction: no checkout at
     all beats every checkout on the machine. */
  Bun.write(store, JSON.stringify({ enabled: true, openProject: "/" }));
  relaunch();
  expect(U.openProjectName()).not.toBe("/");
});
