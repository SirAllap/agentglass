import { describe, expect, test } from "bun:test";
import { confirmLabel, confirmOff, laneSyncPlan, mergeResult, retryFromRow, retryItems, retryRow, runLaneSync, serialRetry, syncTally, syncVerdict, SYNC_AT_ONCE, SYNC_REASON, type SyncFacts, type SyncPlanRow } from "../src/lib/prSyncLane.ts";
import { secondaryFor, updateGate } from "../src/lib/prCardView.ts";

const facts = (o: Partial<SyncFacts> = {}): SyncFacts => ({
  author: "acme", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
  baseRefName: "main", headRefName: "orbit/ORBIT-1042", behind: 3, ...o,
});
const viewer = "acme";

describe("who a lane sync may touch", () => {
  test("an ordinary pull request of mine, behind its base, is eligible", () => {
    expect(syncVerdict(facts(), { viewer })).toEqual({ eligible: true, reason: null });
  });

  test("somebody else's is left alone", () => {
    expect(syncVerdict(facts({ author: "orbit" }), { viewer }).reason).toBe("someone-else");
  });

  test("an empty viewer touches nobody: 'not mine' is not 'everybody's'", () => {
    expect(syncVerdict(facts(), { viewer: "" }).reason).toBe("someone-else");
  });

  test("a finished pull request is left alone even when every other fact says yes", () => {
    expect(syncVerdict(facts({ state: "MERGED" }), { viewer }).reason).toBe("finished");
  });

  test("a draft is left alone", () => {
    expect(syncVerdict(facts({ isDraft: true }), { viewer }).reason).toBe("draft");
  });

  test("a read-only token is left alone", () => {
    expect(syncVerdict(facts(), { viewer, readOnly: true }).reason).toBe("read-only");
  });

  test("a conflicting branch is left alone", () => {
    expect(syncVerdict(facts({ mergeable: "CONFLICTING" }), { viewer }).reason).toBe("conflict");
  });

  test("GitHub still computing mergeability is not a refusal: the card offers Update", () => {
    expect(syncVerdict(facts({ mergeable: "UNKNOWN" }), { viewer })).toEqual({ eligible: true, reason: null });
  });

  test("one already syncing is not started twice", () => {
    expect(syncVerdict(facts(), { viewer, syncing: true }).reason).toBe("syncing");
  });

  test("a row mid-sync says so even though its behind count was just forgotten", () => {
    expect(syncVerdict(facts({ behind: null }), { viewer, syncing: true }).reason).toBe("syncing");
  });

  test("nothing to be behind of is up to date", () => {
    expect(syncVerdict(facts({ behind: 0 }), { viewer }).reason).toBe("up-to-date");
  });

  test("a base we have not compared against yet is not assumed up to date", () => {
    expect(syncVerdict(facts({ behind: null }), { viewer }).reason).toBe("behind-unknown");
  });
});

describe("the lane's count is the number of cards whose Update is enabled", () => {
  /* Four rows shaped like the reported board: mine, open, not a draft, on
     master, 6/21/21/21 behind. Two still carry GitHub's UNKNOWN because the
     cached list predates the read that made the cards show Update · N. */
  const row = (n: number, behind: number, mergeable: string): SyncPlanRow => ({
    p: { number: n, title: `ORBIT-${1040 + n}`, author: viewer, state: "OPEN", isDraft: false, mergeable, baseRefName: "master", headRefName: `orbit/${n}` } as SyncPlanRow["p"],
    filed: { lane: "land" },
  });
  const behindOf: Record<number, number> = { 1: 6, 2: 21, 3: 21, 4: 21 };
  const rows = [row(1, 6, "MERGEABLE"), row(2, 21, "UNKNOWN"), row(3, 21, "MERGEABLE"), row(4, 21, "UNKNOWN")];

  test("four cards showing Update · N give Sync 4, not Sync 2", () => {
    const plan = laneSyncPlan("land", rows, { viewer, behindOf: (n) => behindOf[n]! });
    expect(plan.eligible.map((i) => i.number)).toEqual([1, 2, 3, 4]);
    expect(plan.skipped).toEqual([]);
  });

  test("each of those cards draws Update, from the same two facts", () => {
    for (const r of rows) {
      const gate = updateGate(r.p, behindOf[r.p.number]!, false);
      expect(gate).toEqual({ offered: true, reason: null });
      expect(secondaryFor(r.p, "open", behindOf[r.p.number]!, false, "open").label).toBe(`Update · ${behindOf[r.p.number]}`);
    }
  });

  test("no fact pair makes the lane refuse what the card's gate offers, or the reverse", () => {
    const merges = ["MERGEABLE", "UNKNOWN", "CONFLICTING"];
    const behinds = [null, 0, 6, 21];
    for (const mergeable of merges) for (const behind of behinds) {
      const f = facts({ mergeable, behind });
      const gate = updateGate(f, behind, false);
      expect(syncVerdict(f, { viewer }).eligible).toBe(gate.offered);
    }
  });
});

