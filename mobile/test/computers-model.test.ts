/*
 * What the switcher, the Computers screen and the Add form say, decided
 * outside the screens (src/model/computers.ts) because the project has no
 * renderer and a sentence that is wrong on the phone is wrong at 2 a.m.
 */
import { describe, expect, test } from "bun:test";
import {
  capReached, displayName, forgetNote, needsAddress, statusOf, statusWord, switcherSub, waitingElsewhere,
} from "../src/model/computers.ts";
import type { HostEntry, HostList } from "../src/lib/hosts.ts";

const entry = (id: string, over: Partial<HostEntry> = {}): HostEntry => ({
  id,
  origin: `http://10.0.0.${id.charCodeAt(0) - 96}:4000`,
  token: `t-${id}`,
  label: "Pixel",
  scope: "answer",
  pairedAt: 1,
  lastUsed: 1,
  ...over,
});
const list = (ids: string[], active = ids[0]!): HostList => ({
  active,
  hosts: ids.map((id, i) => entry(id, { lastUsed: 100 - i })),
});

describe("what a computer is called", () => {
  test("the owner's alias wins over what the computer says", () => {
    expect(displayName(entry("a", { name: "Studio" }), "orbit-desktop")).toBe("Studio");
  });
  test("then what the computer says about itself, then its address", () => {
    expect(displayName(entry("a"), "orbit-desktop")).toBe("orbit-desktop");
    expect(displayName(entry("a"), undefined)).toBe("10.0.0.1");
  });
});

describe("whether it can be reached", () => {
  test("a removed computer is removed whatever the socket says", () => {
    expect(statusOf(entry("a", { revoked: 5 }), true, "open")).toBe("removed");
  });
  test("the one in use follows its socket", () => {
    expect(statusOf(entry("a"), true, "open")).toBe("online");
    expect(statusOf(entry("a"), true, "offline")).toBe("offline");
    expect(statusOf(entry("a"), true, "connecting")).toBe("checking");
  });
  test("one nobody is connected to is not claimed to be online", () => {
    // Broken on purpose: saying "online" for every computer in the list draws
    // a green dot the phone has no evidence for.
    expect(statusOf(entry("a"), false, "open")).toBe("checking");
  });
  test("a socket the caller passes for it decides", () => {
    expect(statusOf(entry("a"), false, "open", "offline")).toBe("offline");
    expect(statusOf(entry("a"), false, "offline", "open")).toBe("online");
  });
  test("the words", () => {
    expect(statusWord("online")).toBe("Online");
    expect(statusWord("offline")).toBe("Not answering");
    expect(statusWord("removed")).toBe("Removed at the computer");
    expect(statusWord("checking")).toBe("Checking");
  });
});

describe("the switcher's second line", () => {
  test("says what is wrong before anything else", () => {
    expect(switcherSub("offline", 2)).toBe("Not answering");
    expect(switcherSub("removed", 0)).toBe("Removed at the computer");
  });
  test("counts what waits, only when something does", () => {
    expect(switcherSub("online", 0)).toBe("Online");
    expect(switcherSub("online", 1)).toBe("1 waiting on you");
    expect(switcherSub("online", 3)).toBe("3 waiting on you");
  });
});

describe("what forgetting says will happen", () => {
  test("forgetting the one in use names who you land on, the next most recent", () => {
    const l = list(["a", "b", "c"], "a");
    expect(forgetNote(l, "a", (h) => `host ${h.id}`)).toBe("You will switch to host b.");
  });
  test("forgetting the last one says where you land", () => {
    expect(forgetNote(list(["a"]), "a", (h) => h.id))
      .toBe("That was the last one, so you land on Connect to your computer.");
  });
  test("forgetting another one changes nothing for you", () => {
    expect(forgetNote(list(["a", "b"], "a"), "b", (h) => h.id)).toBe("");
  });
});

describe("whether the Add form has to ask for an address", () => {
  test("a pasted link carries it, so it does not", () => {
    expect(needsAddress("http://192.168.1.20:4000/?pair=abc123def456")).toBe(false);
    expect(needsAddress("192.168.1.20:4000/?pair=abc123def456")).toBe(false);
  });
  test("a bare ticket has none, so it does", () => {
    // Broken on purpose: a ticket is 12 base64url characters with no address in
    // them, and asking for none sends the claim to whatever the last address was.
    expect(needsAddress("abc123def456")).toBe(true);
  });
  test("nothing yet, or something that is not a ticket, asks nothing", () => {
    expect(needsAddress("")).toBe(false);
    expect(needsAddress("  ")).toBe(false);
    expect(needsAddress("not a ticket!")).toBe(false);
  });
});

describe("the badge on the name", () => {
  const l = list(["a", "b", "c"], "a");
  test("sums what waits on the computers you are not in", () => {
    expect(waitingElsewhere(l, { a: 4, b: 2, c: 1 }, { b: "open", c: "open" })).toBe(3);
  });
  test("a computer that is not answering cannot be waiting on you", () => {
    // Broken on purpose: a stale count from a socket that dropped is a badge
    // for an alert that will never arrive.
    expect(waitingElsewhere(l, { b: 2, c: 1 }, { b: "offline", c: "open" })).toBe(1);
    expect(waitingElsewhere(l, { b: 2 }, {})).toBe(0);
  });
  test("a removed computer is not counted", () => {
    const removed: HostList = { active: "a", hosts: l.hosts.map((h) => (h.id === "b" ? { ...h, revoked: 9 } : h)) };
    expect(waitingElsewhere(removed, { b: 5 }, { b: "open" })).toBe(0);
  });
  test("the computer in use is never counted, whatever its own count says", () => {
    expect(waitingElsewhere(l, { a: 9 }, { a: "open" })).toBe(0);
  });
});

describe("the cap", () => {
  test("is reached at five, not before", () => {
    expect(capReached(list(["a", "b", "c", "d"]))).toBe(false);
    expect(capReached(list(["a", "b", "c", "d", "e"]))).toBe(true);
  });
});
