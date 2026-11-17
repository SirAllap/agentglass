import { describe, expect, test } from "bun:test";
import { leakedEntries } from "./tmpguardDiff.ts";

describe("leakedEntries", () => {
  test("names only new house-prefixed entries, sorted", () => {
    expect(leakedEntries(["agx-old"], ["agx-old", "agx-b", "agentglass-a", "other-x", "systemd-1"])).toEqual(["agentglass-a", "agx-b"]);
  });
  test("nothing new is no leak", () => {
    expect(leakedEntries(["agx-a", "x"], ["x", "agx-a"])).toEqual([]);
  });
  test("an entry gone by the end is not a leak", () => {
    expect(leakedEntries(["agx-a"], [])).toEqual([]);
  });
  test("a prefix must start the name", () => {
    expect(leakedEntries([], ["my-agx-a", "agxfoo", "agx-ok"])).toEqual(["agx-ok"]);
  });
  describe("scoped to this run", () => {
    const born: Record<string, number> = { "agx-mine": 2000, "agx-old": 500, "agx-other-777": 2500, "agx-tmux-4242": 2100 };
    const scope = { startedAt: 1000, pid: 4242, bornAt: (n: string) => born[n] ?? null };
    test("an entry born before the run began is a parallel run's, not a leak", () => {
      expect(leakedEntries([], ["agx-mine", "agx-old"], undefined, scope)).toEqual(["agx-mine"]);
    });
    test("a name carrying another pid is left to its owner; our own pid is blamed", () => {
      expect(leakedEntries([], ["agx-other-777", "agx-tmux-4242"], undefined, scope)).toEqual(["agx-tmux-4242"]);
    });
    test("an entry whose age cannot be read still counts", () => {
      expect(leakedEntries([], ["agx-unknown"], undefined, scope)).toEqual(["agx-unknown"]);
    });
  });
});
