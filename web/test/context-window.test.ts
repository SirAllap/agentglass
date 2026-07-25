import { describe, expect, it } from "bun:test";

import { ctxLimitOf } from "../src/lib/contextWindow.ts";

/**
 * The context ceiling per model, and the one property that makes it safe.
 *
 * This is the number the Radar's "about to compact" ring and the chat context
 * meter are drawn against, so getting it wrong doesn't error — it silently
 * mis-draws. The bug that motivated these tests: every Claude model was
 * assumed to be 200k, which was true a generation ago and is now wrong for
 * everything except Haiku. A 1M-window Opus 5 session read as about to compact
 * at a fifth of its real capacity.
 */

const M = 1_000_000;
const K = 1_000;

describe("ctxLimitOf — the 1M Claude models", () => {
  it("reads the 5 family as 1M", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"]) {
      expect(ctxLimitOf(id)).toBe(M);
    }
  });

  it("reads Opus/Sonnet 4.6 onward as 1M", () => {
    for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(ctxLimitOf(id)).toBe(M);
    }
  });
});

describe("ctxLimitOf — the 200k Claude models", () => {
  it("keeps Haiku at 200k", () => {
    expect(ctxLimitOf("claude-haiku-4-5")).toBe(200 * K);
  });

  /** The cut is mid-generation, which is why the pattern can't be a loose `4-\d`. */
  it("keeps Opus 4.5 and Sonnet 4.5 at 200k — 4.6 is where the window widens", () => {
    expect(ctxLimitOf("claude-opus-4-5")).toBe(200 * K);
    expect(ctxLimitOf("claude-sonnet-4-5")).toBe(200 * K);
  });

  it("keeps the older lines at 200k", () => {
    expect(ctxLimitOf("claude-opus-4-1")).toBe(200 * K);
    expect(ctxLimitOf("claude-3-5-sonnet-20241022")).toBe(200 * K);
  });
});

describe("ctxLimitOf — an id this file has never seen", () => {
  /**
   * Under-reading is recoverable (the observation rule below promotes it);
   * over-reading is not. An unknown id must therefore land on 200k, not 1M.
   */
  it("falls to the conservative 200k rather than guessing wide", () => {
    expect(ctxLimitOf("claude-something-7")).toBe(200 * K);
    expect(ctxLimitOf("")).toBe(200 * K);
    expect(ctxLimitOf(null)).toBe(200 * K);
    expect(ctxLimitOf(undefined)).toBe(200 * K);
  });

  it("is promoted by an observation that exceeds it", () => {
    // The self-healing rule: the measurement is harder evidence than the name.
    expect(ctxLimitOf("claude-something-7", 250_000)).toBe(400 * K);
    expect(ctxLimitOf("claude-something-7", 900_000)).toBe(M);
  });
});

describe("ctxLimitOf — the explicit suffix wins", () => {
  it("believes the id over the family default", () => {
    expect(ctxLimitOf("claude-opus-5[200k]")).toBe(200 * K);
    expect(ctxLimitOf("claude-haiku-4-5[1m]")).toBe(M);
  });
});

describe("ctxLimitOf — other providers are untouched", () => {
  it("keeps the non-Claude ceilings", () => {
    expect(ctxLimitOf("gemini-3-flash")).toBe(M);
    expect(ctxLimitOf("gpt-5")).toBe(400 * K);
    expect(ctxLimitOf("gpt-4o")).toBe(128 * K);
  });
});
