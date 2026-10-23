/*
 * The GraphQL budget kept from answers the app already gets, and the hold it
 * puts on further requests. Pure functions, plus one assertion that a held
 * budget sends nothing at all.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { heldUntil, noteBody, noteField, noteHeaders, noteLimitedBlind, rateView, resetRate } from "../src/ghlimit.ts";
import { ghGraphql } from "../src/prs.ts";

const NOW = Date.UTC(2026, 9, 16, 18, 0, 0);
const hdr = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const later = (min: number) => String((NOW + min * 60_000) / 1000);

afterEach(() => resetRate());

describe("noteHeaders", () => {
  it("keeps the budget and holds nothing while there is room", () => {
    noteHeaders(hdr({ "x-ratelimit-remaining": "4210", "x-ratelimit-limit": "5000", "x-ratelimit-reset": later(40) }), 200, NOW);
    expect(rateView(NOW)).toMatchObject({ remaining: 4210, limit: 5000, limited: false, resetAt: NOW + 40 * 60_000 });
    expect(heldUntil(NOW)).toBeNull();
  });

  it("holds until the reset when the budget is spent", () => {
    noteHeaders(hdr({ "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": later(40) }), 200, NOW);
    expect(heldUntil(NOW)).toBe(NOW + 40 * 60_000);
    expect(heldUntil(NOW + 41 * 60_000)).toBeNull();
    expect(rateView(NOW + 41 * 60_000)?.limited).toBe(false);
  });

  it("holds for Retry-After on a secondary limit, whatever the budget says", () => {
    noteHeaders(hdr({ "x-ratelimit-remaining": "3000", "retry-after": "90" }), 403, NOW);
    expect(heldUntil(NOW)).toBe(NOW + 90_000);
  });

  it("holds a minute on a bare 429 and ignores a plain 500", () => {
    noteHeaders(hdr({}), 500, NOW);
    expect(rateView(NOW)).toBeNull();
    noteHeaders(hdr({}), 429, NOW);
    expect(heldUntil(NOW)).toBe(NOW + 60_000);
  });

  it("an answer with room lifts a hold that has been replaced", () => {
    noteHeaders(hdr({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": later(40) }), 200, NOW);
    noteHeaders(hdr({ "x-ratelimit-remaining": "5000", "x-ratelimit-reset": later(60) }), 200, NOW + 1);
    expect(heldUntil(NOW + 2)).toBeNull();
  });
});

describe("the other ways a limit shows", () => {
  it("a RATE_LIMITED error inside a 200", () => {
    noteBody({ errors: [{ type: "RATE_LIMITED" }] }, NOW);
    expect(heldUntil(NOW)).toBe(NOW + 60_000);
  });
  it("an ordinary error body holds nothing", () => {
    noteBody({ errors: [{ type: "NOT_FOUND" }] }, NOW);
    expect(heldUntil(NOW)).toBeNull();
  });
  it("a blind limit keeps the last reset when it is still ahead", () => {
    noteHeaders(hdr({ "x-ratelimit-remaining": "9", "x-ratelimit-reset": later(25) }), 200, NOW);
    noteLimitedBlind(NOW + 1000);
    expect(heldUntil(NOW + 1000)).toBe(NOW + 25 * 60_000);
  });
  it("the rateLimit field of a query", () => {
    noteField({ limit: 5000, remaining: 0, resetAt: new Date(NOW + 10 * 60_000).toISOString() }, NOW);
    expect(heldUntil(NOW)).toBe(NOW + 10 * 60_000);
  });
});

describe("while held, nothing is sent", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => { globalThis.fetch = realFetch; });

  it("ghGraphql answers null without a request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    noteHeaders(hdr({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((Date.now() + 600_000) / 1000) }), 200);
    expect(await ghGraphql("query{viewer{login}}", {})).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("the gh path is held too", () => {
  const SRC = readFileSync(new URL("../src/prs.ts", import.meta.url), "utf8");
  const fn = SRC.slice(SRC.indexOf("export async function gh("), SRC.indexOf("async function ghJson<"));

  it("gh() sends no GraphQL call while held, and says it in GitHub's words", () => {
    expect(fn).toContain('args[0] === "api" && args[1] === "graphql"');
    expect(fn).toMatch(/heldUntil\(\)[\s\S]*rate limit exceeded/);
    // The guard comes before the process is spawned.
    expect(fn.indexOf("heldUntil()")).toBeLessThan(fn.indexOf("Bun.spawn("));
  });

  it("only a failed call is read for the limit", () => {
    expect(fn).toMatch(/\(code \?\? 1\) !== 0 && LIMIT_TEXT\.test/);
  });
});
