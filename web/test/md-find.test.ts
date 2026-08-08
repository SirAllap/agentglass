/*
 * Finding a word inside the rendered markdown.
 *
 * The DOM half — walking text nodes and building ranges — cannot be exercised
 * here: this runner has no document, and the project keeps no DOM shim (its one
 * component test renders to a string). So what is pinned down is the half where
 * the decisions live, and they are real decisions: matches must not overlap or
 * the same run is highlighted twice and the count on the bar lies, and stepping
 * has to wrap at both ends or holding Enter stops at the last hit.
 */
import { describe, expect, it } from "bun:test";
import { matchOffsets, step } from "../src/lib/mdFind.ts";

describe("where the matches are", () => {
  it("finds a word", () => {
    expect(matchOffsets("the risk register", "risk")).toEqual([4]);
  });

  it("finds every occurrence, not only the first", () => {
    expect(matchOffsets("risk, a risk and a risk", "risk")).toEqual([0, 8, 19]);
  });

  it("ignores case, because nobody types a heading's capitals", () => {
    expect(matchOffsets("Risk Monitoring — Guest checkout v2", "risk monitoring")).toEqual([0]);
    expect(matchOffsets("the SPI is 0.58", "spi")).toEqual([4]);
  });

  it("does NOT overlap its own matches", () => {
    /*
     * "aa" in "aaaa" is two matches, not three. Advancing by one would count
     * the middle pair as well, so the bar would say 3 while the document shows
     * two highlighted runs — and stepping would land twice on the same text.
     */
    expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
  });

  it("answers nothing for an empty query rather than everything", () => {
    // An empty field must not select the entire document.
    expect(matchOffsets("anything at all", "")).toEqual([]);
    expect(matchOffsets("anything at all", "   ".trim())).toEqual([]);
  });

  it("answers nothing when the document is empty", () => {
    expect(matchOffsets("", "risk")).toEqual([]);
  });

  it("finds a phrase, which is the case that needs the whole text joined", () => {
    // In the document this crosses inline elements — `risk **monitoring**` is
    // three text nodes — which is why findRanges concatenates before searching
    // instead of asking each node on its own.
    expect(matchOffsets("risk monitoring plan", "risk monitoring")).toEqual([0]);
  });
});

describe("walking them", () => {
  it("wraps forward off the end", () => {
    expect(step(2, 3, 1)).toBe(0);
  });

  it("wraps backward off the start", () => {
    expect(step(0, 3, -1)).toBe(2);
  });

  it("moves one at a time in between", () => {
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, -1)).toBe(1);
  });

  it("stays put when there is nothing to walk", () => {
    // Guarded rather than left to arithmetic: `% 0` is NaN, which as an index
    // silently highlights nothing and reports nothing.
    expect(step(0, 0, 1)).toBe(0);
    expect(step(0, 0, -1)).toBe(0);
  });
});
