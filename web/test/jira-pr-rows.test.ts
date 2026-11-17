/* Which PR the board chip leads with, and the one shape of a Dev-tab row. Fixtures are invented. */
import { describe, expect, test } from "bun:test";
import { pickCardPr, withKeyOwn, withLinkedOwn, classifyCardPrs, legacyKeysOf, type CardPr } from "../src/lib/cardPrPick.ts";
import { prRows, withKnownOwn } from "../src/lib/jiraPrRows.ts";
import { withMentions, mentionsOfCard } from "../src/lib/jiraLinks.ts";

const U = (n: number) => `https://github.com/acme/orbit/pull/${n}`;
const merged: CardPr = { number: 4295, title: "Retry the sync", state: "MERGED", url: U(4295), link: "mention" };
const open: CardPr = { number: 4395, title: "Follow-up cleanup", state: "OPEN", url: U(4395), link: "mention" };

describe("board chip", () => {
  test("a PR linked on the card leads over an open mention", () => {
    const pick = pickCardPr(withLinkedOwn([open, merged], [{ url: U(4295), number: 4295 }]));
    expect(pick.kind === "many" && pick.primary.number).toBe(4295);
    expect(pick.kind === "many" && pick.rest.map((p) => p.number)).toEqual([4395]);
  });
  test("an open own PR beats a merged one; merged beats a mention", () => {
    const own = withLinkedOwn([open, merged], [{ url: U(4295), number: 4295 }, { url: U(4395), number: 4395 }]);
    expect(pickCardPr(own)).toMatchObject({ kind: "many", primary: { number: 4395 } });
  });
  test("a linked PR the search never found is added", () => {
    const out = withLinkedOwn([open], [{ url: U(7), number: 7 }]);
    expect(out.find((p) => p.number === 7)?.link).toBe("own");
  });
});

describe("never-opened card (no links cache)", () => {
  test("merged PR with the key in its branch beats an open mention; +1", () => {
    const m: CardPr = { ...merged, title: "Retry the sync", branch: "orbit-882-retry-sync" };
    const pick = pickCardPr(withKeyOwn([open, m], "ORBIT-882"));
    expect(pick).toMatchObject({ kind: "many", primary: { number: 4295 } });
    expect(pick.kind === "many" && pick.rest.length).toBe(1);
  });
  test("ORBIT-88 does not claim ORBIT-882", () => {
    expect(withKeyOwn([{ ...merged, branch: "orbit-882-x" }], "ORBIT-88")[0]!.link).toBe("mention");
  });
});

describe("detail rows", () => {
  const links = withMentions([{ url: U(4295), number: 4295, title: "acme/orbit#4295", resolved: false }],
    mentionsOfCard({ description: "", comments: [{ text: U(4395) }] }));
  const rows = prRows([...links].reverse(), [open, merged]);
  test("linked first, one shape, state and relation on both", () => {
    expect(rows.map((r) => r.number)).toEqual([4295, 4395]);
    expect(rows[0]).toMatchObject({ label: "#4295 · Retry the sync", state: "Merged", relation: "Linked", canLink: false });
    expect(rows[1]).toMatchObject({ label: "#4395 · Follow-up cleanup", state: "Open", relation: "Mentions this card", canLink: true });
  });
  test("with nothing known the row is still the same shape", () => {
    expect(prRows(links)[0]).toMatchObject({ label: "#4295", state: "" });
  });
});

