/*
 * EVERY BLOCK THAT CHANGES A CARD SAYS WHICH TRACKER IT WRITES TO.
 *
 * `ORBIT-1042` beside a status picker left the reader guessing which system the
 * status would land in, and with both trackers connected the guess is a coin
 * toss: the same string is a Jira key here and a ClickUp custom id on somebody
 * else's machine. The badge is one word and one glyph next to the id.
 *
 * The load-bearing rule is where the word comes from. A badge that read the id's
 * shape would be a second opinion beside the one the write makes, and the two
 * disagree exactly when it matters. So every block draws it from its own write:
 * the review popover's `side.kind`, the merge dialog's two halves, the panel
 * section's `ref`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeTracker, sectionTracker, trackerBadge } from "../src/lib/trackerBadge.ts";
import { cardRef } from "../src/lib/cardRef.ts";
import { trackerFor } from "../src/lib/trackerApi.ts";
import type { TrackerSetup } from "../src/lib/trackerSetup.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const jira = (...prefixes: string[]): TrackerSetup["jira"] => ({ connected: true, prefixes, site: "acme.atlassian.net" });
const cu = (prefix?: string): TrackerSetup["clickup"] => ({ connected: true, prefix });
const both = (prefix: string, ...keys: string[]): TrackerSetup => ({ clickup: cu(prefix), jira: jira(...keys) });

/** Who would write this pull request's card, which is what the badge must say. */
const owner = (pr: { headRefName?: string; title?: string; body?: string }, setup: TrackerSetup) => {
  const ref = cardRef(pr, setup.jira ? { keys: setup.jira.prefixes, site: setup.jira.site } : undefined);
  return trackerBadge(ref ? (trackerFor(ref, setup, "auto")?.id ?? null) : null);
};

describe("the badge", () => {
  it("names Jira for a key the site listed", () => {
    expect(owner({ headRefName: "ORBIT-1042-retry-the-webhook" }, both("LEGACY-", "ORBIT"))).toMatchObject({ label: "Jira" });
  });

  it("names ClickUp for an id only its own prefix claims", () => {
    expect(owner({ headRefName: "LEGACY-123-retry-the-webhook" }, both("LEGACY-", "ORBIT"))).toMatchObject({ label: "ClickUp" });
  });

  it("names ClickUp for a native id, whatever else is connected", () => {
    expect(owner({ headRefName: "CU-86abc123_retry-on-429" }, both("LEGACY-", "ORBIT"))).toMatchObject({ label: "ClickUp" });
  });

  it("says nothing when no tracker claims the card", () => {
    // Still a ref, still shown as a chip; the word is the one thing nobody can
    // honestly supply, and a wrong one sends the reader to the wrong system.
    expect(owner({ headRefName: "ORBIT-1042" }, { clickup: cu("LEGACY-") })).toBeNull();
    expect(trackerBadge(null)).toBeNull();
  });

  it("draws a glyph the app already uses for each", () => {
    expect(trackerBadge("jira")).toEqual({ label: "Jira", icon: "flag" });
    expect(trackerBadge("clickup")).toEqual({ label: "ClickUp", icon: "checkbox" });
  });
});

describe("the merge dialog's Tracker card block", () => {
  it("is Jira's when the card is, ClickUp's when it is ClickUp's, and nothing with no card", () => {
    expect(mergeTracker(true, false)).toBe("jira");
    expect(mergeTracker(false, true)).toBe("clickup");
    expect(mergeTracker(false, false)).toBeNull();
  });

  it("draws the badge from the two halves it writes", () => {
    const src = read("src/components/MergeDialog.tsx");
    expect(src).toContain("const tracker = mergeTracker(!!jiraCard, card.kind !== \"none\")");
    for (const m of src.matchAll(/<CardFrame\b[\s\S]{0,240}?>/g)) {
      expect(m[0], "a card frame with no tracker is the badge missing from the block").toMatch(/tracker=\{tracker\}/);
    }
  });
});

describe("the review popover's On the card block", () => {
  it("takes the badge and the write from the same `side.kind`", () => {
    const src = read("src/components/PrAskPicker.tsx");
    const block = src.slice(src.indexOf("case \"ready\": return ("), src.indexOf("case \"ready\": return (") + 1200);
    expect(block).toContain("<TrackerBadge tracker={side.kind} />");
    // What is actually written goes through the same value.
    expect(src).toContain("[side.kind]: cardRunner");
    expect(src).not.toContain("side.kind === \"jira\" ? <FlagIcon");
  });
});

describe("the pull request panel's tracker sections", () => {
  it("each draws the badge of the tracker its controls write to", () => {
    const src = read("src/components/PrPanel.tsx");
    const jiraSection = src.slice(src.indexOf("export function JiraCardFacts("), src.indexOf("function CardFacts("));
    const cuSection = src.slice(src.indexOf("function CardFacts("), src.indexOf("function defaultPing("));
    expect(jiraSection).toContain("<TrackerBadge tracker={TRACKERS.jira.id} />");
    // The section is chosen by this ref, so the badge reads it rather than
    // spelling the name a second time.
    expect(cuSection).toContain("<TrackerBadge tracker={sectionTracker(ref)} />");
  });

  it("and the section rule is the one that picks the section", () => {
    expect(sectionTracker({ tracker: "jira" })).toBe("jira");
    expect(sectionTracker({ tracker: "clickup" })).toBe("clickup");
    expect(sectionTracker({ tracker: null })).toBe("clickup");
  });
});

describe("one badge, drawn once", () => {
  it("has a single definition and nobody else draws those two glyphs with a tracker's name", () => {
    const badge = read("src/components/TrackerBadge.tsx");
    expect(badge).toContain("const look = trackerBadge(tracker)");
    for (const f of ["src/components/PrPanel.tsx", "src/components/PrAskPicker.tsx", "src/components/MergeJiraCard.tsx"]) {
      expect(read(f), `${f} does not use the shared badge`).toContain("TrackerBadge");
    }
  });
});
