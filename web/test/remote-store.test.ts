/*
 * remoteStore: one keyed, shared cache for every remote read the side pane
 * makes. Exercised here at the pure-function level (`load`/`peek`/
 * `writePush`/`markStale`/`share`), the same style as the rest of this
 * test suite — no React render harness exists in this repo to drive
 * `useRemote` itself, so that hook is exercised indirectly through these.
 */
import { describe, expect, it } from "bun:test";
import { load, loadCancellable, peek, writePush, markStale, invalidate, share, ageLabel, cardChanged, jiraDetailKey, resetRemoteStore, pin, unpin } from "../src/lib/remoteStore.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("remoteStore.load", () => {
  it("a fresh hit asks nothing", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; return { n: 1 }; };
    await load("k1", loader, 60_000);
    await load("k1", loader, 60_000);
    await load("k1", loader, 60_000);
    expect(runs).toBe(1);
  });

  it("an expired entry asks once", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; return { n: runs }; };
    await load("k2", loader, 5);
    await tick(20);
    await load("k2", loader, 5);
    expect(runs).toBe(2);
  });

  it("2 concurrent callers share one load", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; await tick(10); return { n: runs }; };
    const [a, b] = await Promise.all([load("k3", loader, 60_000), load("k3", loader, 60_000)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
  });

  it("a failed load is not remembered: the next call retries", async () => {
    resetRemoteStore();
    await expect(load("k4", async () => { throw new Error("down"); }, 60_000)).rejects.toThrow("down");
    expect(await load("k4", async () => "up", 60_000)).toBe("up");
  });

  it("ttl 0 always forces a load (Refresh)", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; return runs; };
    await load("k5", loader, 60_000);
    await load("k5", loader, 0);
    expect(runs).toBe(2);
  });

  it("separate keys never share an answer", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; return runs; };
    await load("a", loader, 60_000);
    await load("b", loader, 60_000);
    expect(runs).toBe(2);
  });
});

describe("remoteStore push", () => {
  it("writePush merges fields into the held value without a request", () => {
    resetRemoteStore();
    writePush<{ a: number; b: number }>("pr:x#1", { a: 1, b: 1 });
    writePush<{ a: number; b: number }>("pr:x#1", { b: 2 });
    expect(peek<{ a: number; b: number }>("pr:x#1").value).toEqual({ a: 1, b: 2 });
  });

  it("markStale makes the entry due without touching its value", async () => {
    resetRemoteStore();
    let runs = 0;
    await load("s1", async () => { runs++; return { n: runs }; }, 60_000);
    markStale("s1");
    expect(peek("s1").value).toEqual({ n: 1 }); // still painted
    await load("s1", async () => { runs++; return { n: runs }; }, 60_000); // forced because `at` was zeroed
    expect(runs).toBe(2);
  });

  it("markStale on an unpinned key only zeros `at`; nothing re-reads until asked", async () => {
    resetRemoteStore();
    let runs = 0;
    const loader = async () => { runs++; return { n: runs }; };
    await load("s2", loader, 60_000);
    markStale("s2");
    await tick(5);
    expect(runs).toBe(1); // `pin` happens only through useRemote, in a mounted component
  });

  it("invalidate is markStale, used for a local write rather than a push", async () => {
    resetRemoteStore();
    let runs = 0;
    await load("git:repos", async () => { runs++; return { repos: [] }; }, 60_000);
    invalidate("git:repos");
    await load("git:repos", async () => { runs++; return { repos: [] }; }, 60_000);
    expect(runs).toBe(2);
  });
});

describe("remoteStore.share", () => {
  it("keeps the old reference for a sub-object that is still deep-equal", () => {
    const old = { a: { x: 1 }, b: { y: 2 } };
    const next = { a: { x: 1 }, b: { y: 3 } };
    const merged = share(old, next);
    expect(merged.a).toBe(old.a); // unchanged branch, same reference
    expect(merged.b).not.toBe(old.b); // changed branch, new reference
    expect(merged.b).toEqual({ y: 3 });
  });

  it("returns the OLD object whole when nothing in it changed", () => {
    const old = { a: 1, b: [1, 2, 3] };
    const next = { a: 1, b: [1, 2, 3] };
    expect(share(old, next)).toBe(old);
  });

  it("merges arrays element by element", () => {
    const old = [{ id: 1, v: 1 }, { id: 2, v: 1 }];
    const next = [{ id: 1, v: 1 }, { id: 2, v: 2 }];
    const merged = share(old, next);
    expect(merged[0]).toBe(old[0]);
    expect(merged[1]).not.toBe(old[1]);
  });

  it("a value that was never held is handed back as-is", () => {
    const next = { a: 1 };
    expect(share(undefined, next)).toBe(next);
  });
});

