import { describe, expect, test } from "bun:test";
import { autoRunOf, autoWords, barFor, cleanOffered, failedWords, failureLine, leftoverLine, offerFor, onDisk, stateOfPlan, stateOfRemaining, stateOfRow, tooltipOf, WAITING_LINE, WAITING_TITLE, type AutoRun, type LeftoverState, type Surface } from "../src/lib/leftovers.ts";
import { autoEntryFor, type AutoEntry } from "../src/lib/housekeeping.ts";
import type { Plan, PlanItem } from "../src/lib/cleanupPr.ts";

const SURFACES: Surface[] = ["card", "closedRow", "panel", "lane"];
const item = (kind: string, bytes?: number): PlanItem => ({ id: `${kind}:x`, kind, target: "x", detail: "", bytes });
const plan = (items: PlanItem[]): Plan => ({
  id: "p", repo: "/w/orbit", pr: 77, title: "Retry queue", url: "", state: "MERGED", mergedAt: 1, notMerged: false,
  branch: "ORBIT-1042-retry-queue", slug: "ORBIT-1042", items, blocks: [], notes: [],
});
const GB = 1e9;

describe("a Clean up control exists only for an inventory with a real item, on every surface", () => {
  const cases: [string, LeftoverState | undefined][] = [
    ["empty plan", stateOfPlan(plan([]), false)],
    ["own bookkeeping only", stateOfPlan(plan([item("own-state"), item("worklog")]), false)],
    ["failed inventory", stateOfPlan(null, true)],
    ["failed row", stateOfRow({ pr: 1, unknown: true })],
    ["missing row", stateOfRow(undefined)],
    ["computing", stateOfPlan(null, false)],
    ["not asked yet", undefined],
  ];
  for (const [name, state] of cases) {
    for (const surface of SURFACES) {
      test(`${name} on ${surface}: no button`, () => expect(offerFor(state, surface).button).toBe(false));
    }
  }
  test("one real item gives the button, the size and the breakdown on every surface", () => {
    const s = stateOfPlan(plan([item("docker-image", 6.1 * GB), item("worktree", 222e6), item("own-state")]), false);
    for (const surface of SURFACES) {
      const o = offerFor(s, surface);
      expect(o.button).toBe(true);
      expect(o.chip).toBe("6.3 GB");
      expect(o.tooltip).toBe("Docker 6.1 GB · Worktree 222 MB");
    }
  });
  test("a row from the server with items gives the button; zero items gives none", () => {
    expect(offerFor(stateOfRow({ pr: 1, items: 2, bytes: 5 * GB, groups: [{ group: "docker", items: 2, bytes: 5 * GB }] }), "closedRow").button).toBe(true);
    expect(stateOfRow({ pr: 1, items: 0, bytes: 0, groups: [] })).toEqual({ kind: "none" });
  });
});

describe("what is drawn instead of a button", () => {
  test("computing is a skeleton on every surface", () => {
    for (const surface of SURFACES) expect(offerFor({ kind: "computing" }, surface)).toMatchObject({ skeleton: true, button: false, chip: null });
  });
  test("unknown is a muted chip with the reason, only on the panel", () => {
    const s: LeftoverState = { kind: "unknown", why: "git is not installed" };
    expect(offerFor(s, "panel")).toMatchObject({ chip: "Leftovers ?", muted: true, tooltip: "git is not installed", button: false });
    for (const surface of ["card", "closedRow", "lane"] as Surface[]) expect(offerFor(s, surface)).toMatchObject({ chip: null, muted: false });
  });
  test("nothing draws nothing", () => {
    expect(offerFor({ kind: "none" }, "closedRow")).toEqual({ button: false, chip: null, muted: false, tooltip: "", skeleton: false });
  });
  test("a group with no size is counted, not shown as 0 B", () => {
    expect(tooltipOf([{ group: "stashes", items: 2, bytes: 0 }])).toBe("Stashes 2 items");
  });
});

