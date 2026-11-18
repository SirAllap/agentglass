import { describe, expect, test } from "bun:test";
import { groupReactions, reactionTip } from "../../shared/commentReactions.ts";

const raw = [
  { reaction: "👍", user: { id: 1, username: "Ada Orbit" } },
  { reaction: "🎉", user: { id: 2, username: "Bo Acme" } },
  { reaction: "👍", user: { id: 2, username: "Bo Acme" } },
  { reaction: "  ", user: { id: 3 } },
];

describe("groupReactions", () => {
  test("one chip per emoji, counted, in first-seen order", () => {
    expect(groupReactions(raw, "9").map((c) => [c.emoji, c.count])).toEqual([["👍", 2], ["🎉", 1]]);
  });
  test("mine is an id match, not a name match", () => {
    expect(groupReactions(raw, "1").map((c) => c.mine)).toEqual([true, false]);
    expect(groupReactions(raw, undefined).every((c) => !c.mine)).toBe(true);
  });
  test("junk in gives nothing out", () => {
    expect(groupReactions(undefined)).toEqual([]);
    expect(groupReactions("x")).toEqual([]);
  });
});

describe("tip", () => {
  test("tip names people, else counts", () => {
    expect(reactionTip({ emoji: "👍", count: 2, mine: false, who: ["Ada Orbit", "Bo Acme"] })).toBe("Ada Orbit, Bo Acme");
    expect(reactionTip({ emoji: "👍", count: 1, mine: false, who: [] })).toBe("1 reaction");
  });
});