describe("remoteStore LRU", () => {
  it("evicts the oldest unpinned key past 100 entries", async () => {
    resetRemoteStore();
    for (let i = 0; i < 101; i++) await load(`lru-${i}`, async () => i, 60_000);
    expect(peek("lru-0").value).toBeUndefined(); // evicted
    expect(peek("lru-100").value).toBe(100); // kept
  });

  it("writePush counts as an access too: 101 push-only keys still leave 100", () => {
    resetRemoteStore();
    for (let i = 0; i < 101; i++) writePush(`push-${i}`, { n: i });
    const held = Array.from({ length: 101 }, (_, i) => peek(`push-${i}`).value).filter((v) => v !== undefined);
    expect(held.length).toBe(100); // not 101 — a push-only key must enter the LRU's recency order
    expect(peek("push-0").value).toBeUndefined(); // the oldest push, evicted
    expect(peek("push-100").value).toEqual({ n: 100 }); // the newest, kept
  });

  it("a pinned key survives past 100 more loads of other keys", async () => {
    resetRemoteStore();
    await load("pinned", async () => "held", 60_000);
    pin("pinned");
    for (let i = 0; i < 150; i++) await load(`other-${i}`, async () => i, 60_000);
    expect(peek("pinned").value).toBe("held"); // never evicted while pinned
    unpin("pinned");
  });
});

describe("ageLabel", () => {
  it("is empty for an entry that never loaded", () => {
    expect(ageLabel(0, 1_000_000)).toBe("");
  });
  it("is 'just now' under a minute", () => {
    expect(ageLabel(1_000_000, 1_030_000)).toBe("just now");
  });
  it("counts whole minutes otherwise", () => {
    expect(ageLabel(1_000_000, 1_000_000 + 3 * 60_000 + 10_000)).toBe("Updated 3 min ago");
  });
});

describe("jiraDetailKey", () => {
  it("is the key the card pane caches under", () => {
    expect(jiraDetailKey("ORBIT-1042")).toBe("jira:ORBIT-1042");
  });
});

describe("remoteStore.loadCancellable", () => {
  const slow = (signal: AbortSignal) => new Promise<string>((res, rej) => {
    const t = setTimeout(() => res("answer"), 30);
    signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); });
  });
  it("two waiters: one cancels, the other still gets the answer", async () => {
    resetRemoteStore();
    const a = loadCancellable("card:1", slow, 0);
    const b = loadCancellable("card:1", slow, 0);
    a.cancel();
    expect(await b.promise).toBe("answer");
  });
  it("the last waiter to cancel aborts the shared request", async () => {
    resetRemoteStore();
    const a = loadCancellable("card:2", slow, 0);
    const b = loadCancellable("card:2", slow, 0);
    a.cancel(); b.cancel();
    await expect(a.promise).rejects.toThrow("aborted");
  });
  it("a plain load() on the same key counts as a waiter", async () => {
    resetRemoteStore();
    const a = loadCancellable("card:3", slow, 0);
    const other = load("card:3", slow, 0);
    a.cancel();
    expect(await other).toBe("answer");
  });
});

describe("remoteStore.cardChanged", () => {
  it("a card frame makes the held Jira detail and card find due, and asks nothing for an unheld card", async () => {
    resetRemoteStore();
    let n = 0;
    await load("jira:ORBIT-1042", async () => (++n, "d"), 60000);
    await load("card-find:clickup:abc1", async () => (++n, "f"), 60000);
    cardChanged("jira", "ORBIT-1042", "ORBIT-1042");
    cardChanged(undefined, "abc1", "ORBIT-9");
    cardChanged("jira", "ORBIT-7", "ORBIT-7");
    expect(peek("jira:ORBIT-1042").at).toBe(0);
    expect(peek("card-find:clickup:abc1").at).toBe(0);
    expect(n).toBe(2);
    await load("jira:ORBIT-1042", async () => (++n, "d2"), 60000);
    expect(n).toBe(3);
  });
});
