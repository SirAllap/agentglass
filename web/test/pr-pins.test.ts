/*
 * The pull requests you keep coming back to.
 *
 * Asked for as "a watch or pin button, so we have quick access instead of going
 * back and forth all the time". The panel shows one at a time, and the list
 * reorders itself by activity — so moving between two of them means finding a
 * row that has usually moved since you last looked.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

const load = async () =>
  (await import(`../src/lib/prPins.ts?t=${Math.random()}`)) as typeof import("../src/lib/prPins.ts");

const R = "orbit/web";
beforeEach(() => store.clear());

describe("pinning", () => {
  it("starts empty", async () => {
    expect((await load()).pins()).toEqual([]);
  });

  it("adds one and knows it is there", async () => {
    const m = await load();
    expect(m.togglePin(R, 12, "Fix the thing")).toBe(true);
    expect(m.isPinned(R, 12)).toBe(true);
    expect(m.pins()[0]).toMatchObject({ repo: R, number: 12, title: "Fix the thing" });
  });

  it("takes it off again", async () => {
    const m = await load();
    m.togglePin(R, 12, "x");
    expect(m.togglePin(R, 12, "x")).toBe(false);
    expect(m.isPinned(R, 12)).toBe(false);
  });

  it("keeps the order you built, not the order things happen", async () => {
    // A new pin jumping to the front would move every chip you had already
    // learned the position of.
    const m = await load();
    m.togglePin(R, 1, "a", 100);
    m.togglePin(R, 2, "b", 200);
    m.togglePin(R, 3, "c", 300);
    expect(m.pins().map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("does not confuse the same number in two repositories", async () => {
    const m = await load();
    m.togglePin(R, 12, "ours");
    expect(m.isPinned("orbit/api", 12)).toBe(false);
    m.togglePin("orbit/api", 12, "theirs");
    expect(m.pinsFor(R).map((p) => p.number)).toEqual([12]);
    expect(m.pinsFor("orbit/api").map((p) => p.title)).toEqual(["theirs"]);
  });

  it("drops the oldest when it is full, so a seventh press does something", async () => {
    const m = await load();
    for (let n = 1; n <= m.PIN_MAX; n++) m.togglePin(R, n, `p${n}`, n);
    m.togglePin(R, 99, "new", 99);
    const nums = m.pins().map((p) => p.number);
    expect(nums).toHaveLength(m.PIN_MAX);
    expect(nums).toContain(99);
    expect(nums).not.toContain(1);
  });

  it("survives a reload, which is the whole point of writing it down", async () => {
    (await load()).togglePin(R, 12, "Fix the thing");
    const b = await load();
    expect(b.isPinned(R, 12)).toBe(true);
    expect(b.pins()[0]!.title).toBe("Fix the thing");
  });

  it("survives junk in storage rather than losing the bar", async () => {
    store.set("agentglass.pr.pins", JSON.stringify([
      { repo: R, number: 1, title: "good", at: 1 },
      { number: 2, title: "no repo", at: 2 },
      "nonsense",
      { repo: R, number: "three", title: "bad number", at: 3 },
    ]));
    expect((await load()).pins().map((p) => p.number)).toEqual([1]);
  });

  it("tells whoever is drawing the bar", async () => {
    const m = await load();
    let n = 0;
    const off = m.subscribePins(() => n++);
    m.togglePin(R, 1, "a");
    expect(n).toBe(1);
    off();
    m.togglePin(R, 2, "b");
    expect(n).toBe(1);
  });
});