describe("the card's Update slot and the lane's count ask the same question", () => {
  test("every refusal the card draws is a refusal here", () => {
    const cases: { f: SyncFacts; readOnly: boolean }[] = [
      { f: facts({ isDraft: true }), readOnly: false },
      { f: facts({ mergeable: "CONFLICTING" }), readOnly: false },
      { f: facts({ behind: 0 }), readOnly: false },
      { f: facts(), readOnly: true },
    ];
    for (const c of cases) {
      expect(syncVerdict(c.f, { viewer, readOnly: c.readOnly }).eligible).toBe(false);
      expect(updateGate(c.f, c.f.behind, c.readOnly).offered).toBe(false);
    }
  });

  test("the card still draws Update when the lane counts it", () => {
    const slot = secondaryFor(facts(), "open", 3, false, "open");
    expect(slot.id).toBe("update");
    expect(slot.label).toBe("Update · 3");
  });
});

describe("a lane sync is that lane and nothing else", () => {
  const row = (n: number, lane: SyncPlanRow["filed"]["lane"], o: Partial<SyncFacts> = {}): SyncPlanRow => ({
    p: { number: n, title: `ORBIT-${1000 + n}`, author: "acme", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", baseRefName: "main", headRefName: `orbit/${n}`, ...o } as SyncPlanRow["p"],
    filed: { lane },
  });

  test("a row filed in another lane is neither counted nor reported", () => {
    const rows = [row(1, "land"), row(2, "blocked"), row(3, "others"), row(4, "flight")];
    const plan = laneSyncPlan("land", rows, { viewer, behindOf: () => 4 });
    expect(plan.eligible.map((i) => i.number)).toEqual([1]);
    expect(plan.skipped).toEqual([]);
  });

  test("a whole board asked for one lane can never sync the others", () => {
    const rows = [row(1, "land"), row(2, "blocked"), row(3, "blocked")];
    const plan = laneSyncPlan("land", rows, { viewer, behindOf: () => 2 });
    expect(plan.eligible.map((i) => i.number)).toEqual([1]);
  });

  test("the skipped ones carry their own reason, and keep lane order", () => {
    const rows = [row(1, "land", { isDraft: true }), row(2, "land"), row(3, "land", { mergeable: "CONFLICTING" }), row(4, "land", { behind: 0 })];
    const plan = laneSyncPlan("land", rows, { viewer, behindOf: (n) => (n === 4 ? 0 : 3) });
    expect(plan.eligible.map((i) => i.number)).toEqual([2]);
    expect(plan.skipped).toEqual([
      { number: 1, title: "ORBIT-1001", reason: "draft" },
      { number: 3, title: "ORBIT-1003", reason: "conflict" },
      { number: 4, title: "ORBIT-1004", reason: "up-to-date" },
    ]);
  });

  test("one the card is already updating stays out of the plan", () => {
    const rows = [row(1, "land"), row(2, "land")];
    const plan = laneSyncPlan("land", rows, { viewer, syncing: new Set([2]), behindOf: () => 3 });
    expect(plan.eligible.map((i) => i.number)).toEqual([1]);
    expect(plan.skipped).toEqual([{ number: 2, title: "ORBIT-1002", reason: "syncing" }]);
  });

  test("a row nobody has measured yet says so in the left-alone list, not 'up to date'", () => {
    const plan = laneSyncPlan("land", [row(1, "land")], { viewer, behindOf: () => null });
    expect(plan.eligible).toEqual([]);
    expect(plan.skipped).toEqual([{ number: 1, title: "ORBIT-1001", reason: "behind-unknown" }]);
    expect(SYNC_REASON[plan.skipped[0]!.reason]).toBe("behind unknown");
  });

  test("no left-alone reason calls a card 'still checking' while its Update is on", () => {
    expect(SYNC_REASON).not.toHaveProperty("checking");
    for (const r of Object.values(SYNC_REASON)) expect(r).toBeTruthy();
  });
});

describe("one failing does not stop the rest", () => {
  test("every item is tried, a rejection is a failed row, and the summary names it", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, title: `ORBIT-${1000 + n}` }));
    const tried: number[] = [];
    const results = await runLaneSync(items, async (n) => {
      tried.push(n);
      if (n === 3) throw new Error("gh pr update-branch exited 1");
      if (n === 5) return { ok: false, detail: "refused: not caught up" };
      return { ok: true, detail: "merged" };
    });
    expect(tried.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(results.map((r) => r.status)).toEqual(["done", "done", "failed", "done", "failed", "done", "done"]);
    const tally = syncTally(results, 2);
    expect(tally.ok).toBe(false);
    expect(tally.text).toBe("5 synced · 2 failed (#3, #5) · 2 left alone");
    expect(tally.failed).toBe(2);
  });

  test("a clean run says what it did in one sentence", () => {
    const tally = syncTally([
      { number: 1, title: "a", status: "done", detail: "merged" },
      { number: 2, title: "b", status: "done", detail: "merged" },
    ], 3);
    expect(tally.ok).toBe(true);
    expect(tally.text).toBe("Synced 2 · 3 left alone");
  });

  test("never more than three in flight", async () => {
    let live = 0, peak = 0;
    await runLaneSync([1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, title: `#${n}` })), async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      live--;
      return { ok: true };
    });
    expect(peak).toBe(3);
  });

  test("each answer is reported as it lands, so the run does not read as hung", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const seen: number[] = [];
    const all = runLaneSync([1, 2, 3].map((n) => ({ number: n, title: `#${n}` })), async (n) => {
      if (n === 1) await held;
      return { ok: true };
    }, (r) => seen.push(r.number));
    await new Promise((r) => setTimeout(r, 5));
    expect([...seen].sort()).toEqual([2, 3]);
    release();
    await all;
    expect(seen.length).toBe(3);
  });
});

