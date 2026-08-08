/*
 * The third question the palette answers.
 *
 * "Where is the file called X" and "where does the code say X" can both be
 * asked of the disk. "The thing I was reading twenty minutes ago" cannot — you
 * do not remember its name and it does not contain a string you could search
 * for. It is a fact about this window and nowhere else.
 *
 * The two rules worth pinning down are the ones that decide whether the list is
 * usable at all: re-opening moves rather than appends, and a path is only a
 * path within one checkout.
 */
import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

const load = async () => {
  // Fresh module per test: it caches, which is the point of it.
  const mod = await import(`../src/lib/fileRecents.ts?t=${Math.random()}`);
  return mod as typeof import("../src/lib/fileRecents.ts");
};

const WT = "/home/x/code/app";
const OTHER = "/home/x/code/app-wt";

beforeEach(() => store.clear());

describe("what the list remembers", () => {
  it("starts empty rather than guessing", async () => {
    const r = await load();
    expect(r.recents()).toEqual([]);
  });

  it("puts the newest first", async () => {
    const r = await load();
    r.remember(WT, "a.md", 1000);
    r.remember(WT, "b.md", 2000);
    expect(r.recents().map((x) => x.rel)).toEqual(["b.md", "a.md"]);
  });

  it("MOVES a file you come back to instead of listing it twice", async () => {
    /*
     * The rule that decides whether this tab is worth having. A document you
     * keep returning to filling the first five rows with itself is the one
     * shape that makes a recents list useless.
     */
    const r = await load();
    r.remember(WT, "a.md", 1000);
    r.remember(WT, "b.md", 2000);
    r.remember(WT, "a.md", 3000);
    expect(r.recents().map((x) => x.rel)).toEqual(["a.md", "b.md"]);
    expect(r.recents().filter((x) => x.rel === "a.md")).toHaveLength(1);
    expect(r.recents()[0]!.at).toBe(3000);
  });

  it("keeps two checkouts apart, because they are two different files", async () => {
    /*
     * With ten worktrees of one repository open, `docs/plan.md` names ten
     * files. Collapsing them would reopen the wrong branch's copy — silently,
     * since the text usually looks nearly the same.
     */
    const r = await load();
    r.remember(WT, "docs/plan.md", 1000);
    r.remember(OTHER, "docs/plan.md", 2000);
    expect(r.recents()).toHaveLength(2);
    expect(r.recents().map((x) => x.root)).toEqual([OTHER, WT]);
  });

  it("stops growing", async () => {
    const r = await load();
    for (let i = 0; i < 60; i++) r.remember(WT, `f${i}.md`, i);
    expect(r.recents()).toHaveLength(40);
    // And it is the OLD ones that fall off.
    expect(r.recents()[0]!.rel).toBe("f59.md");
  });

  it("drops one that is no longer there", async () => {
    const r = await load();
    r.remember(WT, "a.md", 1000);
    r.remember(WT, "b.md", 2000);
    r.forget(WT, "b.md");
    expect(r.recents().map((x) => x.rel)).toEqual(["a.md"]);
  });

  it("refuses an entry it could not open again", async () => {
    const r = await load();
    r.remember("", "a.md");
    r.remember(WT, "");
    expect(r.recents()).toEqual([]);
  });
});

describe("surviving storage", () => {
  it("comes back after a reload", async () => {
    const a = await load();
    a.remember(WT, "docs/plan.md", 5000);
    const b = await load();
    expect(b.recents()).toEqual([{ root: WT, rel: "docs/plan.md", at: 5000 }]);
  });

  it("throws away junk instead of the whole list", async () => {
    // Written by a previous version, or half-written. One bad row must not take
    // the good ones with it.
    store.set("agentglass.files.recent", JSON.stringify([
      { root: WT, rel: "good.md", at: 3 },
      { rel: "no-root.md", at: 2 },
      "nonsense",
      null,
      { root: WT, rel: "also-good.md", at: 1 },
    ]));
    const r = await load();
    expect(r.recents().map((x) => x.rel)).toEqual(["good.md", "also-good.md"]);
  });

  it("survives storage that is not JSON at all", async () => {
    store.set("agentglass.files.recent", "{{{");
    const r = await load();
    expect(r.recents()).toEqual([]);
  });
});

describe("how it reads the clock", () => {
  it("says something a person would say", async () => {
    const r = await load();
    const now = 1_000_000_000;
    expect(r.ago(now - 5_000, now)).toBe("just now");
    expect(r.ago(now - 5 * 60_000, now)).toBe("5m ago");
    expect(r.ago(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(r.ago(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("never reads as the future when the clock moves", async () => {
    const r = await load();
    expect(r.ago(2000, 1000)).toBe("just now");
  });
});
