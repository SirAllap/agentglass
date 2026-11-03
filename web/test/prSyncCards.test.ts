import { describe, expect, test } from "bun:test";
import { syncCardView, SYNC_DONE_MS, type SyncPhase } from "../src/lib/prSyncCards.ts";
import { SYNC_AT_ONCE, confirmOff, mergeResult, retryItems, syncTally, withoutResults } from "../src/lib/prSyncLane.ts";

/* Shaped like a row on the reported board: acme/orbit, four of them behind. */
const pr = { number: 1042, headRefName: "orbit/ORBIT-1042", baseRefName: "main" };
const at = (phase: SyncPhase, detail?: string) => syncCardView({ phase, detail }, pr)!;

describe("a card in a lane's Sync says where that row stands", () => {
  test("no step: the card keeps its own Update, its own count and its own edge", () => {
    expect(syncCardView(undefined, pr)).toBeNull();
    expect(syncCardView(null, pr)).toBeNull();
  });

  test("queued: a quiet Waiting mark, and the press is off", () => {
    const v = at("queued");
    expect(v.action.label).toBe("Waiting");
    expect(v.action.disabled).toBe(true);
    expect(v.action.pending).toBe(false);
    expect(v.action.mark).toBe("waiting");
    expect(v.action.retry).toBe(false);
    expect(v.running).toBe(false);
  });

  test("queued says why in words: the run is three at a time and this one has not started", () => {
    expect(at("queued").action.title).toContain(`${SYNC_AT_ONCE} at a time`);
    expect(at("queued").action.title).toContain("has not started");
  });

  test("syncing: the spinner in the Update slot, the behind chip says what is happening, and the card wears its accent edge", () => {
    const v = at("syncing");
    expect(v.action.pending).toBe(true);
    expect(v.action.disabled).toBe(true);
    expect(v.action.label).not.toContain("Update");
    expect(v.action.title).toContain("main into orbit/ORBIT-1042");
    expect(v.running).toBe(true);
    expect(v.branch).toEqual({ tone: "run", word: "Merging…", title: expect.stringContaining("behind it was before this run") });
  });

  test("done: a success mark, then the card's own count comes back", () => {
    const v = at("done", "Merged · local copy updated");
    expect(v.action.mark).toBe("done");
    expect(v.action.disabled).toBe(true);
    expect(v.running).toBe(false);
    /* Nothing of the job stands between the card and its re-read chip. */
    expect(v.branch).toBeNull();
    expect(v.action.title).toContain("Merged · local copy updated");
  });

  test("the success mark is brief", () => {
    expect(SYNC_DONE_MS).toBeGreaterThan(0);
    expect(SYNC_DONE_MS).toBeLessThan(5000);
  });

  test("failed: a warning mark, the server's reason on hover, and the same Update pressable again", () => {
    const v = at("failed", "refused: not caught up");
    expect(v.action.mark).toBe("failed");
    expect(v.action.disabled).toBe(false);
    expect(v.action.retry).toBe(true);
    expect(v.action.title).toContain("refused: not caught up");
    /* A refused merge moved nothing: the count it shows is still true. */
    expect(v.branch).toBeNull();
  });

  test("a failure with no sentence still explains itself", () => {
    expect(at("failed").action.title).toBeTruthy();
    expect(at("failed").action.title).not.toContain("undefined");
  });

  test("exactly the queued and the syncing one cannot be pressed, and both say why", () => {
    const phases: SyncPhase[] = ["queued", "syncing", "done", "failed"];
    for (const phase of phases) {
      const v = at(phase);
      expect(v.action.title.length).toBeGreaterThan(20);
      if (phase === "queued" || phase === "syncing") expect(v.action.disabled).toBe(true);
      /* A mark with no words beside it is a card that swapped one mystery for another. */
      expect(v.action.label.length).toBeGreaterThan(0);
    }
  });

  test("no step reuses the card's own Update label: the slot never lies about what it will do", () => {
    for (const phase of ["queued", "syncing", "done", "failed"] as SyncPhase[]) {
      expect(at(phase).action.label).not.toContain("Update ·");
    }
  });
});

/* No renderer in this project: the wiring is asserted against the source, sliced
   by the block that owns it, the way test/pr-card-footer-one-bar.test.ts does. */