describe("retry runs the failed ones and nothing else", () => {
  const plan = {
    eligible: [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `ORBIT-${1000 + n}`, behind: 2, headRefName: `orbit/${n}` })),
    skipped: [],
  };
  const results = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `ORBIT-${1000 + n}`, status: n === 3 ? "failed" as const : "done" as const, detail: "" }));

  test("only #3 failed, so only #3 is sent again", () => {
    expect(retryItems(plan, results).map((i) => i.number)).toEqual([3]);
  });

  test("a retry that lands keeps the first press's successes in the tally", () => {
    const merged = mergeResult(results, { number: 3, title: "ORBIT-1003", status: "done", detail: "merged" });
    const tally = syncTally(merged, 0);
    expect(tally.ok).toBe(true);
    expect(tally.done).toBe(5);
    expect(tally.text).toBe("Synced 5");
  });
});

describe("the lane takes the card's own flight", () => {
  /* Read inside each test: the test tsconfig has no top-level await. */
  const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

  test("a lane sync enters and leaves the same per-pull-request flight as the card's Update", async () => {
    const panel = await read("../src/components/PrPanel.tsx");
    const at = panel.indexOf("const syncOne = useCallback(");
    expect(at).toBeGreaterThan(0);
    const body = panel.slice(at, panel.indexOf("const doUpdateBranch = ", at));
    expect(body).toContain("enterFlight(updatingRef.current,");
    expect(body).toContain("leaveFlight(updatingRef.current,");
    // A duplicate is refused here, not sent to GitHub as a second `gh pr update-branch`.
    expect(body).toContain("if (!flying)");
  });

  test("the board hands the lane both guards its verdict reads, and never a queued comparison", async () => {
    const board = await read("../src/components/TriageBoard.tsx");
    const at = board.indexOf("<PrLaneSync ");
    expect(at).toBeGreaterThan(0);
    const block = board.slice(at, board.indexOf("/>", at));
    expect(block).toContain("syncing={syncing}");
    expect(block).toContain("readOnly={readOnly}");
    expect(block).toContain("behindKnown={");
    expect(block).not.toContain("behindOf(");
  });

  test("a refused write starts no hold, and a read that answered nothing ends one", async () => {
    const panel = await read("../src/components/PrPanel.tsx");
    const at = panel.indexOf("const reReadAfterWrite = useCallback(");
    expect(at).toBeGreaterThan(0);
    const loop = panel.slice(at, panel.indexOf("const syncOne = useCallback(", at));
    expect(loop).toContain("if (!got.ok || !got.detail) { clearRefreshing(");
    expect(loop).toContain("refreshMoved(headBefore");
    const upd = panel.slice(panel.indexOf("const doUpdateBranch = "), panel.indexOf("const [unstickShown"));
    expect(upd).toContain("if (r.ok) reReadAfterWrite(num,");
    // `.finally` runs for a refusal and for a throw; the hold is only for a write GitHub took.
    expect(upd.slice(upd.indexOf(".finally("))).not.toContain("reReadAfterWrite");
  });
});

