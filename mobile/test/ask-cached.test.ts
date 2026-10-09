/*
 * A read two screens make is made once for a while.
 *
 * The queue's slow pass and the Pull requests tab both asked `/git/repos` and
 * every `/prs/list` for the same repositories, and the tab asked again each time
 * it opened: 6 to 13 identical requests per open at three to six repositories,
 * byte-identical bodies (measured). `askCached` is the seam both go through.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { askCached, forgetCachedAsks } from "../src/lib/api.ts";

const providerSrc = await Bun.file(new URL("../src/state/host-context.tsx", import.meta.url)).text();
const host = { origin: "http://desk.local:4000", token: "t" } as never;
const realFetch = globalThis.fetch;
let calls: string[] = [];
let failNext = false;

beforeEach(() => {
  calls = [];
  failNext = false;
  forgetCachedAsks();
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    await Bun.sleep(5);
    if (failNext) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ ok: true, n: calls.length }), { status: 200 });
  }) as never;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe("askCached", () => {
  test("the second read inside the window costs no request", async () => {
    const a = await askCached(host, "/git/repos", 1000);
    const b = await askCached(host, "/git/repos", 1000);
    expect(calls.length).toBe(1);
    expect(b).toEqual(a);
  });

  test("two reads at the same moment share one request", async () => {
    await Promise.all([askCached(host, "/prs/list?a=1", 1000), askCached(host, "/prs/list?a=1", 1000)]);
    expect(calls.length).toBe(1);
  });

  test("force always asks, and what it read is what the next plain read gets", async () => {
    await askCached(host, "/git/repos", 1000);
    const fresh = await askCached<{ n: number }>(host, "/git/repos", 1000, true);
    expect(calls.length).toBe(2);
    const later = await askCached<{ n: number }>(host, "/git/repos", 1000);
    expect(calls.length).toBe(2);
    expect(later).toEqual(fresh);
  });

  test("an answer older than the window is asked again", async () => {
    await askCached(host, "/git/repos", 1);
    await Bun.sleep(20);
    await askCached(host, "/git/repos", 1);
    expect(calls.length).toBe(2);
  });

  test("a failure is never served twice", async () => {
    failNext = true;
    const bad = await askCached(host, "/git/repos", 1000);
    expect(bad.ok).toBe(false);
    await Bun.sleep(5);
    failNext = false;
    const good = await askCached(host, "/git/repos", 1000);
    expect(good.ok).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("another computer's answers are not this one's", async () => {
    await askCached(host, "/git/repos", 1000);
    await askCached({ origin: "http://other.local:4000", token: "t" } as never, "/git/repos", 1000);
    expect(calls.length).toBe(2);
  });
});

describe("the provider forgets what it cached when the computer changes", () => {
  // Same origin, other computer (an address a router handed out again): a 120 s
  // answer from the first would show under the second one's token.
  const body = (from: string, to: string) => {
    const a = providerSrc.indexOf(from);
    const b = providerSrc.indexOf(to, a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return providerSrc.slice(a, b);
  };
  test("pairing a computer clears the cache after saving it", () => {
    const pair = body("pair: async (next: Host)", "forget: async");
    expect(pair).toContain("forgetCachedAsks();");
    expect(pair.indexOf("saveHost(next)")).toBeLessThan(pair.indexOf("forgetCachedAsks();"));
  });
  test("forgetting the computer clears it too", () => {
    expect(body("forget: async (): Promise<void>", "}), [host, ready")).toContain("forgetCachedAsks();");
  });
});
