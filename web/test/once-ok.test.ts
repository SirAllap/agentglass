/*
 * "Cache the answer, never the failure."
 *
 * Written against a reported fault: code blocks in comments losing their colour
 * and staying grey until the app was restarted. The highlighter's chunks are
 * fetched from the local server the first time a block needs one, and the handle
 * was `p ??= import(...)` — so a single failed fetch (a server restarting under a
 * window that is still open, which is exactly what installing a build does) was
 * remembered for the life of the page. Nothing else in the app ever asked again.
 */
import { describe, expect, it } from "bun:test";
import { onceOk } from "../src/lib/onceOk.ts";

describe("onceOk", () => {
  it("makes the thing once and shares it", async () => {
    let made = 0;
    const get = onceOk(async () => { made++; return { n: made }; });
    const [a, b] = await Promise.all([get(), get()]);
    expect(made).toBe(1);
    expect(a).toBe(b);
  });

  // The fault itself: a rejection must not be what everybody gets from then on.
  it("does not remember a failure", async () => {
    let calls = 0;
    const get = onceOk(async () => {
      calls++;
      if (calls === 1) throw new Error("chunk fetch failed");
      return "coloured";
    });
    await expect(get()).rejects.toThrow("chunk fetch failed");
    expect(await get()).toBe("coloured");
    expect(calls).toBe(2);
  });

  // The caller is still told. This changes what is remembered, not what is
  // reported — a block that cannot be coloured has to be able to fall back.
  it("passes the failure on every time it happens", async () => {
    const get = onceOk(async () => { throw new Error("no grammar"); });
    await expect(get()).rejects.toThrow("no grammar");
    await expect(get()).rejects.toThrow("no grammar");
  });

  // Cleared before the rejection travels, so a caller that retries inside its own
  // catch gets a new attempt rather than the one that just failed.
  it("is ready to try again by the time the caller hears about it", async () => {
    let calls = 0;
    const get = onceOk(async () => {
      calls++;
      if (calls < 3) throw new Error("still down");
      return "up";
    });
    let out = "";
    for (let i = 0; i < 3; i++) {
      try { out = await get(); break; } catch { /* the caller's own retry */ }
    }
    expect(out).toBe("up");
    expect(calls).toBe(3);
  });

  // Everybody waiting on the attempt that failed hears the same failure, and the
  // NEXT caller starts the new one — one retry, not one per waiter.
  it("does not multiply attempts among callers waiting on the same one", async () => {
    let calls = 0;
    const get = onceOk(async () => { calls++; throw new Error("down"); });
    const waiters = await Promise.allSettled([get(), get(), get()]);
    expect(waiters.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
  });
});
