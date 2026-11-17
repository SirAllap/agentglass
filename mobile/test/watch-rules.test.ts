/*
 * The watch sheet's rules — as the rules the server ends up storing.
 *
 * The rules live on the computer and outlive this phone, so the sheet is a view
 * of state it did not create: it opens by reading what is armed, and Done posts
 * the DIFFERENCE. Both halves are checked here as data, because both are the
 * kind of thing a screen gets subtly wrong and nobody notices until somebody
 * waits for a buzz that was never armed:
 *
 *   - a switch that builds a rule the server refuses, or a skip list it will
 *     trim behind the sheet's back;
 *   - a second press that arms the same rule twice, or a rule turned off that
 *     stays on because only additions were posted.
 *
 * Fixtures are hand-built `PrWatch` rows — the server's own shape — never
 * another module's output.
 */
import { describe, expect, test } from "bun:test";
import type { PrWatch, PrWatchRule } from "../../shared/types.ts";
import {
  MAX_IGNORE, NO_RULES, SAME_FOR_NEW_SUB, WATCH_KINDS, addBody, armedLine, defaultBody, draftOf,
  liveLine, ruleOf, rulesOf, skipNames, writesFor, type WatchDraft,
} from "../src/model/watchRules.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");

const watch = (id: string, rule: PrWatchRule, over: Partial<PrWatch> = {}): PrWatch => ({
  id, repo: "acme/orbit", number: 184, rule, active: true, ...over,
});

const draft = (over: Partial<WatchDraft> = {}): WatchDraft => ({ ...NO_RULES, ...over });

describe("the rules the sheet offers", () => {
  test("are the three the mock draws, and each says whether it stays on", () => {
    expect(WATCH_KINDS.map((k) => k.id)).toEqual(["green", "fails", "comments"]);
    // A CI rule fires once and turns itself off; a comment rule is sticky.
    expect(WATCH_KINDS.map((k) => [k.id, k.once])).toEqual([
      ["green", true], ["fails", true], ["comments", false],
    ]);
  });

  test("build the rule type the server keeps for each", () => {
    expect(ruleOf("green", draft({ skip: "" }))).toEqual({ type: "ci-pass" });
    expect(ruleOf("fails", draft())).toEqual({ type: "ci-fail" });
    expect(ruleOf("comments", draft())).toEqual({ type: "comment" });
  });

  test("carry the skip list on the green rule only", () => {
    const rules = rulesOf(draft({ green: true, fails: true, comments: true, skip: "docs-lint, changelog" }));
    expect(rules).toEqual([
      { type: "ci-pass", ignore: ["docs-lint", "changelog"] },
      { type: "ci-fail" },
      { type: "comment" },
    ]);
    // A skip list typed with only "Something fails" on arms nothing: the field
    // belongs to `ci-pass.ignore`, and the server's `ci-fail` has no names.
    expect(rulesOf(draft({ fails: true, skip: "docs-lint" }))).toEqual([{ type: "ci-fail" }]);
  });
});

describe("the skip list", () => {
  test("is trimmed, without empties or repeats, in the order typed", () => {
    expect(skipNames("docs-lint,  changelog ,, docs-lint\n evals ")).toEqual([
      "docs-lint", "changelog", "evals",
    ]);
  });

  test("stops at the server's own cap of 30", () => {
    const many = Array.from({ length: 40 }, (_, i) => `job-${i}`).join(",");
    const names = skipNames(many);
    expect(names.length).toBe(MAX_IGNORE);
    expect(names.at(-1)).toBe("job-29");
  });

  test("cuts one name at 200 characters, as `coerceRule` does", () => {
    expect(skipNames("x".repeat(300))[0]?.length).toBe(200);
  });
});

describe("reading the server's state back", () => {
  test("turns the armed rules into the switches the sheet draws", () => {
    const got = draftOf({
      watches: [
        watch("w1", { type: "ci-pass", ignore: ["docs-lint"] }),
        watch("w2", { type: "ci-fail" }),
        watch("w3", { type: "comment" }, { active: false }),
      ],
      preset: { rules: [{ type: "ci-fail" }], auto: true },
    });
    expect(got).toEqual({ green: true, fails: true, comments: false, skip: "docs-lint", sameForNew: true });
  });

  test("a saved preset that is not applied to new PRs is not a standing order", () => {
    expect(draftOf({ watches: [], preset: { rules: [{ type: "ci-pass" }], auto: false } })).toEqual(NO_RULES);
    expect(draftOf({ watches: [], preset: null }).sameForNew).toBe(false);
  });

  test("says what a fired one-shot rule did, rather than showing it as armed", () => {
    const fired = watch("w1", { type: "ci-fail" }, { active: false, lastAt: NOW - 12 * 60_000, lastText: "CI failed" });
    expect(armedLine(fired, NOW)).toBe("Fails · CI failed · 12m ago");
    expect(armedLine(watch("w2", { type: "ci-pass", ignore: ["docs-lint", "labels"] }), NOW)).toBe("Green · armed · 2 skipped");
  });
});

