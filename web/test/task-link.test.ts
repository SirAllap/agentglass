/*
 * The work item a pull request came from, whoever tracks it.
 *
 * Written because the existing reader is ClickUp's and says so. Most people
 * running agentglass have no ClickUp; some have GitHub issues; some have
 * nothing. A chip that says "card" to somebody with no cards is worse than no
 * chip, and one that dresses a Jira-shaped id as a ClickUp link is worse again.
 */
import { describe, expect, it } from "bun:test";
import { taskLink, fromRef, taskLinkTitle } from "../src/lib/taskLink.ts";

const WITH = true, WITHOUT = false;

describe("with nothing to link to", () => {
  it("shows nothing rather than an empty chip", () => {
    expect(taskLink({ headRefName: "feat/tidy-the-header", title: "Tidy the header" }, WITH)).toBeNull();
  });

  it("stays silent for a convention when no provider is connected", () => {
    /*
     * `WEB-1042` in a branch name is a habit half the trackers in the world
     * share. With nothing connected there is nowhere to take it, so a chip
     * would be decoration that looks like a control.
     */
    expect(taskLink({ headRefName: "WEB-1042-fix-the-thing" }, WITHOUT)).toBeNull();
  });
});

describe("what it does read", () => {
  it("takes an id from the branch when something can resolve it", () => {
    const t = taskLink({ headRefName: "ORBIT-1042-fix-the-thing" }, WITH)!;
    expect(t.label).toBe("ORBIT-1042");
    expect(t.confidence).toBe("convention");
  });

  it("calls an address certain, and keeps it openable", () => {
    /*
     * Tested through the rule rather than through a body with a tracker's URL
     * in it: this repository is public and a hook stops those going in. It is
     * also the honest unit — what is decided here is what a piece of evidence
     * entitles you to show, which does not depend on who wrote it.
     */
    const t = fromRef({ label: "ORBIT-1042", query: "abc123", url: "https://tracker.example/t/abc123", from: "url" }, WITHOUT)!;
    expect(t.confidence).toBe("certain");
    expect(t.url).toContain("abc123");
  });

  it("shows an address even with nothing connected — a URL needs no credentials", () => {
    expect(fromRef({ label: "X-1", query: "x", url: "https://tracker.example/t/x", from: "url" }, WITHOUT)).not.toBeNull();
  });
});

describe("what the tooltip admits", () => {
  it("says a link is a link", () => {
    const t = fromRef({ label: "ORBIT-1042", query: "x", url: "https://tracker.example/t/x", from: "url" }, WITH)!;
    expect(taskLinkTitle(t)).toContain("linked from the description");
  });

  it("says a convention is a convention", () => {
    // The honesty has to live somewhere, and the chip is four characters wide.
    const t = taskLink({ headRefName: "ORBIT-1042-x" }, WITH)!;
    expect(taskLinkTitle(t)).toContain("convention rather than a link");
  });
});
