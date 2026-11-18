/*
 * The review's fixes, as behaviour: a capped site answer never hides a card, a board card never asks GitHub for its CI,
 * Ctrl+K is the app's own outside the Jira view, `g` then a digit does nothing while the Jira view is hidden, and a
 * board count not read yet is asked again on a short backoff.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { filterCards, NO_FILTERS } from "../src/components/jira/list/model.ts";
import { queryTiming } from "../src/components/jira/list/tabsModel.ts";
import { checksForUrl, rootFor, sessionsFor } from "../src/lib/jiraCardWork.ts";
import { cardLifecycle } from "../src/lib/cardLifecycle.ts";
import { putRollup } from "../src/lib/prRollupStore.ts";
import { paletteChordOpens, setJiraViewActive } from "../src/lib/jiraQueryPalette.ts";
import { gotoStep } from "../src/components/jira/gotoKey.ts";
import { countRetryMs, COUNT_BACKOFF_MS } from "../src/lib/useJiraViewCounts.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (key: string, status = "In Progress"): ProviderTask =>
  ({ id: key, key, title: key, status, statusKind: "active", tags: [], url: `https://orbit.atlassian.net/browse/${key}` }) as unknown as ProviderTask;

describe("a capped site answer never hides a card in silence", () => {
  const q = 'status = "In Progress"';
  const cards = [card("ORBIT-1042"), card("ORBIT-1050")];
  test("an uncapped answer is the whole truth: a card it lacks is hidden", () => {
    const shown = filterCards(cards, { ...NO_FILTERS, query: q, site: { q, keys: ["ORBIT-1042"] } });
    expect(shown.map((t) => t.id)).toEqual(["ORBIT-1042"]);
  });
  test("a capped answer only adds: a card the local reading keeps stays", () => {
    const shown = filterCards(cards, { ...NO_FILTERS, query: q, site: { q, keys: ["ORBIT-1042"], truncated: true } });
    expect(shown.map((t) => t.id)).toEqual(["ORBIT-1042", "ORBIT-1050"]);
  });
  test("the board says showing N of M when the cap was hit", () => {
    expect(queryTiming(1000, 80, { capped: true, total: 1432 })).toBe("showing 1000 of 1432 cards · 80 ms");
    expect(queryTiming(1000, 80, { capped: true })).toBe("showing 1000 of 1000+ cards · 80 ms");
    expect(queryTiming(12, 80)).toBe("12 cards · 80 ms");
  });
});

describe("a board card reads CI from the PR store only", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });
  test("an unread PR is 'not read' and asks nothing", async () => {
    let calls = 0;
    globalThis.fetch = (() => { calls++; return Promise.resolve(new Response("{}")); }) as unknown as typeof fetch;
    expect(checksForUrl("https://github.com/orbit/app/pull/9001")).toBeNull();
    await Bun.sleep(5);
    expect(calls).toBe(0);
  });
  test("a reading the store already holds is used", () => {
    putRollup("gh:orbit/app", 9002, { total: 3, success: 3, failure: 0, skipped: 0, pending: 0 } as never);
    expect(checksForUrl("https://github.com/orbit/app/pull/9002")?.checks).toBeTruthy();
  });
});

describe("Ctrl+K", () => {
  const terminal = { tagName: "TEXTAREA" };
  const field = { tagName: "INPUT" };
  const button = { tagName: "BUTTON" };
  test("outside the Jira view it always opens the palette, even from a terminal or a field", () => {
    expect(paletteChordOpens(false, terminal)).toBe(true);
    expect(paletteChordOpens(false, field)).toBe(true);
    expect(paletteChordOpens(false, button)).toBe(true);
  });
  test("inside the Jira view a terminal or a field keeps the chord", () => {
    expect(paletteChordOpens(true, terminal)).toBe(false);
    expect(paletteChordOpens(true, field)).toBe(false);
    expect(paletteChordOpens(true, button)).toBe(true);
    expect(paletteChordOpens(true, null)).toBe(true);
  });
});

describe("g then a digit", () => {
  afterEach(() => setJiraViewActive(false));
  test("does nothing while the Jira view is hidden", () => {
    const armed = gotoStep({ key: "g" }, 0, 1_000, false);
    expect(armed.at).toBe(0);
    expect(gotoStep({ key: "2" }, 1_000, 1_100, false).digit).toBeUndefined();
  });
  test("jumps when the view is on screen and focus is not in a field", () => {
    const armed = gotoStep({ key: "g" }, 0, 1_000, true);
    expect(gotoStep({ key: "2" }, armed.at, 1_100, true).digit).toBe("2");
    expect(gotoStep({ key: "2", target: { tagName: "TEXTAREA" } }, armed.at, 1_100, true).digit).toBeUndefined();
    expect(gotoStep({ key: "2" }, armed.at, 1_000 + 1_600, true).digit).toBeUndefined();
  });
});

describe("a board count not read yet", () => {
  test("is asked again on a short backoff, then left", () => {
    expect(COUNT_BACKOFF_MS.map((_, i) => countRetryMs(i))).toEqual([...COUNT_BACKOFF_MS]);
    expect(countRetryMs(COUNT_BACKOFF_MS.length)).toBeNull();
  });
});

describe("Send to terminal", () => {
  test("launches in the card's own folder before a tab that only names the card", () => {
    const agents = [
      { session_id: "a", title: "Review ORBIT-1042", cwd: "/code/orbit" },
      { session_id: "b", title: "worker", cwd: "/code/orbit-wt/ORBIT-1042-rotate-tokens" },
    ] as never;
    expect(rootFor("ORBIT-1042", agents)).toBe("/code/orbit-wt/ORBIT-1042-rotate-tokens");
  });
});

describe("a card's cost", () => {
  test("counts a session once when it matches by its folder and by a tab title", () => {
    const one = { session_id: "s1", title: "ORBIT-1042 rotate tokens", cwd: "/code/orbit-wt/ORBIT-1042-rotate-tokens", status: "idle", cost: 1.84, model_name: null, lastSeen: 1 };
    const tab = { ...one, title: "Review ORBIT-1042", cwd: "/code/orbit" };
    const mine = sessionsFor("ORBIT-1042", [one, tab] as never);
    expect(mine).toHaveLength(1);
    const life = cardLifecycle({
      now: 10, status: "In Progress", statusKind: "active", moves: [], plans: [], runs: [], pr: null, checks: null,
      sessions: [one, tab].map((a) => ({ sessionId: a.session_id, title: a.title, status: a.status, cost: a.cost, model: null, lastSeen: 1, live: false })),
    } as never);
    expect(JSON.stringify(life)).toContain("$1.84");
    expect(JSON.stringify(life)).not.toContain("$3.68");
  });
});

describe("the Jira chip reads the checks the PR board already loaded", () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; });
  test("a PR list answer's checks show on the Jira chip, no request", async () => {
    const { publishListChecks } = await import("../src/lib/prListChecks.ts");
    let calls = 0;
    globalThis.fetch = (() => { calls++; return Promise.resolve(new Response("{}")); }) as unknown as typeof fetch;
    const red = { total: 75, success: 74, failure: 1, skipped: 0, pending: 0, allDone: true, verdict: "red", failing: [{ name: "lint" }] };
    publishListChecks({ owner: "Orbit", name: "App" } as never, [{ number: 9100, checksLoaded: true, checks: red }, { number: 9101, checksLoaded: false, checks: red }] as never);
    expect(checksForUrl("https://github.com/orbit/app/pull/9100")?.checks.failure).toBe(1);
    expect(checksForUrl("https://github.com/orbit/app/pull/9101")).toBeNull();
    expect(calls).toBe(0);
  });
});
