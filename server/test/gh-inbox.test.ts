/*
 * The GitHub inbox, as this app reads it.
 *
 * The shape is checked against what a real account actually returns — probed
 * before any of this was written, which is where the fields below come from —
 * and the parts worth pinning are the two that decide whether a row is useful:
 * the NUMBER, without which a row cannot open inside the app, and the thread
 * id, which is what every write takes and is not the pull request's number.
 */
import { describe, expect, test } from "bun:test";
import { numberFromUrl, toItem } from "../src/ghinbox.ts";

/* One row, in GitHub's own shape. */
const raw = {
  id: "25172377935",
  unread: true,
  reason: "review_requested",
  updated_at: "2026-08-19T10:21:17Z",
  repository: { full_name: "acme/orbit" },
  subject: {
    title: "Preferred phone number is cleared after saving the profile",
    url: "https://api.github.com/repos/acme/orbit/pulls/1629",
    type: "PullRequest",
  },
};

describe("a row", () => {
  test("carries what a list needs and the number that opens it here", () => {
    expect(toItem(raw)).toEqual({
      id: "25172377935",
      unread: true,
      reason: "review_requested",
      type: "PullRequest",
      repo: "acme/orbit",
      title: "Preferred phone number is cleared after saving the profile",
      at: Date.parse("2026-08-19T10:21:17Z"),
      number: 1629,
    });
  });

  test("an issue is a row too — the board cannot see those at all", () => {
    const issue = toItem({ ...raw, subject: { ...raw.subject, type: "Issue", url: "https://api.github.com/repos/acme/orbit/issues/18" } })!;
    expect(issue.type).toBe("Issue");
    expect(issue.number).toBe(18);
  });

  /* A release or a check suite has no number. It is still a row — it can be
     read and marked — it just cannot be opened in this app, and saying so with
     an absent field beats inventing a zero. */
  test("a subject with no number keeps the row and drops the field", () => {
    const rel = toItem({ ...raw, subject: { title: "v2.4.0", type: "Release", url: "https://api.github.com/repos/acme/orbit/releases/99" } })!;
    expect(rel.number).toBeUndefined();
    expect(rel.title).toBe("v2.4.0");
  });

  test("read is read, and a missing flag is treated as unread", () => {
    expect(toItem({ ...raw, unread: false })!.unread).toBe(false);
    expect(toItem({ ...raw, unread: undefined })!.unread).toBe(true);
  });

  test("something with no title is not a row", () => {
    expect(toItem({ ...raw, subject: { ...raw.subject, title: "" } })).toBeNull();
    expect(toItem({ ...raw, id: "" })).toBeNull();
  });

  test("the reason is GitHub's own word, kept raw", () => {
    // Their list grows — team_mention, ci_activity, security_alert — and a
    // mapping here would silently drop whatever is new.
    for (const reason of ["mention", "author", "team_mention", "ci_activity"]) {
      expect(toItem({ ...raw, reason })!.reason).toBe(reason);
    }
    expect(toItem({ ...raw, reason: undefined })!.reason).toBe("subscribed");
  });
});

describe("the number in a subject url", () => {
  test("both kinds, and neither of the things that look like one", () => {
    expect(numberFromUrl("https://api.github.com/repos/a/b/pulls/17629")).toBe(17629);
    expect(numberFromUrl("https://api.github.com/repos/a/b/issues/18")).toBe(18);
    // A comment url ends in the COMMENT's id, which is not the thread's number.
    expect(numberFromUrl("https://api.github.com/repos/a/b/issues/comments/2242")).toBeUndefined();
    expect(numberFromUrl("https://api.github.com/repos/a/b/releases/99")).toBeUndefined();
    expect(numberFromUrl(undefined)).toBeUndefined();
  });
});