describe("a click inside the sync list never reaches the lane header", () => {
  const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
  // The list is a portal, and React still bubbles its events to the header it came from, where a click folds the lane.
  test("the dialog root stops the click, and the skipped reasons are listed once", async () => {
    const src = await read("../src/components/PrLaneSync.tsx");
    const at = src.indexOf('role="dialog"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("onClick={(e) => e.stopPropagation()}");
    expect(src).toContain("new Set(plan.skipped.map(");
  });
});

describe("a worker says which row it picked up", () => {
  test("a start is reported before that row's own answer, and only three are out at once", async () => {
    let live = 0, started = 0;
    const order: string[] = [];
    await runLaneSync([1, 2, 3, 4, 5].map((n) => ({ number: n, title: `ORBIT-${1000 + n}` })), async (n) => {
      live++;
      await new Promise((r) => setTimeout(r, 2));
      live--;
      order.push(`done ${n}`);
      return { ok: true };
    }, (r) => order.push(`answer ${r.number}`), (n) => {
      started++;
      expect(live).toBeLessThan(SYNC_AT_ONCE);
      order.push(`start ${n}`);
    });
    expect(started).toBe(5);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(order.indexOf(`start ${n}`)).toBeLessThan(order.indexOf(`answer ${n}`));
    }
  });

  test("a start never comes after its own answer", async () => {
    const seen: string[] = [];
    await runLaneSync([{ number: 7, title: "ORBIT-1042" }], async () => ({ ok: false, detail: "refused" }),
      (r) => seen.push(`answer ${r.number}`), (n) => seen.push(`start ${n}`));
    expect(seen).toEqual(["start 7", "answer 7"]);
  });
});

describe("a card's Retry builds its item from the row it has", () => {
  const refused: SyncPlanRow = {
    p: {
      number: 1041, title: "Retry the relay handshake", author: "acme", state: "OPEN", isDraft: false,
      mergeable: "CONFLICTING", baseRefName: "main", headRefName: "orbit/ORBIT-1041",
    },
    filed: { lane: "land" },
  };

  test("the row GitHub just refused has left the plan and still carries what the press needs", () => {
    expect(laneSyncPlan("land", [refused], { viewer, behindOf: () => 4 }).eligible).toEqual([]);
    expect(retryFromRow(refused, () => 4)).toEqual({
      number: 1041, title: "Retry the relay handshake", behind: 4, headRefName: "orbit/ORBIT-1041",
    });
  });

  test("a row nobody has compared yet still retries: its count is the list's badge, not a refusal", () => {
    expect(retryFromRow(refused, () => null)!.behind).toBe(0);
  });

  test("no row is nothing to retry", () => {
    expect(retryFromRow(undefined, () => 3)).toBeNull();
  });
});

