// The handful of skills the chat puts one click away.
//
// Two things are being balanced: what you asked for by name, and what you
// actually run. Getting the precedence wrong either buries a pin or fills the
// strip with skills nobody has ever used.
import { test, expect, beforeAll, beforeEach } from "bun:test";

const cell = new Map<string, string>();
let m: typeof import("../src/lib/quickSkills.ts");

beforeAll(async () => {
  // Assigned rather than `??=`: other files install a no-op localStorage and
  // `bun test` shares one process, so the first loader would otherwise decide
  // whether anything written here is readable.
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  m = await import("../src/lib/quickSkills.ts");
});

beforeEach(() => cell.clear());

const s = (name: string, calls: number, last_used: number | null = null) => ({ name, calls, last_used });

test("what you use most, and only what you have used", () => {
  const out = m.quickSkills([s("a", 1), s("b", 9), s("c", 4), s("never", 0)], []);
  expect(out.map((x) => x.name)).toEqual(["b", "c", "a"]);
  // Ranking on calls alone would put every never-used skill in an arbitrary
  // order and call the first five "most used" — a claim the data cannot back.
  expect(out.map((x) => x.name)).not.toContain("never");
});

test("pins come first, in the order they were pinned", () => {
  // A pin is a statement about where you want something. Re-sorting pins by
  // usage would defeat the point of having pinned them.
  const out = m.quickSkills([s("a", 1), s("b", 99), s("c", 50)], ["c", "a"]);
  expect(out.slice(0, 2).map((x) => x.name)).toEqual(["c", "a"]);
  expect(out[2].name).toBe("b");
});

test("a pinned skill is never listed twice", () => {
  const out = m.quickSkills([s("a", 99)], ["a"]);
  expect(out.map((x) => x.name)).toEqual(["a"]);
});

test("more pins than the limit are all kept", () => {
  // Silently dropping the sixth thing you pinned is worse than a slightly
  // longer strip — you asked for those by name.
  const all = ["p1", "p2", "p3", "p4", "p5", "p6"].map((n) => s(n, 0));
  const out = m.quickSkills([...all, s("used", 10)], ["p1", "p2", "p3", "p4", "p5", "p6"], 5);
  expect(out.map((x) => x.name)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
});

test("a pin for a skill that no longer exists is dropped", () => {
  // Otherwise it renders as a chip that inserts a command nothing will answer.
  const out = m.quickSkills([s("still-here", 3)], ["gone", "still-here"]);
  expect(out.map((x) => x.name)).toEqual(["still-here"]);
});

test("ties break on recency then name, so the strip does not reshuffle", () => {
  const out = m.quickSkills([s("b", 5, 100), s("a", 5, 100), s("c", 5, 999)], []);
  expect(out.map((x) => x.name)).toEqual(["c", "a", "b"]);
});

test("pinning toggles and persists", () => {
  expect(m.pinnedSkills()).toEqual([]);
  expect(m.togglePinnedSkill("review")).toEqual(["review"]);
  expect(m.pinnedSkills()).toEqual(["review"]);
  expect(m.togglePinnedSkill("review")).toEqual([]);
});

test("a corrupt or foreign stored value reads as no pins", () => {
  // localStorage is shared with anything else on the origin and survives
  // versions of this app that stored something else under the same key.
  cell.set("agentglass.chat.pinnedSkills", '{"not":"an array"}');
  expect(m.pinnedSkills()).toEqual([]);
  cell.set("agentglass.chat.pinnedSkills", "not json at all");
  expect(m.pinnedSkills()).toEqual([]);
  cell.set("agentglass.chat.pinnedSkills", '["ok", 5, null]');
  expect(m.pinnedSkills()).toEqual(["ok"]);
});
