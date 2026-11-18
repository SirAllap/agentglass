/*
 * A bot review changing on an open pull request, for `flow.notifyPrReviews`.
 *
 * GitHub's own bot test covers the common case for free (`botReview`, already
 * computed on the second pass): a standing verdict read again is not news, a
 * new one is, once. The extra list is for a login this project added that
 * GitHub's test misses — that shows up as a person's review instead
 * (`humanReview.people`), so its state is watched there, one entry per login.
 */
import { describe, test, expect } from "bun:test";
import { noteBotReview } from "../src/prs.ts";
import type { PrSummary } from "../../shared/types.ts";

let n = 0;
const pr = (over: Partial<PrSummary> = {}): PrSummary => ({
  number: ++n, title: `pr ${n}`, author: "me", state: "OPEN", isDraft: false,
  headRefName: "h", baseRefName: "main", url: `https://github.com/o/r/pull/${n}`,
  updatedAt: "", reviewDecision: null, additions: 0, deletions: 0, changedFiles: 0,
  labels: [], assignees: [], milestone: null,
  ...over,
}) as unknown as PrSummary;

describe("noteBotReview — the default GitHub bot test", () => {
  test("the standing verdict as we found it is not news", () => {
    const row = pr({ botReview: { nodeId: "R_1" } });
    expect(noteBotReview("root-a", row)).toBeNull();
  });

  test("a new standing verdict IS news, once", () => {
    const row = pr({ botReview: { nodeId: "R_1" } });
    noteBotReview("root-b", row);
    expect(noteBotReview("root-b", { ...row, botReview: { nodeId: "R_2" } })).toMatchObject({ number: row.number, who: "a bot" });
    expect(noteBotReview("root-b", { ...row, botReview: { nodeId: "R_2" } }), "the next poll, same answer").toBeNull();
  });

  test("the bot withdrawing its review is not announced: nothing stands", () => {
    const row = pr({ botReview: { nodeId: "R_1" } });
    noteBotReview("root-c", row);
    expect(noteBotReview("root-c", { ...row, botReview: null })).toBeNull();
  });

  test("two projects on the same pull request each get their own first sight", () => {
    const row = pr({ botReview: { nodeId: "R_1" } });
    noteBotReview("root-d1", row);
    // root-d2 has never looked: this IS its first sight, not news.
    expect(noteBotReview("root-d2", row)).toBeNull();
  });
});

describe("noteBotReview — a login the project added to the extra list", () => {
  const withPerson = (login: string, state: "again" | "await" | "changes" | "approved" | "comment") =>
    pr({ humanReview: { kind: "commented", who: [], mine: false, people: [{ login, state }] } });

  test("not in the list, not a bot: no event", () => {
    const row = withPerson("my-reviewer", "approved");
    expect(noteBotReview("root-e", row, ["other-login"])).toBeNull();
  });

  test("in the list: the first sight is not news, a changed state is", () => {
    const row = withPerson("my-reviewer", "comment");
    noteBotReview("root-f", row, ["my-reviewer"]);
    const changed = { ...row, humanReview: { ...row.humanReview!, people: [{ login: "my-reviewer", state: "approved" as const }] } };
    expect(noteBotReview("root-f", changed, ["my-reviewer"])).toMatchObject({ who: "my-reviewer" });
  });

  test("case-insensitive, and an empty list never fires even with a latch already kept", () => {
    const row = withPerson("My-Reviewer", "comment");
    noteBotReview("root-g", row, ["my-reviewer"]);
    const changed = { ...row, humanReview: { ...row.humanReview!, people: [{ login: "My-Reviewer", state: "approved" as const }] } };
    expect(noteBotReview("root-g", changed, []), "the list is now empty: nothing extra counts as a bot").toBeNull();
    expect(noteBotReview("root-g", changed, ["my-reviewer"])).toMatchObject({ who: "My-Reviewer" });
  });
});
