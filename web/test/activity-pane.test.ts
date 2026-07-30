/*
 * The Activity pane, and the two things it must not quietly drop.
 *
 * It is the only screen in the app that answers "who did that". Every rule here
 * is one where the failure is silent: a pane that reads one source instead of
 * two, or renders a name it was never given, looks exactly like a working one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const pane = src.slice(src.indexOf("function ActivityPane"), src.indexOf("const VERBS"));

describe("where it reads from", () => {
  test("both records, because neither is the whole story", () => {
    // A gate the timeout allowed is in the gates table and nowhere else: nobody
    // made a request, so the log of requests has nothing to show.
    expect(pane).toContain("api.actions(");
    expect(pane).toContain("api.gateHistory(");
  });

  test("merged by the rule rather than by whatever order they arrive in", () => {
    expect(pane).toContain("mergeActivity(");
  });
});

describe("what it says about a held tool call", () => {
  test("an outcome nobody chose is marked as one, not just worded as one", () => {
    // "approved" and "allowed" are one glance apart in a list of past-tense
    // verbs, and they mean opposite things about whether anybody looked.
    expect(pane).toMatch(/resolution !== "human"/);
    expect(pane).toContain("var(--warning)");
  });

  test("and the pane says so in the words the rule chose", () => {
    expect(pane).toContain("gateLine(");
  });

  test("the reason a person typed is shown, since it is nowhere else", () => {
    // The agent was given it and the action log never carried it.
    expect(pane).toMatch(/g\.resolution === "human" && g\.reason/);
  });
});

describe("who", () => {
  test("comes from the rule, not from reading the field in the markup", () => {
    // `decided_by` is empty on a timeout and on any row older than the column,
    // so reading it here is how "local" ends up printed over a decision nobody
    // made. The field belongs to lib/activity.ts and is named nowhere in this
    // file — including behind a `?? ""`, which is the version that looks safe.
    expect(pane.match(/actorLabel\(/g) ?? []).toHaveLength(2);
    expect(pane, "the pane is reading the actor fields itself").not.toContain("decided_by");
    expect(pane).not.toMatch(/\{a\.actor === "local"/);
  });

  test("and is rendered the same way for both kinds of row", () => {
    // Two spellings of the same column is how a git line and a gate line end up
    // disagreeing about what "no name" looks like.
    expect(pane.match(/<Who /g) ?? []).toHaveLength(2);
  });
});

describe("what it tells you about itself", () => {
  test("that the timeouts are in here too", () => {
    // Otherwise the list reads as "things I did", and the rows nobody did
    // become surprising rather than the point.
    // Whitespace-loose: the sentence is wrapped in the JSX, and a guard that
    // breaks when somebody reflows a paragraph teaches people to delete guards.
    expect(pane).toMatch(/the timeout\s+decided while nobody was looking/);
  });
});
