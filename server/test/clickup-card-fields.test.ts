/*
 * A custom field, ready to draw.
 *
 * Every case here was on screen in the workspace this was measured against, wrong:
 * a triage date printing 1783414800000, an impacted-application printing the
 * option's UUID, and the person who reported a bug printing as nothing at all. The
 * card was rendering ClickUp's raw storage because nothing told it what a value was.
 */
import { describe, test, expect } from "bun:test";
import * as CU from "../src/clickup.ts";

const field = (over: Record<string, unknown>) =>
  CU.toTask({ id: "x", name: "n", custom_fields: [{ id: "f", name: "F", type: "text", ...over }] }).custom?.[0];

describe("what a value is, and how it should be drawn", () => {
  test("a label is its name and colour, not the option's id", () => {
    const f = field({
      type: "labels", value: ["opt-2"],
      type_config: { options: [
        { id: "opt-1", label: "Billing", color: "#2ea1e5" },
        { id: "opt-2", label: "Dialer", color: "#e05252" },
      ] },
    });
    expect(f).toMatchObject({ value: "Dialer", color: "#e05252", kind: "chip" });
  });

  test("several labels are all their names", () => {
    const f = field({
      type: "labels", value: ["a", "b"],
      type_config: { options: [{ id: "a", label: "One" }, { id: "b", label: "Two" }] },
    });
    expect(f!.value).toBe("One, Two");
  });

  test("a date travels as milliseconds, for the reader's own locale to format", () => {
    const f = field({ type: "date", value: "1783414800000" });
    expect(f).toMatchObject({ kind: "date", at: 1783414800000 });
    // Never the raw number as the words — that is the bug this is about.
    expect(f!.value).not.toBe("1783414800000");
  });

  // A date that cannot be read is not a row worth drawing — and it must never be
  // drawn as 1970, which is what a bare `new Date(NaN→0)` would put on the card.
  test("a date that is not a date never reaches the card", () => {
    expect(field({ type: "date", value: "nonsense" })).toBeUndefined();
    expect(field({ type: "date", value: 0 })).toBeUndefined();
  });

  test("a person is their name — ClickUp writes `username`, and we were reading `name`", () => {
    const f = field({ type: "users", value: [{ id: 1, username: "Ada Quill", email: "ada@example.com" }] });
    expect(f).toMatchObject({ value: "Ada Quill", kind: "people" });
  });

  test("and an email is a better answer than an empty cell", () => {
    expect(field({ type: "users", value: [{ id: 1, email: "ada@example.com" }] })!.value).toBe("ada@example.com");
  });

  test("a url keeps the address and shows the readable half", () => {
    const f = field({ type: "url", value: "https://calls.example.com/agent/call/CA2176de46?x=1" });
    expect(f).toMatchObject({ kind: "url", href: "https://calls.example.com/agent/call/CA2176de46?x=1" });
    expect(f!.value).toBe("calls.example.com/agent/call/CA2176de46");
  });

  test("something that is not a URL at all is still shown", () => {
    expect(field({ type: "url", value: "not a url" })!.value).toBe("not a url");
  });

  test("a paragraph is text, and a line is a chip — that is where the card puts them", () => {
    expect(field({ type: "text", value: "Two sentences. About a bug." })!.kind).toBe("text");
    expect(field({ type: "short_text", value: "Adler Law" })!.kind).toBe("chip");
  });

  test("a number and an amount are quantities", () => {
    expect(field({ type: "number", value: 8 })).toMatchObject({ value: "8", kind: "number" });
    expect(field({ type: "currency", value: "1200" })).toMatchObject({ value: "1200", kind: "number" });
  });

  test("a linked task is its name", () => {
    const f = field({ type: "list_relationship", value: [{ id: "t1", name: "ORBIT-990" }] });
    expect(f).toMatchObject({ value: "ORBIT-990", kind: "chip" });
  });

  // An unknown type shows the words rather than guessing at a shape.
  test("a type nobody here has seen falls back to showing the value", () => {
    expect(field({ type: "something_new", value: "still readable" })).toMatchObject({ value: "still readable", kind: "chip" });
  });

  test("and an empty value never reaches the card at all", () => {
    expect(field({ type: "drop_down", value: null })).toBeUndefined();
    expect(field({ type: "labels", value: [] })).toBeUndefined();
    expect(field({ type: "text", value: "" })).toBeUndefined();
  });
});