describe("the automatic cleanup's run, one datum two views", () => {
  const run = (over: Partial<AutoRun> = {}): AutoRun => ({ state: "cleaning", done: 6, total: 13, freed: 6.4 * GB, failed: 0, ...over });
  const bar = (o: { mode?: "off" | "ask" | "atMerge" | "auto"; run?: AutoRun | null; leftovers?: boolean }, surface: "panel" | "card" = "panel") =>
    barFor({ mode: o.mode ?? "auto", run: o.run === undefined ? run() : o.run, leftovers: o.leftovers ?? true }, surface);

  test("while it runs, the manual button is gone and the bar says the progress", () => {
    expect(bar({})).toMatchObject({ button: false, retry: false, tone: "run", text: "Cleaning \u00b7 6 of 13 \u00b7 6.4 GB freed" });
    expect(bar({}, "card").text).toBe("Cleaning \u00b7 6 of 13");
  });
  test("done says what it removed; the button comes back only for leftovers found afterwards", () => {
    const done = run({ state: "cleaned", done: 13 });
    expect(bar({ run: done, leftovers: false })).toMatchObject({ button: false, retry: false, tone: "ok", text: "Cleaned \u00b7 13 items \u00b7 6.4 GB" });
    expect(bar({ run: done, leftovers: false }, "card").text).toBe("Cleaned \u00b7 13 items");
    expect(bar({ run: done, leftovers: true }).button).toBe(true);
    expect(bar({ run: run({ state: "cleaned", done: 1 }), leftovers: false }).text).toBe("Cleaned \u00b7 1 item \u00b7 6.4 GB");
  });
  test("a failed run says why, and a teardown refusal names the way past it", () => {
    const entry = (items: { kind: string; status: "failed" | "done"; detail: string }[]) =>
      autoRunOf({ repo: "/r", pr: 1042, state: "failed", label: "", slug: "ORBIT-1042", title: "", reason: "", done: 0, total: 3, freed: 0, started_at: 1, ended_at: 2, items: items.map((i) => ({ target: "x", ...i })) })!;
    const td = entry([{ kind: "teardown-script", status: "failed", detail: "teardown failed (exit 1): \u001b[0;31mno env file\u001b[0m; worktree kept" }]);
    expect(autoWords(td, "panel").title).toContain(": teardown failed (exit 1): no env file; worktree kept.");
    expect(autoWords(td, "panel").title).toContain("untick the teardown");
    const other = entry([{ kind: "docker-image", status: "failed", detail: "image is being used by a container" }]);
    expect(autoWords(other, "panel").title).toBe("1 item could not be removed: image is being used by a container. Retry to run it again.");
  });
  test("failed items are named, with a retry where the button was", () => {
    const failed = run({ state: "failed", done: 11, failed: 2 });
    expect(bar({ run: failed })).toMatchObject({ button: false, retry: true, tone: "warn", text: "Cleaning failed \u00b7 2 items" });
    expect(bar({ run: failed }, "card").text).toBe("Cleaning failed \u00b7 2 items");
  });
  test("nothing to read yet, or Automatic off: the leftovers still offer the manual button", () => {
    expect(bar({ run: null })).toMatchObject({ button: true, retry: false, text: null, tone: null });
    expect(bar({ mode: "ask" })).toMatchObject({ button: true, retry: false, text: null });
    expect(bar({ mode: "off", run: null, leftovers: false }).button).toBe(false);
    expect(bar({ run: null, leftovers: false }).button).toBe(false);
  });
  test("the card's line is the run's, never \"No leftovers\", and a finished one with new leftovers says both", () => {
    expect(leftoverLine({ kind: "computing" }, false, run())).toMatchObject({ tone: "run", text: "Cleaning \u00b7 6 of 13" });
    expect(leftoverLine({ kind: "none" }, false)).toMatchObject({ tone: "none", text: "No leftovers" });
    expect(leftoverLine({ kind: "none" }, false, run({ state: "cleaned", done: 13 }))).toMatchObject({ tone: "none", text: "Cleaned \u00b7 13 items" });
    expect(leftoverLine({ kind: "some", items: 2, bytes: GB, groups: [{ group: "docker", items: 2, bytes: GB }] }, false, run({ state: "cleaned", done: 13 }))!.text).toBe("Leftovers: 2 items \u00b7 1.0 GB");
    expect(leftoverLine({ kind: "some", items: 2, bytes: GB, groups: [] }, false, run({ state: "failed", done: 11, failed: 2 }))).toMatchObject({ tone: "blocked", text: "Cleaning failed \u00b7 2 items" });
    // A failure outlives nothing: once the inventory is empty the line says so,
    // instead of a stale "Cleaning failed" over a computer with no leftovers.
    expect(leftoverLine({ kind: "none" }, false, run({ state: "failed", done: 11, failed: 2 }))).toMatchObject({ tone: "none", text: "No leftovers" });
  });
  test("autoWords keeps the bytes for the bar and the count for the card; the title says it in full", () => {
    expect(autoWords(run({ freed: 0 }), "panel").text).toBe("Cleaning \u00b7 6 of 13");
    expect(autoWords(run(), "panel").title).toContain("6.4 GB freed so far");
    expect(autoRunOf(undefined)).toBeNull();
  });
  test("a run waiting for its tab says so in one line, on both surfaces, and the button stays as the manual way", () => {
    const waiting = run({ state: "waiting", done: 0, total: 0, freed: 0 });
    expect(WAITING_LINE).toBe("Waiting for its tab to close, then it cleans up on its own.");
    expect(bar({ run: waiting })).toMatchObject({ button: true, retry: false, wait: true, text: WAITING_LINE, title: WAITING_TITLE });
    expect(leftoverLine({ kind: "some", items: 7, bytes: GB, groups: [] }, false, waiting)).toMatchObject({ tone: "none", text: WAITING_LINE, title: WAITING_TITLE });
    // Waiting is a state of the automatic cleanup only: with it off, the leftovers are the person's own button.
    expect(bar({ mode: "ask", run: waiting }).wait).toBeUndefined();
    expect(bar({ run: run(), }).wait).toBeUndefined();
  });
});

