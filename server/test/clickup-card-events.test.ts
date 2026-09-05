/*
 * A card's own history, from the two things a personal API token will answer.
 *
 * What is NOT here was measured against a real workspace before any of this was
 * written: `GET /task/{id}/history` and `/activity` are 404 on both v1 and v2, the
 * task payload carries no `history_items`, and the audit-log endpoint answers 404
 * on this plan. So ClickUp's field-by-field feed — "set Urgency to High", "ClickBot
 * added tag bug-intake" — cannot be read by an app holding a token, and nothing
 * here pretends to have it.
 *
 * What can be read is `creator` + `date_created`, and `time_in_status`, which
 * answers with every status the card has been in and the moment it entered. The
 * fixture below is the shape a real card returned, including the two details that
 * decide the whole mapping: `since` is a STRING of milliseconds, and the first
 * status's timestamp is the card's creation to within a few milliseconds.
 */
import { describe, test, expect } from "bun:test";
import { cardEvents } from "../src/clickup.ts";

const CREATED = 1785534599428;
const task = { creator: { username: "Karla V" }, date_created: String(CREATED) };

const time = {
  current_status: { status: "in development", color: "#f9c64d", total_time: { since: "1786696449054" } },
  status_history: [
    { status: "to do", color: "#87909e", total_time: { since: "1785534599435" } },
    { status: "ready for engineering", color: "#f5da9a", total_time: { since: "1785783750693" } },
    { status: "in development", color: "#f9c64d", total_time: { since: "1786696449054" } },
  ],
};

describe("cardEvents", () => {
  test("the first status is the creation, not a move", () => {
    const out = cardEvents(task, time);
    // Four status rows would be four events; the first one is the card appearing.
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ at: CREATED, kind: "created", who: "Karla V", status: "to do", color: "#87909e" });
  });

  test("every move carries where it came from", () => {
    const out = cardEvents(task, time);
    expect(out[1]).toMatchObject({ kind: "status", from: "to do", status: "ready for engineering" });
    expect(out[2]).toMatchObject({ kind: "status", from: "ready for engineering", status: "in development" });
  });

  test("a move never claims a person, because the API does not name one", () => {
    for (const e of cardEvents(task, time).filter((x) => x.kind === "status")) {
      expect(e.who).toBeUndefined();
    }
  });

  test("oldest first, whatever order the workspace sent", () => {
    const shuffled = { ...time, status_history: [...time.status_history].reverse() };
    const out = cardEvents(task, shuffled);
    expect(out.map((e) => e.at)).toEqual([...out.map((e) => e.at)].sort((a, b) => a - b));
    expect(out[0]!.kind).toBe("created");
  });

  test("a card that has never moved still says when it opened, and where", () => {
    const out = cardEvents(task, { current_status: { status: "to do", color: "#87909e", total_time: { since: String(CREATED) } }, status_history: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "created", status: "to do" });
  });

  test("no history at all is still a creation", () => {
    const out = cardEvents(task, undefined);
    expect(out).toEqual([{ at: CREATED, kind: "created", who: "Karla V" }]);
  });

  test("an unreadable timestamp drops its row rather than landing in 1970", () => {
    const out = cardEvents(task, {
      status_history: [
        { status: "to do", total_time: { since: String(CREATED) } },
        { status: "nowhere", total_time: { since: "not a number" } },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out.every((e) => e.at > 0)).toBe(true);
  });

  test("and a card with no creator named is not a card with no history", () => {
    const out = cardEvents({ date_created: String(CREATED) }, time);
    expect(out[0]!.who).toBeUndefined();
    expect(out).toHaveLength(3);
  });
});

/*
 * HOW LONG IT SAT THERE, AND THE FACE WHERE THERE IS ONE.
 *
 * `time_in_status` is the only thing the public API adds over the payload, and
 * `by_minute` is what it counts. The creation is also the one event that names
 * a person — and now carries their picture, the way a comment's author does.
 */
test("a move says how long the card sat in the status it left", () => {
  const out = cardEvents(
    { creator: { username: "Ada Kowalski", profilePicture: "https://example.test/ada.png" }, date_created: "1000" },
    {
      status_history: [
        { status: "to do", color: "#87909e", total_time: { since: "1000", by_minute: 169 } },
        { status: "in qa", color: "#f9d900", total_time: { since: "2000", by_minute: 5760 } },
        { status: "qa complete", color: "#e91e63", total_time: { since: "3000", by_minute: 12 } },
      ],
    },
  );
  expect(out[0]!.kind).toBe("created");
  expect(out[0]!.avatar).toBe("https://example.test/ada.png");
  /* Each move reports the clock that just STOPPED, not the one starting. */
  expect(out[1]!.mins).toBe(169);
  expect(out[2]!.mins).toBe(5760);
});

test("and a status with no clock on it simply has none — no zero on the row", () => {
  const out = cardEvents({ date_created: "1000" }, {
    status_history: [
      { status: "to do", total_time: { since: "1000" } },
      { status: "in qa", total_time: { since: "2000" } },
    ],
  });
  expect(out[1]!.mins).toBeUndefined();
});

test("nothing invents a person for a move", () => {
  const out = cardEvents({ creator: { username: "Ada Kowalski" }, date_created: "1000" }, {
    status_history: [
      { status: "to do", total_time: { since: "1000", by_minute: 5 } },
      { status: "done", total_time: { since: "2000", by_minute: 5 } },
    ],
  });
  expect(out[1]!.who, "a move must never carry a name the API did not give").toBeUndefined();
});
