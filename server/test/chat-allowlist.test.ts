// The chat allowlist decides what a browser request may run unattended, so it
// is worth pinning precisely.
//
// Context: `claude -p` has no terminal to prompt from, so a tool that would
// normally raise a permission dialog is refused and there is no way to grant it
// mid-chat. --allowedTools is the way out — which makes this list the thing
// standing between a chat message and arbitrary local execution.
import { describe, expect, test } from "bun:test";
import { allowList } from "../src/chat.ts";

describe("allowList", () => {
  test("accepts plain tool names and argument patterns", () => {
    expect(allowList(["Read", "Edit", "Bash(git status)", "Bash(gh pr view:*)"])).toEqual([
      "Read", "Edit", "Bash(git status)", "Bash(gh pr view:*)",
    ]);
  });

  test("drops anything that isn't a tool spec", () => {
    // Non-strings, shell metacharacters and newlines never reach the arg array.
    expect(allowList(["Read", 42, null, {}, "", "  "])).toEqual(["Read"]);
    expect(allowList(["Bash(git status)\nBash(rm -rf /)"])).toEqual([]);
    expect(allowList(["--dangerously-skip-permissions"])).toEqual([]);
  });

  test("rejects an unbalanced or nested parenthesis spec", () => {
    expect(allowList(["Bash(git"])).toEqual([]);
    expect(allowList(["Bash(a(b))"])).toEqual([]);
  });

  test("ignores a non-array payload entirely", () => {
    // The field is attacker-shaped input from a JSON body; a bare string must
    // not be treated as a one-element list.
    expect(allowList("Bash(rm -rf /)")).toEqual([]);
    expect(allowList(undefined)).toEqual([]);
    expect(allowList({ 0: "Read", length: 1 })).toEqual([]);
  });

  test("trims and caps the list", () => {
    expect(allowList([" Read "])).toEqual(["Read"]);
    expect(allowList(Array.from({ length: 100 }, () => "Read")).length).toBe(40);
  });

  test("a tool name cannot smuggle a second flag", () => {
    // Each entry becomes its own argv element, but a spec containing a space
    // outside parentheses would still be misleading — reject it.
    expect(allowList(["Read --allowedTools"])).toEqual([]);
  });
});