const card = await Bun.file(new URL("../src/components/PrCard.tsx", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const lane = await Bun.file(new URL("../src/components/PrLaneSync.tsx", import.meta.url)).text();

describe("the cards read the step the popover reports", () => {
  test("the board hands every card its own step, and the retry to the popover's owner", () => {
    expect(board).toContain("onStep={noteSync}");
    expect(board).toContain("sync={syncSteps.get(p.number)} onSyncRetry={() => retrySync(p, l.id)}");
    expect(board).toContain("onRetryReady={holdLaneRetry}");
    const retrySync = board.slice(board.indexOf("const retrySync"), board.indexOf("}, [noteSync, onAct]);"));
    expect(retrySync).toContain("laneRetry.current.get(lane)");
    expect(retrySync).toContain("void owner(p.number)");
  });
  test("the card turns its Update press off exactly as the view says, and wears the running edge", () => {
    expect(card).toContain("disabled={sv.action.disabled || locked || working}");
    expect(card).toContain('data-sync={sv?.running ? "running" : undefined}');
  });
  test("the menu gets the same step, so it cannot offer the press the footer turned off", () => {
    expect(board).toMatch(/sync: syncSteps\.get\(p\.number\),/);
  });
  test("a done step is cleared after the flash, and a new step cancels the old timer", () => {
    const note = board.slice(board.indexOf("const noteSync"), board.indexOf("}, []);", board.indexOf("const noteSync")));
    expect(note).toContain("window.clearTimeout(was)");
    expect(note).toContain("SYNC_DONE_MS");
  });
});

describe("a card's Retry is the popover's press, not a second one", () => {
  test("the card presses the owner and sends no Update of its own", () => {
    const press = card.split("\n").find((l) => l.includes("sv.action.retry ? stop("))!;
    expect(press).toContain("props.onSyncRetry?.()");
    expect(press).not.toContain('onAct("update")');
  });
  test("the popover registers that Retry while mounted, and folds its answer into its own results", () => {
    expect(lane).toContain("onRetryReady?.(lane.id, retryOne)");
    const retry = lane.slice(lane.indexOf("const retryOne"), lane.indexOf("}, [rows, behindKnown, onSyncOne, onStep]);"));
    expect(retry).toContain("runLaneSync([it]");
    expect(retry).toContain("setResults((prev) => mergeResult(prev ?? [], r))");
  });
  test("the Retry never looks the row up in the live plan, which a refused row has already left", () => {
    const retry = lane.slice(lane.indexOf("const retryOne"), lane.indexOf("}, [rows, behindKnown, onSyncOne, onStep]);"));
    expect(retry).toContain("retryFromRow(row, behindKnown)");
    expect(retry).not.toContain("plan.eligible");
  });
  test("with no row to send there is nothing to retry, and the card gets its own controls back", () => {
    const retry = lane.slice(lane.indexOf("const retryOne"), lane.indexOf("}, [rows, behindKnown, onSyncOne, onStep]);"));
    expect(retry).toContain("if (!it || !row) { onStep?.(n, null); return; }");
  });
  test("a Retry takes its number out of the results, as a new press does", () => {
    const before = [
      { number: 1042, title: "Retry the relay handshake", status: "failed" as const, detail: "GitHub refused it" },
      { number: 1043, title: "Drop the unused relay", status: "done" as const, detail: "Merged" },
    ];
    expect(syncTally(before, 0).text).toContain("#1042");
    const after = withoutResults(before, [{ number: 1042 }])!;
    expect(after.map((r) => r.number)).toEqual([1043]);
    expect(syncTally(after, 0).ok).toBe(true);
    expect(withoutResults(null, [{ number: 1042 }])).toBeNull();
    const retry = lane.slice(lane.indexOf("const retryOne"), lane.indexOf("}, [rows, behindKnown, onSyncOne, onStep]);"));
    expect(retry).toContain("withoutResults(prev, [it])");
  });
  test("the list's confirm is off while a card's Retry is on its way, so it cannot be refused", () => {
    const items = [{ number: 1042, title: "Retry the relay handshake", behind: 3, headRefName: "orbit/ORBIT-1042" }];
    expect(confirmOff({ running: false, retrying: null, items, ok: false })).toBe(false);
    expect(confirmOff({ running: false, retrying: 1042, items, ok: false })).toBe(true);
    expect(confirmOff({ running: true, retrying: null, items, ok: false })).toBe(true);
    expect(confirmOff({ running: false, retrying: null, items: [], ok: false })).toBe(true);
    expect(confirmOff({ running: false, retrying: null, items, ok: true })).toBe(true);
    const at = lane.indexOf("disabled={confirmOff(");
    expect(at).toBeGreaterThan(0);
    expect(lane.slice(at, lane.indexOf("/>", at))).toContain("retrying,");
  });
  test("after that answer lands, re-opening the list does not offer the branch again", () => {
    const plan = {
      eligible: [
        { number: 1042, title: "Retry the relay handshake", behind: 4, headRefName: "orbit/ORBIT-1042" },
        { number: 1043, title: "Drop the unused relay", behind: 2, headRefName: "orbit/ORBIT-1043" },
      ],
      skipped: [],
    };
    const press = [
      { number: 1042, title: "Retry the relay handshake", status: "failed" as const, detail: "GitHub refused it" },
      { number: 1043, title: "Drop the unused relay", status: "done" as const, detail: "Merged" },
    ];
    expect(retryItems(plan, press).map((i) => i.number)).toEqual([1042]);
    const after = mergeResult(press, { number: 1042, title: "Retry the relay handshake", status: "done", detail: "Merged" });
    expect(retryItems(plan, after)).toEqual([]);
    expect(syncTally(after, 0).ok).toBe(true);
  });
});
