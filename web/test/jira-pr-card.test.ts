/*
 * A JIRA CARD IN THE PULL REQUEST PANEL: whose card it is, and what the merge
 * form is handed.
 *
 * `mergeCardRef` only ever returned ClickUp's cards, so on a machine with Jira
 * alone the panel offered nothing, and the reader took `ORBIT-7` (one digit),
 * `AB2-12` (a digit in the key) and a lower-case branch for ordinary words.
 * With a Jira site connected the reader is told its project keys and is exact.
 */
import { describe, expect, it } from "bun:test";
import { cardRef } from "../src/lib/cardRef.ts";
import { clickupCardRef, mergeCardRef } from "../src/lib/cardMove.ts";
import { ownerSetup } from "../src/lib/trackerView.ts";
import { __forgetTrackerChoices } from "../src/lib/trackerView.ts";

const KEYS = ["ORBIT", "AB2"];
const SITE = "acme.atlassian.net";
const view = (jira = true) => ({
  setup: { ...(jira ? { jira: { connected: true as const, prefixes: KEYS, site: SITE } } : null), clickup: undefined },
  choice: "auto" as const,
});
/** A machine with Jira alone: ClickUp's setup says "not connected". */
const jiraOnly = ownerSetup({ connected: false }, view());
const both = ownerSetup({ connected: true, prefix: "ACME-" }, { setup: { ...view().setup, clickup: { connected: true, prefix: "ACME-" } }, choice: "auto" });
__forgetTrackerChoices();

describe("the reader, told the site's project keys", () => {
  const reach = { keys: KEYS, site: SITE };
  it("takes a key with one digit, a digit in the key, and a lower-case branch", () => {
    expect(cardRef({ title: "ORBIT-7 fix the export" }, reach)?.label).toBe("ORBIT-7");
    expect(cardRef({ headRefName: "feature/AB2-12-thing" }, reach)?.label).toBe("AB2-12");
    expect(cardRef({ headRefName: "fix/orbit-7-export" }, reach)).toMatchObject({ label: "ORBIT-7", from: "branch" });
  });
  it("does not take lower case in a title, or a key the site did not list", () => {
    expect(cardRef({ title: "orbit-7 fix the export" }, reach)).toBeNull();
    expect(cardRef({ headRefName: "fix/OTHER-7-x" }, reach)).toBeNull();
  });
  it("is the old reader without the keys", () => {
    expect(cardRef({ title: "ORBIT-7 fix the export" })).toBeNull();
    expect(cardRef({ headRefName: "fix/orbit-7-export" })).toBeNull();
  });
  it("takes the body address of a site that is not on atlassian.net", () => {
    const onPrem = { keys: KEYS, site: "jira.acme.example" };
    const body = "Card:\nhttps://jira.acme.example/browse/ORBIT-7";
    expect(cardRef({ body }, onPrem)).toMatchObject({ label: "ORBIT-7", tracker: "jira", from: "url" });
    expect(cardRef({ body })).toBeNull();
  });
});

describe("what the merge form is handed", () => {
  it("is the Jira card, with its tracker, on a machine with no ClickUp", () => {
    expect(mergeCardRef({ title: "ORBIT-7 fix the export" }, jiraOnly)).toEqual({ label: "ORBIT-7", query: "ORBIT-7", tracker: "jira" });
  });
  it("is nothing for the same title once Jira is disconnected", () => {
    expect(mergeCardRef({ title: "ORBIT-7 fix the export" }, { connected: true, prefix: "ACME-" })).toBeNull();
    expect(mergeCardRef({ title: "ORBIT-7 fix the export" }, null)).toBeNull();
  });
  it("leaves a ClickUp card as it was, with no tracker field, beside a connected Jira", () => {
    const r = mergeCardRef({ headRefName: "fix/ACME-1042-pagination" }, both);
    expect(r).toEqual({ label: "ACME-1042", query: "ACME-1042" });
    expect(clickupCardRef({ headRefName: "fix/ACME-1042-pagination" }, both)).toEqual(r);
  });
  it("keeps a Jira card out of the surfaces whose body is ClickUp's", () => {
    expect(clickupCardRef({ title: "ORBIT-7 fix the export" }, jiraOnly)).toBeNull();
  });
});
