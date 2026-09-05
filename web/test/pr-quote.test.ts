/*
 * "Quote reply", and the blank line that eats half of it.
 *
 * The failure this is written against is silent: a two-paragraph remark quoted with
 * an unprefixed blank line between the paragraphs comes out as one quote followed by
 * the second half as the REPLY's own prose — so you appear to have written what
 * somebody else said.
 */
import { describe, expect, it } from "bun:test";
import { quoteReply } from "../src/lib/prQuote.ts";

describe("quoteReply", () => {
  it("prefixes every line", () => {
    expect(quoteReply("", "one\ntwo")).toBe("> one\n> two\n\n");
  });

  it("prefixes the blank line between two paragraphs", () => {
    const out = quoteReply("", "first\n\nsecond");
    expect(out.split("\n").slice(0, 3)).toEqual(["> first", ">", "> second"]);
  });

  it("appends to what was already being written", () => {
    expect(quoteReply("my answer", "said")).toBe("my answer\n\n> said\n\n");
  });

  it("leaves one blank line at the end, for the answer", () => {
    expect(quoteReply("", "said")).toEndWith("\n\n");
    expect(quoteReply("", "said\n\n\n")).toBe("> said\n\n");
  });

  it("keeps the markdown, because that is the point", () => {
    expect(quoteReply("", "see `x` and **y**")).toContain("> see `x` and **y**");
  });

  it("does nothing with nothing to quote", () => {
    expect(quoteReply("draft", "")).toBe("draft");
    expect(quoteReply("draft", "   \n  ")).toBe("draft");
  });
});