describe("Done posts the difference", () => {
  const armed = {
    watches: [watch("w-green", { type: "ci-pass" }), watch("w-comment", { type: "comment" })],
    preset: null,
  };

  test("a rule already armed with the same meaning is not posted again", () => {
    // The same list in another order, and with a repeat, is the same rule.
    const before = draft({ green: true, comments: true });
    const after = draft({ green: true, comments: true, skip: "" });
    expect(writesFor(after, armed, before)).toEqual({ add: [], remove: [], preset: null });
  });

  test("turning one off removes it by its id and leaves the others alone", () => {
    const writes = writesFor(draft({ green: true }), armed, draft({ green: true, comments: true }));
    expect(writes.add).toEqual([]);
    expect(writes.remove).toEqual(["w-comment"]);
  });

  test("a skip list typed onto an armed green rule IS a change", () => {
    const writes = writesFor(
      draft({ green: true, comments: true, skip: "docs-lint" }),
      armed,
      draft({ green: true, comments: true }),
    );
    expect(writes.add).toEqual([{ type: "ci-pass", ignore: ["docs-lint"] }]);
    // The armed rule is replaced, not removed and re-added: `addWatch` keys a
    // watch without its skip list.
    expect(writes.remove).toEqual([]);
  });

  test("a rule the server has never seen is added once", () => {
    const writes = writesFor(draft({ fails: true }), { watches: [], preset: null }, NO_RULES);
    expect(writes.add).toEqual([{ type: "ci-fail" }]);
  });

  test("the repo default is written only when the switch moved", () => {
    expect(writesFor(draft({ green: true }), armed, draft({ green: true })).preset).toBeNull();
    expect(writesFor(draft({ green: true, sameForNew: true }), armed, draft({ green: true })).preset)
      .toEqual({ rules: [{ type: "ci-pass" }], auto: true });
    // Turning it off keeps the PR's own rules and clears the default.
    expect(writesFor(draft({ green: true }), armed, draft({ green: true, sameForNew: true })).preset)
      .toEqual({ rules: [{ type: "ci-pass" }], auto: false });
    expect(SAME_FOR_NEW_SUB).toContain("starts with the rules above");
  });
});

describe("the bodies the routes take", () => {
  const pr = { root: "/home/dev/code/orbit", repo: "acme/orbit", number: 184, title: "Add dark mode" };

  test("an add names the pull request and the rule and nothing else", () => {
    expect(addBody(pr, { type: "ci-pass", ignore: ["docs-lint"] })).toEqual({
      root: "/home/dev/code/orbit", number: 184, title: "Add dark mode",
      rule: { type: "ci-pass", ignore: ["docs-lint"] },
    });
  });

  test("a default names the repository, its rules and whether new PRs follow it", () => {
    expect(defaultBody("acme/orbit", [{ type: "ci-fail" }], true)).toEqual({
      repo: "acme/orbit", rules: [{ type: "ci-fail" }], auto: true,
    });
  });

  test("a default is capped at the rules one pull request may hold", () => {
    const many: PrWatchRule[] = Array.from({ length: 25 }, (_, i) => ({ type: "check", match: `job-${i}`, on: "fail" }));
    expect(defaultBody("acme/orbit", many, true).rules.length).toBe(20);
  });
});

/* The live line under each rule (mock 40): what it is doing right now. */
describe("what each rule says under its switch", () => {
  test("off says what the phone will stay quiet about, not just 'off'", () => {
    expect(liveLine("fails", draft(), [], NOW)).toBe("Off · failures are not sent");
    expect(liveLine("comments", draft(), [], NOW)).toBe("Off · comments are not sent");
    expect(liveLine("green", draft(), [], NOW)).toBe("Off · the checks are still read");
  });

  test("an armed failure rule with a history says when the last one was", () => {
    const armed = [watch("w1", { type: "ci-fail" }, { lastAt: NOW - 12 * 60_000, lastText: "fired" })];
    expect(liveLine("fails", draft({ fails: true }), armed, NOW)).toBe("Armed · the last failure was 12m ago");
  });

  test("a green rule counts the checks that never block it", () => {
    expect(liveLine("green", draft({ green: true, skip: "docs-lint, changelog" }), [], NOW))
      .toBe("Armed · 2 checks never block it");
    expect(liveLine("green", draft({ green: true }), [], NOW))
      .toBe("Armed · fires once, the next time every check is green");
  });

  test("an armed green rule with the run in hand says where the run stands", () => {
    expect(liveLine("green", draft({ green: true }), [], NOW, { passed: 49, total: 49, running: 0 }))
      .toBe("49/49 green, 0 running");
    expect(liveLine("green", draft({ green: true, skip: "docs-lint" }), [], NOW, { passed: 48, total: 49, running: 1 }))
      .toBe("48/49 green, 1 running · 1 never blocks it");
    // Off still says what the phone will not do, even with the run in hand.
    expect(liveLine("green", draft(), [], NOW, { passed: 49, total: 49, running: 0 }))
      .toBe("Off · the checks are still read");
  });

  test("a comment rule that is on says where the next one lands", () => {
    expect(liveLine("comments", draft({ comments: true }), [], NOW)).toBe("On · the next comment reaches this phone");
  });
});
