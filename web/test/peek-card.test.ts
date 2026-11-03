/*
 * The peek card opens after 450 ms, warm (at once, no entrance) within 300 ms of a close, and every hide event puts it away.
 */
import { describe, expect, test } from "bun:test";
import { PEEK_DELAY_MS, PEEK_HIDE_EVENTS, PEEK_IDLE, PEEK_WARM_MS, peekDelay, peekEnter, peekFire, peekHide, peekSentence, prText } from "../src/lib/peekCard.ts";

describe("delay", () => {
  test("cold: 450 ms, also when the last close is long ago", () => {
    expect(peekDelay(null, 1000)).toBe(PEEK_DELAY_MS);
    expect(peekDelay(1000, 1000 + PEEK_WARM_MS)).toBe(PEEK_DELAY_MS);
  });
  test("warm: 0 inside 300 ms of a close", () => {
    expect(peekDelay(1000, 1000 + PEEK_WARM_MS - 1)).toBe(0);
  });
});

describe("the machine", () => {
  test("enter waits, the timer opens it cold", () => {
    const a = peekEnter(PEEK_IDLE, "@1", 0);
    expect(a.wait).toBe(450);
    expect(a.state.shown).toBe(false);
    const b = peekFire(a.state, "@1");
    expect(b).toMatchObject({ id: "@1", shown: true, warm: false });
  });
  test("a pointer that left before the timer opens nothing", () => {
    const a = peekEnter(PEEK_IDLE, "@1", 0);
    const gone = peekHide(a.state, 100);
    expect(peekFire(gone, "@1").shown).toBe(false);
  });
  test("a timer for another tab is ignored", () => {
    const a = peekEnter(PEEK_IDLE, "@1", 0);
    const b = peekEnter(a.state, "@2", 50);
    expect(peekFire(b.state, "@1").shown).toBe(false);
    expect(peekFire(b.state, "@2").shown).toBe(true);
  });
  test("from one shown card to the next tab: at once and warm", () => {
    const shown = peekFire(peekEnter(PEEK_IDLE, "@1", 0).state, "@1");
    const next = peekEnter(shown, "@2", 1000);
    expect(next.wait).toBe(0);
    expect(next.state).toMatchObject({ id: "@2", shown: true, warm: true });
  });
  test("closing and entering another tab within 300 ms is warm, after it is cold", () => {
    const shown = peekFire(peekEnter(PEEK_IDLE, "@1", 0).state, "@1");
    const closed = peekHide(shown, 1000);
    expect(closed).toMatchObject({ shown: false, id: null, closedAt: 1000 });
    expect(peekEnter(closed, "@2", 1200)).toMatchObject({ wait: 0, state: { shown: true, warm: true } });
    expect(peekEnter(closed, "@2", 1400).wait).toBe(450);
  });
  test("hiding a card that never opened does not start the warm window", () => {
    const pending = peekEnter(PEEK_IDLE, "@1", 0).state;
    expect(peekHide(pending, 10).closedAt).toBeNull();
  });
  test("re-entering the shown tab changes nothing", () => {
    const shown = peekFire(peekEnter(PEEK_IDLE, "@1", 0).state, "@1");
    expect(peekEnter(shown, "@1", 5).state).toBe(shown);
  });
});

test("the hide events are the five that mean 'I am doing something else'", () => {
  expect([...PEEK_HIDE_EVENTS]).toEqual(["click", "contextmenu", "dragstart", "wheel", "keydown"]);
});

describe("the sentence", () => {
  const cases: [string | null, string, string][] = [
    ["waiting", "needs you", "Needs you: it is waiting for an answer."],
    ["error", "failed", "It hit an error."],
    [null, "exited (1)", "The process exited (1)."],
    [null, "was running Claude Code", "Restored; was running Claude Code, nothing is running yet."],
    ["working", "working", "Working."],
    ["done", "", "Finished its turn; you have not looked yet."],
    ["idle", "", "Idle; nothing to do."],
    [null, "", "A shell."],
  ];
  for (const [s, t, out] of cases) test(`${s ?? "none"} / ${t || "no mark"}`, () => expect(peekSentence(s, t)).toBe(out));
});

describe("the pull request text", () => {
  test("open, draft and landed", () => {
    expect(prText({ number: 318, state: "OPEN" })).toBe("#318 open");
    expect(prText({ number: 318, state: "OPEN", isDraft: true })).toBe("#318 draft");
    expect(prText({ number: 318, state: "MERGED", isDraft: true })).toBe("#318 merged");
  });
});
