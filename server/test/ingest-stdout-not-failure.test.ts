/*
 * A command that worked is not an error, whatever its output says.
 *
 * `detectError` used to scan FAIL_MARKERS across stdout as well as stderr, on a
 * comment claiming those words "rarely appear in successful output". Measured
 * against the real database over 24 hours: 104 of 179 flagged events matched a
 * marker, and in most of them the command had succeeded and written nothing to
 * stderr at all — "no such file or directory" (62), "fatal:" (19), "traceback"
 * (17), "command not found" (6), all of it in the ANSWER rather than in a
 * complaint.
 *
 * The proof is self-demonstrating and was collected by accident: the six most
 * recent flagged events at the time of writing were a SQL query MEASURING the
 * errors, a `cat` of the report about them, and a `sed` reading the marker
 * array itself — the file contains the literals, so reading the error detector
 * fired an urgent desktop popup. Investigating the bug produced the bug.
 *
 * The distinction the fix rests on: stderr is the stream a program uses to say
 * it failed; stdout is the stream it uses to answer. Scanning the answer for
 * the vocabulary of failure cannot tell a program that failed from one that was
 * asked about failure — and no wording of the marker list ever will, which is
 * why the fix is a deletion rather than a longer list.
 *
 * A tool that genuinely fails is still caught: is_error, success:false,
 * interrupted, a non-empty error/error_text/stderr, or a
 * returnCodeInterpretation that says so — four branches above this one.
 */
import { describe, expect, test } from "bun:test";
import { detectError } from "../src/ingest.ts";

describe("failure markers are read on stderr only", () => {
  /** The real shape. `detectError` reads `tool_response`, and passing these
   *  flat goes through a different branch entirely — the first draft of this
   *  file did exactly that and its assertions held for the wrong reason. */
  const resp = (r: Record<string, unknown>) => detectError("PostToolUse", { tool_response: r });

  test("a marker in stdout, with a clean stderr, is not an error", () => {
    for (const stdout of [
      "no such file or directory",                       // a grep of these very words
      "Traceback (most recent call last):",              // a report quoting a traceback
      "fatal: not a git repository",                     // a log being read back
      "command not found",                               // documentation
      "  permission denied  ",                           // a comment in a source file
    ]) {
      expect(resp({ stdout, stderr: "" }).is_error, `stdout: ${stdout}`).toBe(0);
    }
  });

  test("the same marker on stderr still is", () => {
    // The stream that means it. Deleting the stdout scan must not delete this.
    expect(resp({ stdout: "", stderr: "fatal: not a git repository" }).is_error).toBe(1);
    expect(resp({ stdout: "ok", stderr: "bash: frobnicate: command not found" }).error_text)
      .toContain("command not found");
  });

  test("reading this file's own detector is not a failure", () => {
    // The exact shape that fired the popups: a `sed` that succeeded and whose
    // output happens to be the marker array.
    const stdout = [
      "const FAIL_MARKERS = [",
      '  "command not found",',
      '  "no such file or directory",',
      '  "traceback (most recent call last)",',
      '  "fatal:",',
      "];",
    ].join("\n");
    expect(resp({ stdout, stderr: "" }).is_error).toBe(0);
  });

  test("and a tool that really failed is untouched by any of this", () => {
    // The branches above the marker scan, which are what actually catches a
    // failure. Measured over 24h of the real database, 182 flagged events:
    // 66 came from `is_error`, 17 from a marker on stderr, and 99 — 54% —
    // from stdout alone. Those 99 are what this file deletes; these are not.
    expect(resp({ is_error: true, stdout: "all fine" }).is_error).toBe(1);
    expect(resp({ success: false, stdout: "all fine" }).is_error).toBe(1);
    expect(resp({ interrupted: true, stdout: "all fine" }).is_error).toBe(1);
    expect(resp({ returnCodeInterpretation: "error", stdout: "all fine" }).is_error).toBe(1);
    // And the top-level shapes, which never reach tool_response at all.
    expect(detectError("PostToolUseFailure", { error: "boom" }).is_error).toBe(1);
    expect(detectError("PostToolUse", { stderr: "boom" }).is_error).toBe(1);
  });
});