describe("the confirm's sentence never counts a failed row it cannot send", () => {
  test("a refused row that has left the plan is retried on its card, not as 'the 0 failed'", () => {
    const refused = { number: 1041, title: "Retry the relay handshake", behind: 3, headRefName: "orbit/ORBIT-1041" };
    const press = [{ number: 1041, title: refused.title, status: "failed" as const, detail: "GitHub refused it" }];
    const tally = syncTally(press, 1);
    expect(tally.text).toBe("0 synced · 1 failed (#1041) · 1 left alone");
    expect(retryItems({ eligible: [], skipped: [] }, press)).toEqual([]);
    expect(confirmLabel(tally, [], 0)).toBe("Retry on its card");
    expect(confirmLabel(tally, [refused], 1)).toBe("Retry the failed one");
    expect(confirmLabel(tally, [refused, { ...refused, number: 1042 }], 2)).toBe("Retry the 2 failed");
    expect(confirmLabel(syncTally([], 2), [refused], 2)).toBe("Sync 2");
  });
});

describe("a queued card Retry is in the list, and the confirm stays off", () => {
  test("the row behind another says it is waiting, and the confirm cannot send it twice", async () => {
    expect(retryRow(1042, new Set([1043]), 1042)).toBe("merging");
    expect(retryRow(1042, new Set([1043]), 1043)).toBe("waiting");
    expect(retryRow(null, new Set(), 1042)).toBeNull();
    const items = [{ number: 1043, title: "Drop the unused relay", behind: 2, headRefName: "orbit/ORBIT-1043" }];
    /* The commit between two presses: nothing is running yet, one is queued. */
    expect(confirmOff({ running: false, retrying: null, queued: 1, items, ok: false })).toBe(true);
    expect(confirmOff({ running: false, retrying: null, items, ok: false })).toBe(false);
    const lane = await Bun.file(new URL("../src/components/PrLaneSync.tsx", import.meta.url)).text();
    expect(lane).toContain("retryRow(retrying, queued,");
    expect(lane).toContain("queued: queued.size");
  });
});

describe("a second card's Retry waits its turn instead of vanishing", () => {
  test("both are sent, one at a time, and the second says it is waiting", async () => {
    const press = serialRetry();
    const order: string[] = [];
    const waited: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const one = press(1042, async () => { order.push("send 1042"); await gate; order.push("answer 1042"); })!;
    const two = press(1043, async () => { order.push("send 1043"); order.push("answer 1043"); }, () => waited.push(1043))!;
    await Promise.resolve();
    expect(order).toEqual(["send 1042"]);
    expect(waited).toEqual([1043]);
    release();
    await Promise.all([one, two]);
    expect(order).toEqual(["send 1042", "answer 1042", "send 1043", "answer 1043"]);
  });

  test("the same number pressed again while it is out is one send, and the second press is refused", async () => {
    const press = serialRetry();
    const sent: number[] = [];
    const one = press(1042, async () => { sent.push(1042); await Promise.resolve(); });
    expect(press(1042, async () => { sent.push(1042); })).toBeNull();
    await one;
    expect(sent).toEqual([1042]);
  });

  test("a press that throws does not keep the ones behind it waiting", async () => {
    const press = serialRetry();
    const seen: number[] = [];
    const one = press(1042, async () => { seen.push(1042); throw new Error("refused"); });
    const two = press(1043, async () => { seen.push(1043); });
    await Promise.all([one!.catch(() => {}), two]);
    expect(seen).toEqual([1042, 1043]);
    const again = press(1042, async () => { seen.push(1042); });
    await again;
    expect(seen).toEqual([1042, 1043, 1042]);
  });
});
