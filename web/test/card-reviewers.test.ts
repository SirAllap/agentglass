/*
 * Who the board card's header draws a face for, and what it says about them.
 * A pure decision, asserted alone: there is no renderer in the tests, so the
 * order, the cap, the tooltip and the sentence live in a function.
 */
import { describe, expect, test } from "bun:test";
import { CARD_FACES_MAX, cardReviewers, facesAria, moreTitle, waitingLine } from "../src/lib/cardReviewers.ts";

const hr = (kind: string, people: { login: string; state: string; team?: boolean }[], o: object = {}) =>
  ({ kind, who: people.map((p) => p.login), people, ...o });
const logins = (r: ReturnType<typeof cardReviewers>) => r.faces.map((f) => f.login);

describe("one face per person, in reading order", () => {
  test("one reviewer, never answered", () => {
    const r = cardReviewers(hr("awaiting", [{ login: "mkovac", state: "await" }]));
    expect(r.faces).toEqual([{ login: "mkovac", state: "await", team: false, title: "mkovac — review requested, not answered yet" }]);
    expect(r.more).toEqual([]);
    expect(waitingLine(r)).toBeNull();
  });

  test("two: one re-requested, one never answered, reads as two reviewers", () => {
    const r = cardReviewers(hr("changes", [{ login: "tlindqvist", state: "again" }, { login: "rnakamura", state: "await" }], { cleared: true }));
    expect(logins(r)).toEqual(["tlindqvist", "rnakamura"]);
    expect(r.faces.map((f) => f.title)).toEqual([
      "tlindqvist — re-review requested",
      "rnakamura — review requested, not answered yet",
    ]);
    expect(waitingLine(r)).toBe("Waiting on 2 reviewers");
  });

  test("five: three faces and the other two behind the +N", () => {
    const five = ["a1", "b2", "c3", "d4", "e5"].map((login) => ({ login, state: "await" }));
    const r = cardReviewers(hr("awaiting", five));
    expect(CARD_FACES_MAX).toBe(3);
    expect(logins(r)).toEqual(["a1", "b2", "c3"]);
    expect(r.more.map((f) => f.login)).toEqual(["d4", "e5"]);
    expect(moreTitle(r)).toBe("d4 — review requested, not answered yet\ne5 — review requested, not answered yet");
    expect(waitingLine(r)).toBe("Waiting on 5 reviewers");
  });

  test("exactly four is three faces and +1, never four faces", () => {
    const r = cardReviewers(hr("awaiting", ["a", "b", "c", "d"].map((login) => ({ login, state: "await" }))));
    expect(r.faces).toHaveLength(3);
    expect(r.more).toHaveLength(1);
  });

  test("mixed: blocking first, then the ball with someone, then not answered, then done", () => {
    const r = cardReviewers(hr("changes", [
      { login: "ofarah", state: "approved" }, { login: "rnakamura", state: "await" },
      { login: "tlindqvist", state: "changes" }, { login: "pbrandt", state: "again" },
    ]));
    expect([...r.faces, ...r.more].map((f) => f.login)).toEqual(["tlindqvist", "pbrandt", "rnakamura", "ofarah"]);
  });

  test("an approval does not push a waiting person out of the faces when it can be helped", () => {
    const r = cardReviewers(hr("approved", [
      { login: "a", state: "approved" }, { login: "b", state: "approved" }, { login: "c", state: "approved" }, { login: "d", state: "await" },
    ]));
    expect(logins(r)).toContain("d");
    expect(r.more.map((f) => f.state)).toEqual(["approved"]);
  });

  test("inside one state the server's order stands", () => {
    const r = cardReviewers(hr("awaiting", [{ login: "z", state: "await" }, { login: "a", state: "await" }]));
    expect(logins(r)).toEqual(["z", "a"]);
  });

  test("a team keeps its name in the tooltip", () => {
    const r = cardReviewers(hr("awaiting", [{ login: "platform", state: "await", team: true }]));
    expect(r.faces[0]).toMatchObject({ team: true, title: "platform (team) — review requested, not answered yet" });
  });

  test("the sentence counts everyone owing an answer, not everyone drawn", () => {
    const r = cardReviewers(hr("changes", [
      { login: "tlindqvist", state: "changes" }, { login: "rnakamura", state: "await" }, { login: "ofarah", state: "approved" }, { login: "pbrandt", state: "again" },
    ]));
    expect(waitingLine(r)).toBe("Waiting on 2 reviewers");
  });

  test("the accessible name lists every person, including the ones behind +N", () => {
    const r = cardReviewers(hr("awaiting", ["a", "b", "c", "d"].map((login) => ({ login, state: "await" }))));
    expect(facesAria(r)).toBe("a (review requested, not answered yet), b (review requested, not answered yet), c (review requested, not answered yet), d (review requested, not answered yet)");
  });
});

describe("a row from a server that does not send `people` yet", () => {
  test("awaiting, approved and commented keep the faces they had, now with a state", () => {
    expect(cardReviewers({ kind: "awaiting", who: ["a", "b"] }).faces.map((f) => f.state)).toEqual(["await", "await"]);
    expect(cardReviewers({ kind: "approved", who: ["a"] }).faces.map((f) => f.state)).toEqual(["approved"]);
    expect(cardReviewers({ kind: "commented", who: ["a"] }).faces.map((f) => f.state)).toEqual(["comment"]);
  });

  test("changes is red, and amber once every requester was asked again", () => {
    expect(cardReviewers({ kind: "changes", who: ["a"] }).faces[0]!.state).toBe("changes");
    expect(cardReviewers({ kind: "changes", who: ["a"], cleared: true }).faces[0]!.state).toBe("again");
  });
});

describe("shapes that are not a verdict draw nothing and do not throw", () => {
  test.each([null, undefined, "approved", 3, {}, { kind: "awaiting" }, { people: "x" }, { people: [null, 4, { login: "a" }, { state: "await" }, { login: "", state: "await" }] }])(
    "%p", (raw) => {
      const r = cardReviewers(raw);
      expect(r.faces).toEqual([]);
      expect(r.more).toEqual([]);
      expect(waitingLine(r)).toBeNull();
    },
  );

  test("a person is listed once, whatever the case, and an unknown state is skipped", () => {
    const r = cardReviewers({ kind: "awaiting", who: [], people: [{ login: "Okoro", state: "await" }, { login: "okoro", state: "again" }, { login: "x", state: "weird" }] });
    expect(r.faces.map((f) => f.login)).toEqual(["Okoro"]);
  });
});