describe("sub-task does not inherit its parent's PR", () => {
  const parentPr: CardPr = { number: 500, title: "ORBIT-1000 Rework sync", state: "OPEN", draft: true, url: U(500), branch: "orbit-1000-rework-sync", link: "own" };
  test("parent PR #500 names ORBIT-1001 only in its body: mention for the sub-task, own for the parent", () => {
    const c = classifyCardPrs([parentPr], "ORBIT-1001");
    expect(c.own).toEqual([]);
    expect(c.mentions.map((p) => p.number)).toEqual([500]);
    expect(pickCardPr(c.own).kind).toBe("none");
    expect(pickCardPr(classifyCardPrs([parentPr], "ORBIT-1000").own)).toMatchObject({ kind: "one", pr: { number: 500 } });
  });
  test("two PRs whose branches carry the key are both own; ORBIT-100 is not ORBIT-1001", () => {
    const a: CardPr = { number: 480, title: "Step 1", state: "MERGED", url: U(480), branch: "orbit-1001-step-1", link: "own" };
    const b: CardPr = { number: 495, title: "Step 2", state: "OPEN", url: U(495), branch: "orbit-1001-step-2", link: "own" };
    expect(classifyCardPrs([a, b], "ORBIT-1001").own.map((p) => p.number).sort()).toEqual([480, 495]);
    expect(classifyCardPrs([a, b], "ORBIT-100").own).toEqual([]);
  });
  test("linked on the site is own; Dev tab says Linked for a branch-key PR", () => {
    const m: CardPr = { number: 9, title: "Cleanup", state: "OPEN", url: U(9), branch: "x" };
    expect(classifyCardPrs([m], "ORBIT-1001", [{ url: U(9), number: 9 }]).own.map((p) => p.number)).toEqual([9]);
    const row = prRows([{ url: U(480), number: 480, title: "acme/orbit#480", resolved: false, where: "comment" }], classifyCardPrs([{ number: 480, title: "Step 1", state: "MERGED", url: U(480), branch: "orbit-1001-step-1" }], "ORBIT-1001").own);
    expect(row[0]!.relation).toBe("Linked");
  });
});

describe("migrated card: the old key counts", () => {
  const desc = "Migrated from Oldtracker LEGACY-1001\n\nRetry the sync.";
  test("legacyKeysOf reads the old key from the description", () => {
    expect(legacyKeysOf(desc)).toEqual(["LEGACY-1001"]);
    expect(legacyKeysOf("nothing here")).toEqual([]);
  });
  test("new key in the title makes it own even with the old key in the branch", () => {
    const p: CardPr = { number: 480, title: "[ORBIT-1082] Cache the sync", state: "OPEN", url: U(480), branch: "LEGACY-1001-cache-sync" };
    expect(classifyCardPrs([p], "ORBIT-1082", [], legacyKeysOf(desc)).own.map((x) => x.number)).toEqual([480]);
  });
  test("only the old key in the branch, no new key anywhere: own by the legacy key", () => {
    const p: CardPr = { number: 481, title: "Cache the sync", state: "OPEN", url: U(481), branch: "LEGACY-1001-cache-sync" };
    expect(classifyCardPrs([p], "ORBIT-1082", [], legacyKeysOf(desc)).own.map((x) => x.number)).toEqual([481]);
    expect(classifyCardPrs([p], "ORBIT-1082").own).toEqual([]);
    expect(classifyCardPrs([{ ...p, branch: "LEGACY-10010-x" }], "ORBIT-1082", [], legacyKeysOf(desc)).own).toEqual([]);
  });
});

test("noteCardLegacyKeys: a read description teaches the store the old key", async () => {
  const store = await import("../src/lib/cardPrStore.ts");
  expect(() => store.noteCardLegacyKeys("ORBIT-1082", "Migrated from Oldtracker LEGACY-1001")).not.toThrow();
});

describe("Dev list holds every PR the count counts", () => {
  test("a PR found by branch joins the remote-link one, deduped by address", () => {
    const linked = [{ url: U(1676), number: 1676, title: "Old", resolved: false, where: "link" as const }];
    const byBranch: CardPr[] = [
      { number: 2190, title: "Export queue", state: "OPEN", url: U(2190), link: "own" },
      { number: 1676, title: "Old", state: "OPEN", url: U(1676), link: "own" },
      { number: 3, title: "Mentions it", state: "OPEN", url: U(3), link: "mention" },
    ];
    const rows = prRows(withKnownOwn(linked, byBranch), byBranch);
    expect(rows.map((r) => r.number).sort()).toEqual([1676, 2190]);
    expect(rows.find((r) => r.number === 2190)?.relation).toBe("Linked");
  });
});
