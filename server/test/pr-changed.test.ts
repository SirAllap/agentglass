import { afterAll, beforeEach, describe, expect, test } from "bun:test";

/*
 * `pr-changed`: a review plugin hears when a pull request's head or labels
 * move. Every case is a way the event could be wrong in the field: a boot that
 * wakes the plugin once per open pull request, a label list re-sorted by
 * GitHub, a label added and one removed announced as two events, a plugin
 * that never asked to hear about pull requests being told anyway.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-pr-changed-unit-"));
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
process.env.AGENTGLASS_DB = join(dir, "p.db");

const C = await import("../src/prChanged.ts");
await import("../src/plugins.ts"); // first: plugin-ui and plugins import each other
const U = await import("../src/plugin-ui.ts");

const A = "a".repeat(40);
const B = "b".repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT = 40;

let events: import("../src/prChanged.ts").PrChangedEvent[] = [];
beforeEach(() => {
  C.__resetPrChanged({ coalesceMs: 15, guardMs: 3000 });
  events = [];
  C.onPrChanged((e) => events.push(e));
});
afterAll(() => { C.__resetPrChanged(); });

const see = (n: number, head: string | undefined, labels: string[] | undefined, repo = "acme/orbit") =>
  C.observePr(repo, `github.com/${repo}`, n, { head, labels });

describe("detection", () => {
  test("first sight is a baseline, never an event", async () => {
    see(1042, A, ["bug"]);
    see(1043, A, []);
    await sleep(WAIT);
    expect(events).toEqual([]);
  });

  test("a label added fires once, with what was added and the final set", async () => {
    see(1042, A, ["bug"]);
    see(1042, A, ["agentglass-review", "bug"]);
    await sleep(WAIT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "pr-changed", repo: "acme/orbit", number: 1042, head: A,
      labels: ["agentglass-review", "bug"], added: ["agentglass-review"], removed: [], headChanged: false,
    });
    expect(typeof events[0]!.at).toBe("number");
  });

  test("the payload is these keys and no title or body", async () => {
    see(7, A, []);
    see(7, B, ["x"]);
    await sleep(WAIT);
    expect(Object.keys(events[0]!).sort()).toEqual(["added", "at", "head", "headChanged", "labels", "number", "removed", "repo", "type"]);
  });

  test("a new head fires with headChanged", async () => {
    see(1042, A, ["bug"]);
    see(1042, B, ["bug"]);
    await sleep(WAIT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ head: B, headChanged: true, added: [], removed: [] });
  });

  test("labels in another order are no change", async () => {
    see(1042, A, ["bug", "agentglass-review"]);
    see(1042, A, ["agentglass-review", "bug"]);
    see(1042, A, ["bug", "bug", "agentglass-review"]);
    await sleep(WAIT);
    expect(events).toEqual([]);
  });

  test("a read without a head, or without labels, changes nothing", async () => {
    see(1042, undefined, ["bug"]);   // the list's first pass: labels, no head
    see(1042, A, ["bug"]);           // the second pass brings the head: a baseline
    see(1042, undefined, undefined);
    see(1042, undefined, ["bug"]);
    await sleep(WAIT);
    expect(events).toEqual([]);
  });

  test("labels unknown at first sight: the first read that has them is the baseline", async () => {
    see(5, A, undefined);
    see(5, A, ["bug"]);
    await sleep(WAIT);
    expect(events).toEqual([]);
  });

  test("a burst is one event with the final state against what the plugin last knew", async () => {
    see(1042, A, ["bug"]);
    see(1042, A, ["bug", "agentglass-review"]);
    see(1042, B, ["agentglass-review"]);
    see(1042, B, ["agentglass-review", "wip"]);
    await sleep(WAIT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ head: B, headChanged: true, labels: ["agentglass-review", "wip"], added: ["agentglass-review", "wip"], removed: ["bug"] });
  });

  test("a change undone inside the window is no event", async () => {
    see(1042, A, ["bug"]);
    see(1042, A, ["bug", "wip"]);
    see(1042, A, ["bug"]);
    await sleep(WAIT);
    expect(events).toEqual([]);
  });

  test("after an event the new state is the baseline", async () => {
    see(1042, A, ["bug"]);
    see(1042, A, ["bug", "wip"]);
    await sleep(WAIT);
    see(1042, A, ["bug", "wip"]);
    await sleep(WAIT);
    expect(events).toHaveLength(1);
    see(1042, A, ["bug"]);
    await sleep(WAIT);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ added: [], removed: ["wip"] });
  });

  test("a pull request the app never loaded, in another repository, is not announced", async () => {
    see(1042, A, ["bug"], "acme/orbit");
    see(1042, B, ["bug", "x"], "acme/other");     // first sight of that one: its own baseline
    await sleep(WAIT);
    expect(events).toEqual([]);
    see(1042, A, ["bug", "x"], "acme/orbit");
    await sleep(WAIT);
    expect(events.map((e) => e.repo)).toEqual(["acme/orbit"]);
  });
});

describe("bounds", () => {
  test("at most 50 labels, each at most 100 characters, sorted", async () => {
    see(1, A, []);
    see(1, A, Array.from({ length: 80 }, (_, i) => `l${String(i).padStart(2, "0")}${"x".repeat(150)}`));
    await sleep(WAIT);
    expect(events[0]!.labels).toHaveLength(50);
    expect(events[0]!.labels.every((l) => l.length <= 100)).toBe(true);
    expect([...events[0]!.labels].sort()).toEqual(events[0]!.labels);
  });

  test("the memory of pull requests is bounded", () => {
    for (let n = 1; n <= 2100; n++) see(n, A, []);
    expect(C.__trackedCount()).toBeLessThanOrEqual(2000);
  });

  test("the per-PR refresh guard lets one through per window", () => {
    expect(C.claimRefresh("github.com/acme/orbit", 1042, 10_000)).toBe(true);
    expect(C.claimRefresh("github.com/acme/orbit", 1042, 12_999)).toBe(false);
    expect(C.claimRefresh("github.com/acme/orbit", 1043, 12_999)).toBe(true);
    expect(C.claimRefresh("github.com/acme/orbit", 1042, 13_000)).toBe(true);
  });
});

describe("delivery", () => {
  const ev: import("../src/prChanged.ts").PrChangedEvent = { type: "pr-changed", repo: "acme/orbit", number: 1, head: A, labels: [], added: [], removed: [], headChanged: false, at: 1 };

  test("only to running plugins that declare prNotes", () => {
    const got: string[] = [];
    const n = C.deliverPrChanged(ev, [
      { name: "acme-review", running: true, prNotes: true },
      { name: "stopped-review", running: false, prNotes: true },
      { name: "acme-panel", running: true, prNotes: false },
    ], (p) => got.push(p));
    expect(got).toEqual(["acme-review"]);
    expect(n).toBe(1);
  });

  test("a plugin that stops draining keeps the newest 200, oldest dropped", async () => {
    U.setLivenessCheck(() => true);
    for (let i = 0; i < 260; i++) U.pushEvent("acme-review", { ...ev, number: i });
    const q = await U.takeEvents("acme-review", 0);
    expect(q).toHaveLength(200);
    expect((q[0] as { number: number }).number).toBe(60);
    expect((q[199] as { number: number }).number).toBe(259);
  });

  test("an event for a plugin that is not live is dropped", async () => {
    U.setLivenessCheck(() => false);
    U.pushEvent("ghost-review", { ...ev });
    expect(await U.takeEvents("ghost-review", 0)).toEqual([]);
    U.setLivenessCheck(() => true);
  });
});
