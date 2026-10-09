/*
 * A card's GitHub and Activity tabs emptied and reloaded when the window came
 * back: the board re-read itself, its tasks were new objects, and the effects
 * keyed on those objects searched GitHub and read the thread again, clearing
 * the list first. Requests are counted here with a wrapped fetch, never against
 * ClickUp or GitHub.
 */
import { describe, expect, it } from "bun:test";
import { paintThenRevalidate, swr, PRS_TTL_MS, THREAD_TTL_MS } from "../src/lib/cardTabCache.ts";

type Prs = { prs: { number: number }[]; err: boolean };
const counted = (out: () => Prs = () => ({ prs: [{ number: 101 }, { number: 102 }], err: false })) => {
  const box = { n: 0, fetch: () => { box.n++; return Promise.resolve(out()); } };
  return box;
};
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };
const open = (cache: ReturnType<typeof swr<Prs>>, key: string, f: () => Promise<Prs>, seen: (Prs | "cached")[] = []) =>
  paintThenRevalidate(cache, key, f, (v, cached) => { seen.push(cached ? "cached" : v); });

describe("card tab cache", () => {
  it("leaving the window and coming back five times on an open card asks 0 more times", async () => {
    const c = clock(); const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err, c.now); const w = counted();
    await open(cache, "card-1", w.fetch);
    expect(w.n).toBe(1);
    for (let i = 0; i < 5; i++) { c.t += 40_000; await open(cache, "card-1", w.fetch); } // each return re-runs the effect
    expect(w.n).toBe(1); // the uncached effect made 1 + 5 = 6
  });
  it("closing a card and opening it again inside the TTL asks 0 more times, and paints at once", async () => {
    const c = clock(); const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err, c.now); const w = counted();
    await open(cache, "card-1", w.fetch);
    c.t += 60_000;
    const seen: (Prs | "cached")[] = [];
    await open(cache, "card-1", w.fetch, seen);
    expect(w.n).toBe(1);
    expect(seen).toEqual(["cached"]);
  });
  it("asks again once older than the TTL, painting the old answer meanwhile and never emptying it", async () => {
    const c = clock(); const cache = swr<Prs>(THREAD_TTL_MS, (v) => !v.err, c.now); const w = counted();
    await open(cache, "card-1", w.fetch);
    c.t += THREAD_TTL_MS + 1;
    const seen: (Prs | "cached")[] = [];
    await open(cache, "card-1", w.fetch, seen);
    expect(w.n).toBe(2);
    expect(seen[0]).toBe("cached");
    for (const v of seen) if (v !== "cached") expect(v.prs.length).toBeGreaterThan(0);
  });
  it("shares one request between identical calls in flight", async () => {
    const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err); const w = counted();
    await Promise.all([open(cache, "card-1", w.fetch), open(cache, "card-1", w.fetch), open(cache, "card-1", w.fetch)]);
    expect(w.n).toBe(1);
  });
  it("keeps separate cards apart", async () => {
    const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err); const w = counted();
    await open(cache, "card-1", w.fetch); await open(cache, "card-2", w.fetch);
    expect(w.n).toBe(2);
  });
  it("a failed revalidation leaves the answer on screen, and a failure is not remembered", async () => {
    const c = clock(); const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err, c.now);
    await open(cache, "card-1", counted().fetch);
    c.t += PRS_TTL_MS + 1;
    const seen: (Prs | "cached")[] = [];
    await open(cache, "card-1", counted(() => ({ prs: [], err: true })).fetch, seen);
    expect(seen).toEqual(["cached"]); // the error never replaced the list
    const cold = swr<Prs>(PRS_TTL_MS, (v) => !v.err, c.now);
    await open(cold, "card-9", counted(() => ({ prs: [], err: true })).fetch);
    expect(cold.peek("card-9")).toBeUndefined();
  });
  it("stale() after a local write keeps the old answer for painting and makes the next open ask", async () => {
    const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err); const w = counted();
    await open(cache, "card-1", w.fetch);
    cache.stale("card-1");
    expect(cache.peek("card-1")).toBeDefined();
    await open(cache, "card-1", w.fetch);
    expect(w.n).toBe(2);
  });
  it("force asks even when fresh (a manual Refresh)", async () => {
    const cache = swr<Prs>(PRS_TTL_MS, (v) => !v.err); const w = counted();
    await open(cache, "card-1", w.fetch);
    await paintThenRevalidate(cache, "card-1", w.fetch, () => {}, { force: true });
    expect(w.n).toBe(2);
  });
});

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const slice = (from: string, to: string) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  expect(a).toBeGreaterThan(-1); expect(b).toBeGreaterThan(a);
  return src.slice(a, b).split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
};

describe("CardDetail reads through the cache", () => {
  const prsEffect = slice("const hit = prsCache.peek(prKey);", "}, [prKey]);");
  it("keys the pull request effect on strings, not on the board's objects", () => {
    expect(src).toContain("}, [prKey]);");
    expect(src).toContain('const prKey = [t.id, t.customId || "", prField, prCwd].join("\\n");');
  });
  it("never empties the list to a new search, only to a card with nothing cached", () => {
    expect(prsEffect).not.toContain("setPrs([])");
    expect(prsEffect).toContain("hit?.prs ?? []");
  });
  it("says 'no pull request' only after a search has answered", () => {
    expect(src).toContain("!prs.length && !prsErr && prsLoaded && (");
    expect(src).toContain("!prs.length && !prsErr && !prsLoaded && <div");
  });
  it("reads the thread only through the cache", () => {
    const body = slice("function CardDetail(", "\nfunction ");
    const calls = body.split("api.clickupTask(").length - 1;
    const cached = body.split("api.clickupTask(t.id)").length - 1;
    expect(calls).toBe(cached);
    expect(body).toContain("paintThenRevalidate(threadCache, t.id");
    expect(body.split("threadCache.load(").length - 1).toBe(2); // reread and the card's own Refresh, both forced
    expect(body).toContain("{ force: true }");
  });
  it("makes the thread due after a comment or an edit made here", () => {
    expect(slice("const reread = useCallback(", "[t.id, layers]);")).toContain("threadCache.stale(t.id)");
    expect(src).toContain("threadCache.stale(picked.id); apply(picked, key, p)");
  });
});
