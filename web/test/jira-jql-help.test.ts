/*
 * What the popover offers for a context, and what accepting a row does to the text - jiraJqlHelp.ts's two pure
 * functions, buildCandidates and applyJqlCandidate.
 */
import { describe, expect, test } from "bun:test";
import { applyJqlCandidate, buildCandidates, type JqlVocab } from "../src/lib/jiraJqlHelp.ts";
import { jqlCursorContext } from "../src/lib/jiraJqlContext.ts";

const VOCAB: JqlVocab = {
  fields: [
    { value: "assignee", displayName: "Assignee", operators: ["=", "!=", "in", "not in", "is", "is not"], types: ["user"] },
    { value: "summary", displayName: "Summary", operators: ["~", "!~"], types: ["text"] },
    { value: "cf[10015]", displayName: "Start date", operators: ["=", "!=", ">", ">="], types: ["date"] },
  ],
  functions: [
    { value: "currentUser()", displayName: "currentUser()", isList: false, types: ["user"] },
    { value: "openSprints()", displayName: "openSprints()", isList: true, types: ["sprint"] },
  ],
};

describe("buildCandidates", () => {
  test("field position: field names and display names, matching what is typed, case-insensitively", () => {
    const rows = buildCandidates(jqlCursorContext("assig", 5), VOCAB);
    expect(rows.map((r) => r.value)).toEqual(["assignee"]);
    expect(buildCandidates(jqlCursorContext("Sum", 3), VOCAB).map((r) => r.value)).toEqual(["summary"]);
  });

  test("operator position: the field's own operators, narrowed by what is typed", () => {
    const rows = buildCandidates(jqlCursorContext("assignee n", 10), VOCAB);
    expect(rows.map((r) => r.value)).toEqual(["not in"]);
  });

  test("operator position: an unknown field still offers the common fallback", () => {
    const rows = buildCandidates(jqlCursorContext("priority ", 9), VOCAB);
    expect(rows.map((r) => r.value)).toEqual(["=", "!=", "in", "not in", "is", "is not"]);
  });

  test("value position: the field's own functions, by type, narrowed by what is typed - not offered on a field of a different type", () => {
    const rows = buildCandidates(jqlCursorContext("assignee = cur", 14), VOCAB);
    expect(rows.map((r) => r.value)).toEqual(["currentUser()"]);
    expect(buildCandidates(jqlCursorContext("summary ~ cur", 13), VOCAB).map((r) => r.value)).toEqual([]);
  });

  test("value position: the site's own answers come first, functions after, and a duplicate value is kept once", () => {
    const ctx = jqlCursorContext("assignee = ", 11);
    const rows = buildCandidates(ctx, VOCAB, [{ value: '"acc-1"', display: "Alex" }, { value: "currentUser()", display: "currentUser()" }]);
    expect(rows.map((r) => r.value)).toEqual(['"acc-1"', "currentUser()"]);
  });
});

describe("applyJqlCandidate", () => {
  test("a field leaves a trailing space, so the next key is the operator", () => {
    const ctx = jqlCursorContext("assig", 5);
    expect(applyJqlCandidate("assig", ctx, { value: "assignee", display: "Assignee" })).toEqual({ text: "assignee ", cursor: 9 });
  });

  test("a list operator (in, not in...) opens its paren too", () => {
    const ctx = jqlCursorContext("assignee n", 10);
    expect(applyJqlCandidate("assignee n", ctx, { value: "not in", display: "not in" })).toEqual({ text: "assignee not in (", cursor: 17 });
  });

  test("a plain operator just leaves a space", () => {
    const ctx = jqlCursorContext("assignee ", 9);
    expect(applyJqlCandidate("assignee ", ctx, { value: "=", display: "=" })).toEqual({ text: "assignee = ", cursor: 11 });
  });

  test("an unquoted value is inserted exactly as the site gave it (it is already the right JQL token)", () => {
    const ctx = jqlCursorContext("assignee = Al", 13);
    const r = applyJqlCandidate("assignee = Al", ctx, { value: '"5b10a2844c20165700ede21g"', display: "Alex Example" });
    expect(r.text).toBe('assignee = "5b10a2844c20165700ede21g"');
  });

  test("a value typed inside quotes the person already opened keeps those quotes - only the word inside changes", () => {
    const ctx = jqlCursorContext('assignee = "Al', 14);
    const r = applyJqlCandidate('assignee = "Al', ctx, { value: '"5b10a2844c20165700ede21g"', display: "Alex Example" });
    expect(r.text).toBe('assignee = "5b10a2844c20165700ede21g');
  });

  test("replaces only the partial word, keeping what is typed after the caret", () => {
    const text = "assig AND status = Done";
    const ctx = jqlCursorContext(text, 5);
    expect(applyJqlCandidate(text, ctx, { value: "assignee", display: "Assignee" }).text).toBe("assignee  AND status = Done");
  });
});