describe("the Housekeeping entry of one pull request", () => {
  const entry = (over: Partial<AutoEntry>): AutoEntry => ({
    repo: "/w/orbit", pr: 77, state: "cleaning", label: "acme/orbit", slug: "ORBIT-1042", title: "Retry queue",
    reason: "", done: 1, total: 3, freed: 0, started_at: 1, ended_at: null, items: [], ...over,
  });
  test("this PR's newest entry, and nothing for another project or another PR", () => {
    const older = entry({ started_at: 1, state: "cleaned" }), newer = entry({ started_at: 5 });
    expect(autoEntryFor([older, newer, entry({ pr: 78 }), entry({ repo: "/w/elsewhere" })], "/w/orbit", 77)).toBe(newer);
    expect(autoEntryFor([older], "/w/orbit", 99)).toBeUndefined();
  });
  test("only a run's own three states speak; blocked and nothing-to-clean do not", () => {
    expect(autoRunOf(entry({ state: "blocked" }))).toBeNull();
    expect(autoRunOf(entry({ state: "nothing", done: 3 }))).toBeNull();
    expect(autoRunOf(entry({ items: [{ kind: "stashes", target: "stash@{0}", status: "failed", detail: "busy" }] }))).toMatchObject({ state: "cleaning", failed: 1 });
  });
});

// The card said "Cleaning failed · 1 item" for six pull requests in a row, whatever had gone wrong.
describe("a failed run names what failed", () => {
  const entry = (items: { kind: string; status: "failed" | "done"; detail: string }[]) =>
    autoRunOf({ repo: "/r", pr: 1042, state: "failed", label: "", slug: "ORBIT-1042", title: "", reason: "", done: 0, total: 3, freed: 0, started_at: 1, ended_at: 2, items: items.map((i) => ({ target: "x", ...i })) })!;
  test("the card line says which item; the tip keeps the script's own last line", () => {
    const td = entry([{ kind: "teardown-script", status: "failed", detail: "teardown failed (exit 1): not a worktree this script made; worktree kept" }]);
    expect(td.what).toBe("teardown-script");
    expect(autoWords(td, "card").text).toBe("Cleaning failed \u00b7 the teardown script stopped");
    expect(autoWords(td, "card").title).toContain("not a worktree this script made");
    const two = entry([{ kind: "branch", status: "failed", detail: "not fully merged" }, { kind: "docker-image", status: "failed", detail: "image is being used by a container" }]);
    expect(autoWords(two, "card").text).toBe("Cleaning failed \u00b7 the branch was kept (+1 more)");
  });
  test("a kind with no words falls back to the count", () => {
    const odd = entry([{ kind: "something-new", status: "failed", detail: "x" }]);
    expect(odd.what).toBeUndefined();
    expect(autoWords(odd, "card").text).toBe("Cleaning failed \u00b7 1 item");
    expect(failedWords(undefined)).toBe("");
  });
  test("the same words and the reason, for a summary", () => {
    expect(failureLine([{ kind: "worktree", status: "done" }])).toBeNull();
    expect(failureLine([{ kind: "tab", status: "failed", detail: "\u001b[31mcan't find window\u001b[0m" }]))
      .toEqual({ short: "its tab is still open", why: "its tab is still open: can't find window" });
    expect(failureLine([{ kind: "something-new", status: "failed", detail: "" }, { kind: "branch", status: "failed", detail: "" }]))
      .toEqual({ short: "2 items failed", why: "2 items failed" });
  });
});

