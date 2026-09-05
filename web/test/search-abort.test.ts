/*
 * A search you can change your mind about.
 *
 * Reported with the spinner turning: "I made a mistake… I want to cancel the
 * search". Neither × cancelled anything. The one in the box only emptied it,
 * the one on the banner only closed the note, and the request ran to the end
 * and then WROTE ITS RESULT — opening the Looked up drawer for a search that
 * had been abandoned. Enter never checked `searching` either, so a second
 * Enter started a second sweep and the one that finished LAST won.
 *
 * Two mechanisms, and this file holds both because neither covers the other:
 *
 *   the controller  stops the request
 *   the stamp       stops the ANSWER — a response can be resolved and queued
 *                   when the abort lands, and would paint over what was asked
 *                   for next
 *
 * The transport half is exercised for real against a stubbed fetch. The wiring
 * half is read from the source, because it lives inside a React component and
 * what has to hold is which controls reach it — the same reason
 * tasks-search-clear.test.ts reads the source rather than rendering.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const realFetch = globalThis.fetch;

/*
 * Isolated the way api-cold-start-retry.test.ts is, and for its reasons: one
 * process runs every file, so a stub that does not DELEGATE breaks whatever
 * neighbour happens to fetch during an await here.
 */
const PROBE = "/clickup/search";
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function stub(handler: (init: RequestInit | undefined, n: number) => Promise<Response>): () => number {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes(PROBE)) return realFetch(input as RequestInfo, init);
    calls++;
    return handler(init, calls);
  }) as typeof fetch;
  return () => calls;
}

afterEach(() => { globalThis.fetch = realFetch; });

const { api } = await import("../src/lib/api.ts");

describe("the request", () => {
  test("carries the signal it was given", async () => {
    let seen: AbortSignal | null | undefined;
    stub(async (init) => { seen = init?.signal; return ok({ ok: true, tasks: [] }); });
    const ac = new AbortController();
    await api.clickupSearch("pagination arrows", false, ac.signal);
    expect(seen, "the signal reached fetch").toBe(ac.signal);
  });

  test("an already-aborted search never leaves", async () => {
    // The gate in `get` waits for the sidecar first, and a person can give up
    // during that wait. Checking only inside fetch would let the call go out.
    const calls = stub(async () => ok({ ok: true, tasks: [] }));
    const ac = new AbortController();
    ac.abort();
    await expect(api.clickupSearch("pagination arrows", false, ac.signal)).rejects.toThrow();
    expect(calls()).toBe(0);
  });

  test("and an abort is not retried four more times", async () => {
    /*
     * `get` retries a network throw, which is what a sidecar still starting
     * looks like. An abort is a DOMException and not a TypeError, so it leaves
     * on the first pass — if that ever changed, cancelling would COST four
     * more requests instead of saving one.
     */
    const calls = stub(async (init) => {
      // What fetch does with an aborted signal, spelled out.
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const ac2 = init?.signal;
      ac2?.dispatchEvent?.(new Event("abort"));
      throw new DOMException("aborted", "AbortError");
    });
    const ac = new AbortController();
    await expect(api.clickupSearch("x-ray", false, ac.signal)).rejects.toThrow();
    expect(calls(), "one attempt, not five").toBe(1);
  });

  test("a search with no signal behaves exactly as it did", async () => {
    // The option is opt-in. Every other caller in this file passes nothing and
    // must keep its retries.
    let seen: unknown = "unset";
    stub(async (init) => { seen = init && "signal" in init ? init.signal : "absent"; return ok({ ok: true, tasks: [] }); });
    await api.clickupSearch("pagination arrows");
    expect(seen).toBe("absent");
  });
});

describe("the controls that reach it", () => {
  const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
  /** Comments here name the very things these assertions forbid. */
  const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the × in the box cancels, not just clears", () => {
    expect(bare).toMatch(/onClick=\{\(\) => \{ cancelSearch\(\); setQ\(""\);/);
  });

  test("so does Escape, even with the box already empty", () => {
    // The × empties the box on its first press. If cancelling needed text in
    // it, the second press would have nothing to cancel with.
    expect(bare).toMatch(/e\.key === "Escape" && \(q \|\| searching\)/);
  });

  test("and so does the × on the banner that says it is running", () => {
    expect(bare).toContain("cancelSearch(); setNote(null);");
  });

  test("the × stays drawn while a search is running", () => {
    // Otherwise the one press that empties the box also removes the only
    // visible way to stop what is still going.
    expect(bare).toContain("{(q || searching) && (");
  });
});

describe("and the answer", () => {
  const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
  const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("a new search aborts the one before it", () => {
    // The parallel-sweep bug: Enter did not check `searching`, so two ran and
    // the slower one won.
    expect(bare).toContain("searchAbort.current?.abort();");
  });

  test("only the newest search may write anything", () => {
    // The stamp. Every place that touches the drawer, the note or the spinner
    // is behind it — an abort cannot un-resolve a promise that already has.
    expect(bare).toContain("const mine = () => run === searchRun.current;");
    expect(bare).toMatch(/if \(!mine\(\)\) return;/);
    expect(bare).toMatch(/if \(mine\(\)\) \{ setSearching\(false\)/);
  });

  test("and leaving the panel stops it too", () => {
    expect(bare).toContain("useEffect(() => () => searchAbort.current?.abort(), []);");
  });
});
