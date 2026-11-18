/*
 * A Jira key on a pull-request card opens the JIRA card.
 *
 * The chip on a board card pressed `openCard` with no tracker, and no tracker
 * is ClickUp — so `ORBIT-1042 · Code review` hovered "in Tasks", said "Open the
 * card in Tasks", and opened the ClickUp tab. The card this pull request is
 * about was in Jira, one tab away.
 *
 * Both halves are asserted: the resolver that answers "whose card is this",
 * and the card that draws the answer — because the bug was not a wrong rule,
 * it was a screen that never asked.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrSummary } from "../../shared/types.ts";
import { forgetCards } from "../src/lib/prCardStore.ts";
import { prCardTracker } from "../src/lib/trackerApi.ts";
import { idTip, ticketTip } from "../src/lib/prCardTips.ts";
import type { TrackerSetup } from "../src/lib/trackerSetup.ts";

const stubGlobal = globalStubs();
const cell = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, String(v)); },
  removeItem: (k: string) => { cell.delete(k); },
});

const { TriageBoard } = await import("../src/components/TriageBoard.tsx");
const { readTip } = await import("../src/lib/tip.ts");

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const pr = (number: number, o: Partial<PrSummary> = {}): PrSummary => ({
  number, title: `pull request ${number}`, author: "someone", state: "OPEN", isDraft: false,
  headRefName: `h${number}`, baseRefName: "main", url: "", updatedAt: iso(1),
  reviewDecision: null, additions: 1, deletions: 1, changedFiles: 1,
  labels: [], assignees: [], milestone: null,
  checks: {
    total: 3, success: 3, failure: 0, skipped: 0, pending: 0,
    allDone: true, verdict: "green", failing: [],
  },
  ...o,
} as unknown as PrSummary);

const render = (props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(TriageBoard as never, {
    mine: [], review: [], total: 0, hasTaskProvider: true,
    pinned: () => false, onOpen: () => {}, onTogglePin: () => {},
    onShowTable: () => {}, onAct: () => {},
    ...props,
  } as never));

const tips = (html: string): { name: string; text?: string; detail?: string }[] =>
  [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => readTip(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x27;/g, "'")));

/** One card's own markup, cut at the next `data-pr`. */
const cardHtml = (p: Partial<PrSummary>): string => {
  const html = render({ mine: [pr(7, p)], total: 1 });
  const i = html.indexOf('data-pr="7"');
  if (i < 0) return "";
  const start = html.lastIndexOf("<div", i);
  const end = html.indexOf('data-pr="', i + 10);
  return html.slice(start, end < 0 ? undefined : end);
};

/* Two trackers connected: a Jira site with one project key, and a ClickUp
   workspace whose own prefix is something else entirely. */
const BOTH: TrackerSetup = {
  clickup: { connected: true, prefix: "LEGACY" },
  jira: { connected: true, prefixes: ["ORBIT"], site: "acme.atlassian.net" },
};
const JIRA_ONLY: TrackerSetup = { jira: { connected: true, prefixes: ["ORBIT"], site: "acme.atlassian.net" } };
const CLICKUP_ONLY: TrackerSetup = { clickup: { connected: true, prefix: "LEGACY" } };

beforeEach(() => { cell.clear(); forgetCards(); });

describe("whose card the chip is", () => {
  test("a Jira key with a Jira card behind it is Jira's", () => {
    expect(prCardTracker(
      { headRefName: "ORBIT-1042-callback-spins" },
      { tracker: "jira" },
      BOTH,
    )).toBe("jira");
  });

  test("and stays Jira's when the body also links a ClickUp task", () => {
    /* The card is the fact: the server read it out of the Jira views. A body
       that also links a ClickUp address is how a migrated team's template
       looks, and it must not drag the press back to ClickUp. */
    expect(prCardTracker(
      { headRefName: "ORBIT-1042-callback-spins", body: "https://clickup.com/t/8ab12cd34" },
      { tracker: "jira" },
      BOTH,
    )).toBe("jira");
  });

  test("a key no card was read for is still resolved by the prefix", () => {
    // The chip on a card nobody has cached reads "ORBIT-1042" off the branch;
    // the connected site's own project keys are what settle it.
    expect(prCardTracker({ headRefName: "ORBIT-1042-callback-spins" }, undefined, BOTH)).toBe("jira");
  });

  test("a ClickUp-shaped id is ClickUp's, on a machine with both", () => {
    expect(prCardTracker({ headRefName: "LEGACY-123-retry-sync" }, undefined, BOTH)).toBe(null);
  });

  test("and on a machine with only ClickUp, which is what it always was", () => {
    expect(prCardTracker({ headRefName: "LEGACY-123-retry-sync" }, undefined, CLICKUP_ONLY)).toBe(null);
  });

  test("an id nothing claims is looked for where the only tracker is", () => {
    // Jira alone: there is no ClickUp tab to land on, so "look for it in Tasks"
    // means the Jira one.
    expect(prCardTracker({ headRefName: "LEGACY-123-retry-sync" }, undefined, JIRA_ONLY)).toBe("jira");
  });

  test("nothing connected answers nothing, and an unread setup waits", () => {
    expect(prCardTracker({ headRefName: "ORBIT-1042-x" }, undefined, {})).toBe(null);
    expect(prCardTracker({ headRefName: "ORBIT-1042-x" }, undefined, null)).toBe(null);
  });
});

describe("what the card's chip says, and where it goes", () => {
  const jiraCard = {
    headRefName: "ORBIT-1042-callback-spins",
    card: { id: "x", customId: "ORBIT-1042", title: "Callback spins", status: "Code review", priority: "high", tracker: "jira" },
  } as Partial<PrSummary>;

  test("a Jira card's chip opens the Jira card, and says so on hover", () => {
    const html = cardHtml(jiraCard);
    expect(html).toContain('data-tracker="jira"');
    expect(html).toContain("Open ORBIT-1042 in Jira");
    expect(tips(html)).toContainEqual(ticketTip({ id: "ORBIT-1042", status: "Code review", priority: "high" }, true, "jira"));
  });

  test("and never claims the ClickUp tab it used to open", () => {
    const html = cardHtml(jiraCard);
    expect(html).not.toContain("Open ORBIT-1042 in Tasks");
    expect(tips(html).some((t) => t.name === "ORBIT-1042" && t.detail === "in Tasks")).toBe(false);
  });

  test("a ClickUp card reads as it always did, and routes nowhere new", () => {
    const html = cardHtml({
      headRefName: "LEGACY-123-retry-sync",
      card: { id: "x", customId: "LEGACY-123", title: "Retry sync", status: "in review", priority: "normal" },
    });
    expect(html).not.toContain('data-tracker="jira"');
    expect(html).toContain("Open LEGACY-123 in Tasks");
    expect(tips(html).some((t) => t.name === "LEGACY-123" && t.detail === "in Tasks")).toBe(true);
  });

  test("a key no board holds says which tracker it will look in", () => {
    /* The `not found` chip is the same door, and it was the same lie: it
       promised Tasks and landed in ClickUp. Its words are `idTip`'s, asserted
       here directly because the board cannot know the tracker before the setup
       lands — the render above runs with no setup at all. */
    expect(idTip("ORBIT-9999", "jira")).toMatchObject({ detail: "in Jira", hint: { text: "Look for it in Jira" } });
    expect(idTip("ORBIT-9999").detail).toBe("in Tasks");
  });
});
