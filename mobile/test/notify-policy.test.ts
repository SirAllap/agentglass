/*
 * Whether an alert is worth a buzz.
 *
 * This is the whole feature, and getting it wrong is not a cosmetic bug: a
 * companion that notifies too much is one people silence in the system
 * settings, where the app cannot see it and cannot ask again — leaving
 * something you believe is watching for you while it is not.
 *
 * So each "no" is its own case, because they are different kinds of no and a
 * single boolean would hide which one fired.
 */
import { describe, expect, test } from "bun:test";
import type { AlertNote } from "../../shared/types.ts";
import { alertKey, importanceOf, remember, SAME_ALERT_MS, shouldNotify } from "../src/notifications/policy.ts";

const gate = (over: Partial<AlertNote> = {}): AlertNote => ({
  title: "Waiting on you",
  body: "Bash · rm -rf build",
  urgency: 2,
  ...over,
});

const ctx = (over: Partial<{ foreground: boolean; lastSeen: Map<string, number>; now: number }> = {}) => ({
  foreground: false,
  lastSeen: new Map<string, number>(),
  now: 1_000_000,
  ...over,
});

describe("when to buzz", () => {
  test("a held gate, with the phone in a pocket", () => {
    expect(shouldNotify(gate(), ctx())).toEqual({ notify: true });
  });

  test("not while you are looking at the app", () => {
    // The queue is on screen and updating. A notification over the top of it
    // is the app telling you what you can already see.
    expect(shouldNotify(gate(), ctx({ foreground: true })))
      .toEqual({ notify: false, because: "foreground" });
  });

  test("not the same alert twice inside the window", () => {
    /*
     * The one that would have made this unusable — though not for the reason
     * this comment used to give. It said the server re-broadcasts when a client
     * attaches, so a phone coming out of a pocket buzzed once per lift door.
     * Grepped: `{type:"alert"}` has exactly one producer, `index.ts:502`,
     * reached only when an alert happens; a socket that attaches is sent
     * `{type:"initial"}`, which is events. A reconnect replays nothing.
     *
     * What it really guards is that the server dedupes nothing of its own:
     * `deliver()` broadcasts per qualifying event, so an agent that stops for
     * approval twice on one session sends the same title and body twice.
     */
    const seen = ctx();
    remember(gate(), seen);
    expect(shouldNotify(gate(), seen)).toEqual({ notify: false, because: "repeat" });

    // And past the window it is news again: the same gate still holding after
    // a minute and a half is worth saying twice.
    const later = ctx({ lastSeen: seen.lastSeen, now: seen.now + SAME_ALERT_MS + 1 });
    expect(shouldNotify(gate(), later)).toEqual({ notify: true });
  });

  test("a different alert is a different alert", () => {
    const seen = ctx();
    remember(gate(), seen);
    expect(shouldNotify(gate({ body: "Bash · git push --force" }), seen)).toEqual({ notify: true });
  });

  test("not for the server's own 'worth knowing'", () => {
    // Urgency 0 is the level the server uses for things it would mention and
    // not stop you for. A phone is the one screen where every interruption
    // costs attention somewhere else.
    expect(shouldNotify(gate({ urgency: 0 }), ctx())).toEqual({ notify: false, because: "low" });
  });

  test("never a buzz with nothing in it", () => {
    // A notification with no title is an interruption with no explanation,
    // which teaches people to ignore the next one.
    for (const bad of [{ title: "" }, { title: "   " }]) {
      expect(shouldNotify(gate(bad), ctx()).notify, JSON.stringify(bad)).toBe(false);
    }
    expect(shouldNotify(undefined as unknown as AlertNote, ctx()))
      .toEqual({ notify: false, because: "empty" });
  });
});

describe("how loudly", () => {
  test("only what is stopped gets the level that covers your screen", () => {
    // Making everything urgent is how a channel gets switched off in the
    // system settings.
    expect(importanceOf(2)).toBe("max");
    expect(importanceOf(1)).toBe("high");
    expect(importanceOf(0)).toBe("default");
    expect(importanceOf(undefined)).toBe("default");
  });
});

describe("what makes two alerts the same one", () => {
  test("its words, not its urgency", () => {
    // The server can re-evaluate urgency between broadcasts of one event.
    expect(alertKey(gate({ urgency: 1 }))).toBe(alertKey(gate({ urgency: 2 })));
    expect(alertKey(gate())).not.toBe(alertKey(gate({ title: "Something else" })));
  });

  test("and the memory does not grow for ever", () => {
    // One entry per distinct alert, pruned well past the window. A map that
    // only ever grows is a leak in a process that runs for days.
    const seen = ctx();
    for (let i = 0; i < 500; i++) {
      remember(gate({ body: `command ${i}` }), { lastSeen: seen.lastSeen, now: seen.now + i });
    }
    remember(gate({ body: "last" }), { lastSeen: seen.lastSeen, now: seen.now + SAME_ALERT_MS * 10 });
    expect(seen.lastSeen.size).toBe(1);
  });
});
