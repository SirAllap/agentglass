/*
 * The PR writes as data: two lists, add against remove, and the sentences the
 * controls owe the person.
 *
 * Fixtures are hand-built pull requests with invented names, never the
 * server's answer, so a change here cannot agree with a change to a route by
 * accident. There is no renderer in this project; what a screen draws from
 * these values is asserted as source text in `pr-write-scope.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { PrDetail } from "../../shared/types.ts";
import {
  draftAction, editPatch, findLabels, findReviewers, labelChoices, labelDiff, labelsOf,
  reviewerChoices, reviewerDiff, reviewersOf, stateAction, writeBlocked,
} from "../src/model/prManage.ts";

const detail = (o: Partial<PrDetail> = {}): Pick<PrDetail, "labels" | "reviewers" | "title" | "body" | "state"> => ({
  labels: [], reviewers: [], title: "Phone: the lane drawer", body: "Keeps its place.", state: "OPEN", ...o,
});

describe("labels and reviewers are two lists, add against remove", () => {
  test("a ticked label that was not there is added; an unticked one that was is removed", () => {
    expect(labelDiff(["settings", "theme"], ["settings", "phone"]))
      .toEqual({ add: ["phone"], remove: ["theme"] });
  });

  test("nothing moved is two empty lists, which is what a disabled Save reads", () => {
    expect(labelDiff(["settings"], ["settings"])).toEqual({ add: [], remove: [] });
  });

  test("unticking everything removes everything, in the pull request's own order", () => {
    expect(labelDiff(["theme", "settings", "phone"], [])).toEqual({
      add: [],
      remove: ["theme", "settings", "phone"],
    });
  });

  test("a reviewer request is the same two lists and its own function", () => {
    expect(reviewerDiff(["ana", "sam"], ["ana", "noa"])).toEqual({ add: ["noa"], remove: ["sam"] });
  });

  test("the pull request's labels are read by name, and reviewers by login", () => {
    expect(labelsOf(detail({ labels: [{ name: "theme", color: "ff0000" }, { name: "phone" }] })))
      .toEqual(["theme", "phone"]);
    expect(reviewersOf(detail({ reviewers: [{ login: "ana" }, { login: "design", isTeam: true }] })))
      .toEqual(["ana", "design"]);
  });
});

describe("the label picker", () => {
  test("the repository's order is kept, never re-sorted", () => {
    const rows = labelChoices(
      [{ name: "settings" }, { name: "theme" }, { name: "phone" }],
      ["theme"],
    );
    expect(rows.map((r) => r.name)).toEqual(["settings", "theme", "phone"]);
    expect(rows.map((r) => r.on)).toEqual([false, true, false]);
  });

  test("a label the pull request has but the repository read did not is still removable", () => {
    const rows = labelChoices([{ name: "settings" }], ["settings", "old-name"]);
    expect(rows.map((r) => [r.name, r.on])).toEqual([["settings", true], ["old-name", true]]);
  });

  test("a duplicated name is drawn once", () => {
    expect(labelChoices([{ name: "theme" }, { name: "theme" }], ["theme"])).toHaveLength(1);
  });

  test("the finder is a case-insensitive substring and an empty search keeps the list", () => {
    const rows = labelChoices([{ name: "Needs QA" }, { name: "docs" }], []);
    expect(findLabels(rows, "qa").map((r) => r.name)).toEqual(["Needs QA"]);
    expect(findLabels(rows, "  ")).toHaveLength(2);
  });
});

describe("the reviewer picker", () => {
  test("people who could be asked are drawn once, with the asked ones ticked", () => {
    const rows = reviewerChoices(["ana", "noa", "rui"], ["ana"]);
    expect(rows.map((r) => [r.login, r.on]))
      .toEqual([["ana", true], ["noa", false], ["rui", false]]);
  });

  test("a team already asked stays in the list so Remove is reachable", () => {
    expect(reviewerChoices(["ana"], ["design"]).map((r) => [r.login, r.on]))
      .toEqual([["ana", false], ["design", true]]);
  });

  test("the finder searches logins", () => {
    const rows = reviewerChoices(["ana", "noa"], []);
    expect(findReviewers(rows, "no").map((r) => r.login)).toEqual(["noa"]);
  });
});

describe("close keeps the branch, and says so", () => {
  test("an open pull request closes, and the line says the branch stays", () => {
    const close = stateAction("OPEN")!;
    expect(close.verb).toBe("close");
    expect(close.line).toContain("branch stays");
    expect(close.line).toContain("Nothing merges");
  });

  test("a closed one reopens", () => {
    expect(stateAction("CLOSED")!.verb).toBe("reopen");
  });

  test("a merged one has neither control", () => {
    expect(stateAction("MERGED")).toBeNull();
  });
});

describe("draft toggles both ways", () => {
  test("an open pull request can be marked a draft, and the line says why that is safe", () => {
    const draft = draftAction(false);
    expect(draft).toMatchObject({ draft: true });
    expect(draft.line).toContain("cannot merge by accident");
  });

  test("a draft can be marked ready, and goes back in the same queue", () => {
    const ready = draftAction(true);
    expect(ready).toMatchObject({ draft: false });
    expect(ready.line).toContain("same queue");
  });
});

describe("editing the title and the body", () => {
  test("only the field that moved travels", () => {
    expect(editPatch(detail({ title: "One", body: "Body" }), "Two", "Body"))
      .toEqual({ changed: true, title: "Two" });
    expect(editPatch(detail({ title: "One", body: "Body" }), "One", "New body"))
      .toEqual({ changed: true, body: "New body" });
  });

  test("an unchanged save is nothing to send", () => {
    expect(editPatch(detail({ title: "One", body: "Body" }), "One", "Body"))
      .toEqual({ changed: false });
  });

  test("an empty body is a real edit: it clears the description", () => {
    expect(editPatch(detail({ title: "One", body: "Body" }), "One", ""))
      .toEqual({ changed: true, body: "" });
  });

  test("an empty title is refused here, before GitHub writes anything", () => {
    const patch = editPatch(detail({ title: "One" }), "   ", "");
    expect(patch.changed).toBe(false);
    expect(patch.problem).toContain("title");
  });

  test("a title is trimmed, because a leading space is not a title", () => {
    expect(editPatch(detail({ title: "One" }), "  Two  ", "Body").title).toBe("Two");
  });
});

describe("a phone that may not write", () => {
  test("read and answer pairings are told why, in one line", () => {
    for (const scope of ["read", "answer", null, undefined] as const) {
      const why = writeBlocked(scope);
      expect(why).not.toBeNull();
      expect(why).toContain("Everything");
    }
  });

  test("a full pairing is not blocked", () => {
    expect(writeBlocked("full")).toBeNull();
  });
});
