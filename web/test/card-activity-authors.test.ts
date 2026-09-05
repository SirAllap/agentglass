/*
 * WHO DID IT, AND WHEN.
 *
 * "I miss seeing who made those changes, with avatar and name if possible, the
 * way the ClickUp website shows it… we don't need to be exact either, since maybe
 * the API doesn't send that info, but at least who and when, yes."
 *
 * So this pins the two halves of that. What the API gives — the creator, the
 * author of a comment, and how long a card sat in each status — is drawn. What
 * it does not give is SAID rather than guessed: measured on 2026-09-01 with a
 * personal token, `/task/{id}/history` and `/task/{id}/activity` are 404 on
 * both v1 and v2, and the v1 route ClickUp's own web client uses answers
 * `JWT_008 — Auth header missing`. A status change carries no user at all.
 */
import { describe, expect, test } from "bun:test";
import { eventLine, spanLabel, seenActor, NO_AUTHOR_NOTE } from "../src/lib/cardActivity.ts";

describe("how long the card sat somewhere", () => {
  test("minutes, hours and days, in the shortest true form", () => {
    expect(spanLabel(0)).toBe("");
    expect(spanLabel(12)).toBe("12m");
    expect(spanLabel(60)).toBe("1h");
    expect(spanLabel(169)).toBe("2h 49m");
    expect(spanLabel(1440)).toBe("1d");
    expect(spanLabel(5760)).toBe("4d");
    expect(spanLabel(5940)).toBe("4d 3h");
  });

  test("rounded, never a fraction of a minute on a row this small", () => {
    expect(spanLabel(0.4)).toBe("");
    expect(spanLabel(59.6)).toBe("1h");
  });
});

describe("the name on a row", () => {
  test("the creation carries the person the API names", () => {
    expect(eventLine({ at: 1, kind: "created", who: "Ada Kowalski", status: "to do" }))
      .toBe("Ada Kowalski created this card in to do");
  });

  test("a move carries none, because the API names nobody", () => {
    const line = eventLine({ at: 2, kind: "status", from: "in qa", status: "qa complete" });
    expect(line).toBe("Moved from in qa to qa complete");
    expect(line).not.toContain("Somebody");
  });

  test("and the reason is written down where a reader can reach it", () => {
    expect(NO_AUTHOR_NOTE).toContain("does not say who moved a card");
    expect(NO_AUTHOR_NOTE).toContain("comments");
  });
});

/*
 * WHO A "SEEN HERE" LINE IS ABOUT.
 *
 * ClickUp writes its notifications starting with the person — "Irra assigned
 * this task to: javi" — and that sentence is the only place a name ever
 * appears on this timeline apart from the creation, because the API reports no
 * actor for anything else. He asked for the same treatment the creation row
 * gets: the face, and the name in the same weight.
 */
describe("the name a notification carries", () => {
  test("a one-word name is split off its verb", () => {
    expect(seenActor("javi set the status to: READY FOR QA"))
      .toEqual({ who: "javi", rest: "set the status to: READY FOR QA" });
  });

  test("and a two- or three-word name is not cut in half", () => {
    expect(seenActor("Alejandro Garcia assigned this task to you").who).toBe("Alejandro Garcia");
    expect(seenActor("Ada Lovelace Byron commented on this task").who).toBe("Ada Lovelace Byron");
  });

  test("a sentence that does not start with a person keeps its whole text", () => {
    const r = seenActor("Due date is tomorrow");
    expect(r.who, "a guess here puts somebody's face on somebody else's line").toBe("");
    expect(r.rest).toBe("Due date is tomorrow");
  });

  test("nothing in, nothing out", () => {
    expect(seenActor("")).toEqual({ who: "", rest: "" });
  });
});
