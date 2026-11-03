/*
 * The picker and the sidebar name the card the board already drew.
 *
 * The server finds a row's card in its branch and title with a case-blind
 * pattern, so `orbit-1043-profile-keys` shows ORBIT-1043 on the board. The
 * panel's own reader wants capitals in a branch, so for the same pull request
 * the picker said "No card is linked" and never asked the tracker for it. One
 * datum, two answers: the row's card is the evidence both must use.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mergeCardRef, mergeCardRefOrRow } from "../src/lib/cardMove.ts";

const lower = { headRefName: "orbit-1043-profile-keys", title: "Rename sandbox profile settings keys", body: "Closes ORBIT-1043." };
const row = { customId: "ORBIT-1043", id: "86a1043" };

describe("mergeCardRefOrRow", () => {
  it("the panel's own reader cannot read a lower-case branch (the gap)", () => {
    expect(mergeCardRef(lower, { connected: true, prefix: "ORBIT-" })).toBeNull();
  });

  it("falls back to the card the row carries, by its human id", () => {
    expect(mergeCardRefOrRow({ ...lower, card: row }, { connected: true, prefix: "ORBIT-" })).toEqual({ label: "ORBIT-1043", query: "ORBIT-1043" });
  });

  it("keeps the reader's answer when it has one", () => {
    const pr = { headRefName: "ORBIT-1043-profile-keys", title: "x", body: "", card: { ...row, customId: "ORBIT-9999" } };
    expect(mergeCardRefOrRow(pr, { connected: true, prefix: "ORBIT-" })?.query).toBe("ORBIT-1043");
  });

  it("offers nothing without a ClickUp to write to, whatever the row says", () => {
    expect(mergeCardRefOrRow({ ...lower, card: row }, { connected: false })).toBeNull();
    expect(mergeCardRefOrRow({ ...lower, card: row }, null)).toBeNull();
  });

  it("a Jira row card needs Jira connected and names its tracker", () => {
    const jira = { connected: false, jira: { keys: ["ORBIT"], site: "acme.atlassian.net" } };
    expect(mergeCardRefOrRow({ ...lower, card: { ...row, tracker: "jira" as const } }, jira)).toEqual({ label: "ORBIT-1043", query: "ORBIT-1043", tracker: "jira" });
    expect(mergeCardRefOrRow({ ...lower, card: { ...row, tracker: "jira" as const } }, { connected: true })).toBeNull();
  });

  it("falls back to the card's own id when it has no human one", () => {
    expect(mergeCardRefOrRow({ ...lower, card: { id: "86a1043" } }, { connected: true })).toEqual({ label: "86a1043", query: "86a1043" });
  });
});

describe("who uses it", () => {
  it("the picker and the sidebar's card section read it, not the strict reader alone", () => {
    const picker = readFileSync(new URL("../src/components/PrAskPicker.tsx", import.meta.url), "utf8");
    expect(picker).toContain("mergeCardRefOrRow(d, setup)");
    const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain("const ref = useMemo(() => mergeCardRefOrRow(d, setup)");
  });
});