// After a failed run one card offered "Open" and its neighbours "Clean up local leftovers", in the same state.
describe("the same failed state offers the same button", () => {
  const failed: AutoRun = { state: "failed", done: 1, total: 3, freed: 0, failed: 1 };
  const some: LeftoverState = { kind: "some", items: 2, bytes: 10, groups: [] };
  test("a failed run offers Clean up until something says the computer is clean", () => {
    for (const s of [some, { kind: "computing" }, { kind: "unknown", why: "x" }, undefined] as (LeftoverState | undefined)[]) expect(cleanOffered(s, failed)).toBe(true);
    expect(cleanOffered({ kind: "none" }, failed)).toBe(false);
  });
  test("without a failed run the inventory alone decides", () => {
    expect(cleanOffered(some, null)).toBe(true);
    for (const s of [{ kind: "computing" }, { kind: "unknown", why: "x" }, { kind: "none" }, undefined] as (LeftoverState | undefined)[]) expect(cleanOffered(s, null)).toBe(false);
    expect(cleanOffered({ kind: "computing" }, { ...failed, state: "cleaned" })).toBe(false);
  });
  test("what a run left is read from its own report, bookkeeping rows aside", () => {
    expect(stateOfRemaining([])).toEqual({ kind: "none" });
    expect(stateOfRemaining([{ kind: "own-state" }, { kind: "worklog" }])).toEqual({ kind: "none" });
    expect(stateOfRemaining([{ kind: "worktree", bytes: 500 }, { kind: "branch" }, { kind: "own-state" }]))
      .toMatchObject({ kind: "some", items: 2, bytes: 500 });
  });
  test("the store keeps that answer instead of dropping the row", async () => {
    const store = await Bun.file(new URL("../src/lib/leftoversStore.ts", import.meta.url)).text();
    expect(store).toContain("else if (e.report?.remaining) cache.set(k, stateOfRemaining(e.report.remaining.items));");
  });
});

describe("a failed automatic run checked against the disk", () => {
  // The checkout was removed by hand after the run stopped on its teardown: the card read "Cleaning failed · 1 item"
  // over a disk with nothing of the pull request left, and kept asking for a retry.
  const failed: AutoRun = { state: "failed", done: 3, total: 4, freed: 0, failed: 1, teardown: true, why: "teardown failed (exit 1)" };
  test("nothing left on disk: cleaned, with nothing to retry", () => {
    const r = onDisk(failed, { kind: "none" })!;
    expect(r).toMatchObject({ state: "cleaned", settled: true, failed: 0 });
    expect(autoWords(r, "card").text).toBe("Cleaned · nothing left");
    expect(barFor({ mode: "auto", run: r, leftovers: false }, "card")).toMatchObject({ retry: false, tone: "ok" });
  });
  test("something still there, or not read yet: the failure stands", () => {
    expect(onDisk(failed, { kind: "some", items: 1, bytes: 0, groups: [] })!.state).toBe("failed");
    expect(onDisk(failed, { kind: "computing" })!.state).toBe("failed");
    expect(onDisk(failed, undefined)!.state).toBe("failed");
  });
});
