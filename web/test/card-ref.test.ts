// Reading the ClickUp card out of a pull request that never says it has one.
//
// The fixture is modelled on a real pull request of a team that works this way:
// a branch named for the card, a template whose checklist links a card of its
// OWN, and a reference section with the address in it. Ids and addresses here
// are invented; the SHAPE is what was measured, and every rule below exists
// because of something in it.
import { describe, expect, it } from "bun:test";
import { cardRef, chipAction, looksLikeOurs } from "../src/lib/cardRef.ts";

/*
 * A pull-request template, trimmed to the three parts that matter: a checklist
 * that links a card of its own, the real reference below it, and prose.
 *
 * The checklist line is why this file exists. Taking the first ClickUp address
 * in the body sent twelve of fourteen real pull requests to the SAME card —
 * every one that had ticked that box — and each of them looked right, because
 * the chip was labelled from the branch.
 */
const BODY = `## Checklist

- [x] I have followed the checks before submitting a pull request.
- [x] (Optional) Add the "compact review" label — trial only, see [ORBIT-3306](https://clickup.com/t/8ab99zz01).

## Card reference

https://clickup.com/t/8ab12cd34

## Context

Clicking the callback link failed with an endless spinner.`;

describe("what a pull request says about its card", () => {
  it("takes the id from the branch and the address from the body", () => {
    // The label is what people say out loud; the query is the id that needs no
    // custom-id lookup to resolve. Both, from two different places.
    const ref = cardRef({
      headRefName: "ORBIT-1042-callback-link-fails-with-a-spinner",
      title: "Callback link fails with an endless spinner",
      body: BODY,
    });
    expect(ref).toMatchObject({
      label: "ORBIT-1042",
      query: "8ab12cd34",
      url: "https://clickup.com/t/8ab12cd34",
      from: "url",
    });
  });

  it("does not follow the template's own card", () => {
    // Measured, not guessed: this is the line that put twelve pull requests on
    // one card. It is skipped for its SHAPE — a checklist item — so a template
    // that words it differently is skipped too.
    expect(cardRef({ headRefName: "ORBIT-1042-x", body: BODY })!.query).toBe("8ab12cd34");
  });

  it("never picks a bare id out of the body", () => {
    // With the addresses gone, ORBIT-3306 is still sitting in the prose. Ids
    // are read from the branch and the title, never from what somebody wrote.
    const noLinks = BODY.replace(/\(https:[^)]+\)|https:\S+/g, "");
    expect(cardRef({ headRefName: "fix/spinner", title: "Fix the spinner", body: noLinks })).toBe(null);
  });

  it("refuses to choose when the body names two cards", () => {
    // A real one: a pull request whose description links its own card and, far
    // below, "([ORBIT backfill card](…))". Nothing here can tell which is meant,
    // so it falls back to the id on the branch — which names this one.
    const two = `${BODY}\n\nSplit out of ([ORBIT backfill card](https://clickup.com/t/8ab77yy02)).`;
    expect(cardRef({ headRefName: "ORBIT-2317-cart-totals", body: two }))
      .toMatchObject({ label: "ORBIT-2317", query: "ORBIT-2317", from: "branch" });
  });

  it("says nothing when it can neither choose nor read a branch", () => {
    const two = `${BODY}\n\nAlso https://clickup.com/t/8ab77yy02`;
    expect(cardRef({ headRefName: "fix/spinner", title: "Fix the spinner", body: two })).toBe(null);
  });

  it("ignores an address somebody is quoting", () => {
    expect(cardRef({ headRefName: "fix/spinner", body: "> was this https://clickup.com/t/8ab12cd34 ?" }))
      .toBe(null);
  });

  it("falls back to the address's own id when nothing is named", () => {
    const ref = cardRef({ headRefName: "fix/spinner", body: "see https://clickup.com/t/8ab12cd34" });
    expect(ref).toMatchObject({ label: "8ab12cd34", query: "8ab12cd34", from: "url" });
  });

  it("takes the task, not the workspace, out of a two-segment address", () => {
    // `/t/<team>/<id>` is what a workspace with custom ids hands out. The first
    // segment is the team; asking for a card by team number finds nothing.
    const ref = cardRef({ body: "https://clickup.com/t/9012345678/ORBIT-1042" });
    expect(ref).toMatchObject({ label: "ORBIT-1042", query: "ORBIT-1042" });
  });

  it("reads the branch when the body never mentions ClickUp", () => {
    const ref = cardRef({ headRefName: "ORBIT-1042-fix-the-thing", body: "No template here." });
    expect(ref).toMatchObject({ label: "ORBIT-1042", query: "ORBIT-1042", from: "branch" });
    expect(ref?.url).toBeUndefined();
  });

  it("reads the title when the branch is nameless", () => {
    const ref = cardRef({ headRefName: "fix/spinner", title: "[ORBIT-1042] Fix the spinner" });
    expect(ref).toMatchObject({ label: "ORBIT-1042", from: "title" });
  });

  it("says nothing about a pull request that is about nothing", () => {
    expect(cardRef({ headRefName: "feat/rail-layout", title: "Rail layout", body: "" })).toBe(null);
  });

  it("leaves ordinary branch names alone", () => {
    // Each of these has the shape of an id somewhere in it and is not one. The
    // dependabot line is the one that decided the capitals rule.
    for (const branch of [
      "fix/UTF-8-decode",
      "release/v2-1409",
      "dependabot/npm_and_yarn/types/node-22-10-1",
      "renovate/lock-file-maintenance",
      "feat/agent-v2",
    ]) {
      expect(cardRef({ headRefName: branch })).toBe(null);
    }
  });
});

