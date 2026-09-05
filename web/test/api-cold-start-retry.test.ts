/*
 * Every GET the app fires in its first second, against a server that is not up yet.
 *
 * The window does not wait for the sidecar, and that is deliberate: `await
 * ensureServer()` used to sit between ready and createWindow, measured at 376ms
 * of a 588ms startup on a warm cache and unbounded when the 103MB binary comes
 * off disk cold — up to twelve seconds of no window at all, which reads as an
 * app that failed to start. The comment that justifies it (electron/main.js,
 * "The window does not wait for the server") rests on one claim:
 *
 *     "the live socket reconnects with backoff and every panel's fetch has a
 *      retry or an honest loading state"
 *
 * The socket half is true. The fetch half was not, and this file is the claim
 * turned into a test. `get()` was a bare `fetch` that throws on a refused
 * connection, so whether a panel recovered depended on what its own `.catch`
 * decided to do — and a count of the call sites found 16 that turn "I could not
 * ask" into "the answer is nothing" (`setRepos([])`, `setAgents([])`,
 * `setEditor({ hasNvim: false })`), which is indistinguishable from a real empty
 * answer and never re-runs.
 *
 * Measured on this machine from source, 2026-08-26: the sidecar listens 559ms
 * after spawn and answers /health at 635ms. So every one of those failures was
 * transient by hundreds of milliseconds — the answer was there, nobody asked
 * twice. Reported as "the browser often does not start"; one launch's console
 * carried 20 of them.
 *
 * The rule the retry has to respect: a REFUSED CONNECTION is worth asking
 * again, AN ANSWER IS NOT. A 500 is the server saying no, and asking a
 * struggling server twice is how a bad minute becomes a bad ten.
 */
import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;

/*
 * WHY THIS FILE IS FUSSY ABOUT ISOLATION.
 *
 * `bun test` shares one process across all 303 files, so `globalThis.fetch` and
 * the live `SERVER` binding are everybody's. The first version of this replaced
 * fetch outright and counted every call: it read 9 where the retry can make at
 * most 5, because another file's test ran during one of the awaits below and
 * went through the stub. That is the harmless half — the other half is that
 * every request those files made was thrown by a stub written for this one. A
 * test that breaks its neighbours is worse than the bug it was guarding.
 *
 * Two defences, because either alone leaks:
 *   - the stub DELEGATES every path but the one this file exercises, so a
 *     neighbour's fetch behaves exactly as it would have. That matters more
 *     than it sounds: `gateStore.ts` runs a poll on a timer that keeps beating
 *     for the whole suite, and an earlier draft of this file moved the shared
 *     `SERVER` binding, which pulled those beats into the stub too;
 *   - the assertions that could still be reached by a neighbour's call are
 *     about ELAPSED TIME and "at least one retry", never an exact count.
 */
/** The one path this file drives. Everything else is somebody else's. */
const PROBE_PATH = "/projects";

/** What a refused connection actually throws, in a browser and in Bun. */
const refused = () => Object.assign(new TypeError("Failed to fetch"), { cause: { code: "ECONNREFUSED" } });

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Install a stub for this file's origin only. Returns the count of OUR calls. */
function stub(handler: (n: number) => Promise<Response>): () => number {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith(PROBE_PATH)) return realFetch(input as RequestInfo, init);
    calls++;
    return handler(calls);
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => { globalThis.fetch = realFetch; });

describe("a GET fired before the sidecar is listening", () => {
  test("survives a server that arrives a moment late", async () => {
    const { api } = await import("../src/lib/api.ts");
    const calls = stub(async (n) => {
      if (n <= 2) throw refused();
      return ok({ projects: [], scanning: false, workspace: null });
    });

    // ~600ms of refusals is what the sidecar's boot looks like from here. The
    // ask that lands is the one that gets the real answer.
    const r = await api.projects();
    expect(r).toBeTruthy();
    expect(calls()).toBeGreaterThan(1); // it asked again; that is the whole fix
  });

  test("gives up rather than hanging when the server never comes", async () => {
    const { api } = await import("../src/lib/api.ts");
    stub(async () => { throw refused(); });

    const t0 = Date.now();
    await expect(api.projects()).rejects.toThrow();
    // Bounded on purpose: a sidecar that is never coming has to surface as a
    // rejection the banner can show, not a promise nobody settles. Asserted as
    // elapsed time rather than a call count — a count can be inflated by a
    // neighbouring file's request landing during one of the waits.
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe("what must NOT be retried", () => {
  test("an HTTP error is an answer, so it is asked exactly once", async () => {
    const { api } = await import("../src/lib/api.ts");
    const calls = stub(async () => new Response("boom", { status: 500 }));

    await expect(api.projects()).rejects.toThrow();
    // Safe as an exact count: there is no await gap for a neighbour to slip
    // into — the response resolves and `get` throws on the same tick.
    expect(calls()).toBe(1);
  });

  test("a 404 is an answer too", async () => {
    const { api } = await import("../src/lib/api.ts");
    const calls = stub(async () => new Response("", { status: 404 }));

    await expect(api.projects()).rejects.toThrow();
    expect(calls()).toBe(1);
  });
});
