/*
 * A SEARCH THAT SHOWS WHAT IT HAS FOUND SO FAR.
 *
 * ClickUp has no text search, so this reads the workspace itself: three
 * sequential pages of a workspace with thousands of cards. Answering only at
 * the end is a spinner where a filling list should be — "besides, it takes
 * FOREVER… at least show me what it's finding as it goes, no?".
 *
 * The transport is one JSON object per line. What this pins is the reading of
 * it, because that is where the mistakes live: a chunk that splits a line in
 * half, a line that cannot be parsed, and an abort that must not be reported
 * as a failure.
 */
import { describe, expect, test } from "bun:test";
import { afterEach } from "bun:test";
import { api } from "../src/lib/api.ts";
import type { ProviderTask } from "../../shared/providers.ts";

/*
 * `bun test` shares one process, so `globalThis.fetch` belongs to every file.
 * The stub DELEGATES anything that is not this path — a neighbour's poll must
 * behave exactly as it would have, which is the rule that file learned the
 * hard way.
 */
const realFetch = globalThis.fetch;
const PATH = "/clickup/search/stream";
afterEach(() => { globalThis.fetch = realFetch; });

function streaming(chunks: string[]) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(PATH)) return realFetch(input as RequestInfo, init);
    if (init?.signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    }), { headers: { "content-type": "application/x-ndjson" } }));
  }) as typeof fetch;
}

const card = (id: string) => ({ id, title: `card ${id}`, list: "Miscellaneous" });

describe("reading a streamed search", () => {
  test("hands over each batch as it lands, and reports what was scanned", async () => {
    streaming([
      `{"tasks":[${JSON.stringify(card("a"))}]}\n`,
      `{"tasks":[${JSON.stringify(card("b"))},${JSON.stringify(card("c"))}]}\n`,
      `{"done":true,"scanned":300}\n`,
    ]);
    const seen: ProviderTask[][] = [];
    const r = await api.clickupSearchStream("9175", false, (batch) => seen.push(batch));

    expect(seen.map((b) => b.map((t) => t.id))).toEqual([["a"], ["b", "c"]]);
    expect(r.ok).toBe(true);
    expect(r.scanned).toBe(300);
  });

  test("a line split across two chunks is still one line", async () => {
    const whole = `{"tasks":[${JSON.stringify(card("split"))}]}\n{"done":true,"scanned":1}\n`;
    streaming([whole.slice(0, 20), whole.slice(20)]);
    const seen: string[] = [];
    const r = await api.clickupSearchStream("x", false, (b) => seen.push(...b.map((t) => t.id)));

    expect(seen, "the halves were parsed as two broken lines").toEqual(["split"]);
    expect(r.ok).toBe(true);
  });

  test("a line it cannot read is skipped, not fatal", async () => {
    streaming([`not json\n{"tasks":[${JSON.stringify(card("after"))}]}\n{"done":true,"scanned":2}\n`]);
    const seen: string[] = [];
    const r = await api.clickupSearchStream("x", false, (b) => seen.push(...b.map((t) => t.id)));

    expect(seen).toEqual(["after"]);
    expect(r.ok).toBe(true);
  });

  test("an abort is what was asked for, not an error to report", async () => {
    streaming([`{"tasks":[${JSON.stringify(card("one"))}]}\n`]);
    const ac = new AbortController();
    ac.abort();
    const r = await api.clickupSearchStream("x", false, () => {}, ac.signal);

    expect(r.ok, "a cancelled search must not read as a failure").toBe(true);
    expect(r.error).toBeUndefined();
  });
});
