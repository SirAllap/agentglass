/*
 * The list side of the PR view as the design draws it: five lanes filed by who
 * owes the next move, the card menu in its own order, and the faces a list can
 * be in while GitHub is slow or silent. What a renderer cannot press is read
 * from source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { LANES, fileInLane, lanesFor } from "../src/lib/prLanes.ts";
import { CHIP_FACETS, FACETS, reasonSentence, tagLabel } from "../src/lib/ghInbox.ts";
import { cardMenu, walkIds } from "../src/lib/prCardMenu.ts";
import type { PrSummary } from "../../shared/types.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const panel = read("../src/components/PrPanel.tsx");
const bar = read("../src/components/PrFilterBar.tsx");
const freshness = read("../src/components/prs/PrFreshness.tsx");

const green = { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] };
const pr = (o: Record<string, unknown> = {}) =>
  ({ number: 7, title: "Add the thing", author: "mara-k", state: "OPEN", isDraft: false, headRefName: "h7", baseRefName: "main",
    reviewDecision: null, checks: green, reviewers: [], labels: [], assignees: [], ...o }) as unknown as PrSummary;

describe("lanes", () => {
  it("are five, named as the design names them", () => {
    expect(LANES.map((l) => l.label)).toEqual(["Needs your review", "Green, ready to land", "Blocked", "Waiting on someone else", "Yours in flight"]);
  });

  it("file yours-with-a-reviewer under Waiting, and yours-with-nobody-asked under In flight", () => {
    const waiting = fileInLane(pr({ reviewers: [{ login: "ana-v" }, { login: "bo-n" }] }), { mine: true, asked: false });
    expect(waiting.lane).toBe("others");
    expect(waiting.reason).toBe("Waiting on ana-v, bo-n.");
    expect(fileInLane(pr(), { mine: true, asked: false }).lane).toBe("flight");
  });

  it("keep Yours in flight in a person's board, under their own name", () => {
    expect(lanesFor("mara-k").some((l) => l.label === "mara-k's, in flight")).toBe(true);
  });
});

describe("the card menu", () => {
  const menu = cardMenu({ p: pr(), view: { reasons: {} } as never, pinned: false, mode: "clickup", cardId: "ORBIT-1042", stacked: false });

  it("opens on the four moves a person makes most, then Card, Edit, then Branch and checks", () => {
    const heads = menu.rows.filter((r) => r.kind === "heading").map((r) => (r as { text: string }).text);
    expect(heads).toEqual(["Card · ORBIT-1042", "Edit", "Branch and checks"]);
    expect(menu.rows.slice(0, 4).map((r) => (r as { id: string }).id)).toEqual(["hand", "reviewers", "nudge", "agent"]);
  });

  it("walks the More rows only once More is open", () => {
    expect(walkIds(menu, false)).toContain("more");
    expect(walkIds(menu, false)).not.toContain("squash");
    expect(walkIds(menu, true)).toContain("squash");
  });
});

describe("a list that has not answered yet", () => {
  it("never says there is no remote before the first answer", () => {
    expect(panel).toContain("!repo && !listAnswered");
  });
  it("keeps the last good read on screen when a refresh fails, and says how old it is", () => {
    expect(panel).toContain("data-stale-banner");
    expect(panel).toContain("dataAt: reading ? st.dataAt : r.dataAt || st.dataAt");
    expect(panel).toContain("Retry now");
  });
  it("shouts Loading only when there is no age to show", () => {
    expect(freshness).toContain("busy && empty && !fresh");
  });
});

describe("the filter bar", () => {
  it("draws the chips row only for chips that are not the typed query itself", () => {
    expect(bar).toContain('chips.some((c) => c.key !== "text")');
  });
});

describe("the inbox row", () => {
  it("tags a row with the name of the chip that lists it, and says what happened in a sentence", () => {
    expect(tagLabel("review_requested")).toBe("Review requested");
    expect(tagLabel("mention")).toBe("Mentioned");
    expect(tagLabel("manual")).toBe("Subscribed");
    expect(reasonSentence("assign")).toBe("You were assigned");
    expect(reasonSentence("something_new")).toBe("something new");
  });
  it("draws five reason chips, and keeps the other filters reachable", () => {
    expect(CHIP_FACETS.map((id) => FACETS.find((f) => f.id === id)?.label)).toEqual(["Review requested", "Mentioned", "CI", "Assigned", "Subscribed"]);
    expect(FACETS.filter((f) => !CHIP_FACETS.includes(f.id)).map((f) => f.label)).toEqual(["Team mentioned", "Participating"]);
  });
});