describe("whether an id belongs to the workspace we are connected to", () => {
  const branchRef = cardRef({ headRefName: "ABC-4321-something" })!;

  it("takes an address at its word", () => {
    // Nothing but ClickUp writes clickup.com, so no prefix has a vote here.
    const ref = cardRef({ body: "https://clickup.com/t/8ab12cd34" })!;
    expect(looksLikeOurs(ref, "ORBIT-")).toBe(true);
  });

  it("keeps another tracker's ids off a ClickUp mark", () => {
    expect(looksLikeOurs(branchRef, "ORBIT-")).toBe(false);
    expect(looksLikeOurs(cardRef({ headRefName: "ORBIT-1042-x" })!, "ORBIT-")).toBe(true);
  });

  it("does not use a prefix it has not learnt yet", () => {
    // Empty is "no board read this session", not "this workspace has no
    // prefix". Refusing on it would make the chip come and go with a cache.
    expect(looksLikeOurs(branchRef, undefined)).toBe(true);
    expect(looksLikeOurs(branchRef, "")).toBe(true);
  });
});

/*
 * What the chip does, on machines that are not the author's.
 *
 * Every rule below already existed and none of them fired, because the value
 * the caller weighed them against was a count of saved boards — and the
 * built-in "Assigned to me" board is always in that list, token or no token.
 * So `boards > 0` was true everywhere, and a repository that has never heard
 * of ClickUp got ClickUp's own mark on a branch called `ABC-1234-thing`.
 *
 * These are written against the machine, not against the id: the same pull
 * request has to produce three different chips depending on what is connected.
 */
describe("what the chip should do, given what this machine has", () => {
  const jira = cardRef({ headRefName: "ABC-1234-rounding-error" });
  const ours = cardRef({ headRefName: "ORBIT-1042-rounding-error" });
  const addressed = cardRef({ body: "https://clickup.com/t/8ab12cd34" });

  it("says nothing at all on a machine with no ClickUp", () => {
    // The case this whole function exists for. A Jira shop, a Linear shop,
    // somebody with no tracker: an id in a branch name is not ours to claim.
    expect(chipAction(jira, { connected: false })).toBe(null);
    expect(chipAction(ours, { connected: false })).toBe(null);
  });

  it("still opens an address on a machine with no ClickUp", () => {
    // A URL needs nobody's credentials, and the body naming one is a fact
    // rather than a convention. Out to the browser, since there is no board
    // here to land in.
    expect(chipAction(addressed, { connected: false }))
      .toEqual({ in: "clickup", url: "https://clickup.com/t/8ab12cd34" });
  });

  it("opens the card here once ClickUp is connected", () => {
    expect(chipAction(ours, { connected: true, prefix: "ORBIT-" })).toEqual({ in: "tasks" });
    expect(chipAction(addressed, { connected: true, prefix: "ORBIT-" })).toEqual({ in: "tasks" });
  });

  it("keeps another tracker's ids off the mark even with ClickUp connected", () => {
    // Somebody who has ClickUp AND a repository whose branches are named for
    // Jira. The prefix is what separates them.
    expect(chipAction(jira, { connected: true, prefix: "ORBIT-" })).toBe(null);
  });

  it("says nothing while the answer is still in flight", () => {
    // Null setup is "not known yet", never "no" — which is what stops the chip
    // appearing and then vanishing a beat later.
    expect(chipAction(ours, null)).toBe(null);
    expect(chipAction(null, { connected: true })).toBe(null);
  });
});
