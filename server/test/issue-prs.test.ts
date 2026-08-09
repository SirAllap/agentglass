/*
 * The pull requests an issue produced, read out of GitHub's timeline.
 *
 * A timeline is a LOG, not a state, and every rule pinned here is a consequence
 * of that: the same pull request appears as many times as things happened to
 * it, in the order they happened, and only the sum is true. Reading the first
 * event, or the last, gets a different answer from reading all of them.
 *
 * The other half of what this protects is the distinction between the two
 * kinds of reference. A pull request LINKED to an issue will close it; one that
 * merely mentions `#12` in a comment has promised nothing. Showing the second
 * as the first is a fix somebody is told to expect and nobody is writing.
 */
import { describe, expect, it } from "bun:test";
import { prsFromTimeline } from "../src/issues.ts";

const pr = (number: number, over: Record<string, unknown> = {}) => ({
  number, title: `pr ${number}`, state: "OPEN", url: `https://github.com/o/r/pull/${number}`, ...over,
});

const connected = (n: number, over = {}) => ({ __typename: "ConnectedEvent", subject: pr(n, over) });
const mentioned = (n: number, over = {}) => ({ __typename: "CrossReferencedEvent", source: pr(n, over) });
const disconnected = (n: number) => ({ __typename: "DisconnectedEvent", subject: { number: n } });

describe("what the timeline says about an issue's pull requests", () => {
  it("tells a link apart from a mention", () => {
    const out = prsFromTimeline([connected(7), mentioned(9)]);
    expect(out.find((p) => p.number === 7)!.linked).toBe(true);
    expect(out.find((p) => p.number === 9)!.linked).toBe(false);
  });

  it("carries the state and the draft flag through", () => {
    const [only] = prsFromTimeline([connected(7, { state: "merged", isDraft: true })]);
    expect(only!.state).toBe("MERGED");
    expect(only!.draft).toBe(true);
    expect(only!.title).toBe("pr 7");
  });

  it("honours an unlink rather than advertising it forever", () => {
    // The ConnectedEvent stays in the log after somebody detaches the pull
    // request. Reading the log without this leaves the issue pointing at work
    // that was deliberately taken off it.
    expect(prsFromTimeline([connected(7), disconnected(7)])).toEqual([]);
  });

  it("takes a re-link as the later word", () => {
    expect(prsFromTimeline([connected(7), disconnected(7), connected(7)]).map((p) => p.number)).toEqual([7]);
  });

  it("does not let a mention downgrade a link, whichever came last", () => {
    // Closing an issue and then mentioning it in a comment is ordinary, and the
    // events arrive in that order.
    const [only] = prsFromTimeline([connected(7), mentioned(7)]);
    expect(only!.linked).toBe(true);
    expect(prsFromTimeline([mentioned(7), connected(7)])[0]!.linked).toBe(true);
  });

  it("lists each pull request once however often it appears", () => {
    expect(prsFromTimeline([mentioned(7), mentioned(7), connected(7)]).length).toBe(1);
  });

  it("skips a node that is not a pull request", () => {
    // An issue cross-referencing another issue matches no inline fragment, so
    // the node arrives with nothing in it. Null nodes come from GraphQL too.
    expect(prsFromTimeline([{ __typename: "CrossReferencedEvent" }, null, undefined, {}])).toEqual([]);
  });

  it("skips a pull request with no address, since there is nowhere to send a click", () => {
    expect(prsFromTimeline([{ __typename: "ConnectedEvent", subject: { number: 7, title: "x" } }])).toEqual([]);
  });

  it("puts what closes the issue first, then the newest", () => {
    const out = prsFromTimeline([mentioned(30), connected(4), mentioned(12)]);
    expect(out.map((p) => p.number)).toEqual([4, 30, 12]);
  });

  it("says nothing about an issue nothing has touched", () => {
    expect(prsFromTimeline([])).toEqual([]);
  });
});
