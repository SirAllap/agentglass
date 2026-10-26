/*
 * The matching behind the agent rules, as a pure question: what a rule list
 * decides for one tool call, which edits hand an agent more, and what a person
 * would write as the rule for a call.
 */
import { describe, expect, test } from "bun:test";
import { BASE_RULES, decide, isLooser, isLooserMode, ruleFor, shellSegments, type AgentRule, type RuleSetting } from "../../shared/agentRules.ts";

const ROOT = "/work/acme/orbit";
let n = 0;
const rule = (match: string, setting: RuleSetting, project = "*"): AgentRule =>
  ({ id: `ar_${n++}`, project, action: `a${n}`, match, setting, source: "you", by: "you", at: 1 });
const base = BASE_RULES.map((b) => rule(b.match, b.setting));

describe("decide", () => {
  test("a project's own never beats the base allow for the same pattern", () => {
    const rules = [rule("Bash(git push:*)", "allow"), rule("Bash(git push:*)", "never", ROOT)];
    expect(decide(rules, ROOT, "Bash", { command: "git push origin main" }).decision).toBe("never");
    // another project keeps the base allow
    expect(decide(rules, "/work/acme/other", "Bash", { command: "git push origin main" }).decision).toBe("allow");
  });

  test("a project's own allow speaks for it over the base never", () => {
    const rules = [rule("Bash(gh pr merge:*)", "never"), rule("Bash(gh pr merge:*)", "allow", ROOT)];
    expect(decide(rules, ROOT, "Bash", { command: "gh pr merge 3" }).decision).toBe("allow");
  });

  test("merging hides nowhere in a compound line", () => {
    for (const command of ["cd x && gh pr merge 3", "echo hi; gh pr merge 3", "true | gh pr merge 3", "FOO=1 gh pr merge 3", "(gh pr merge 3)"]) {
      const d = decide(base, ROOT, "Bash", { command });
      expect(d.decision, command).toBe("never");
      expect(d.reason).toContain("gh pr merge");
    }
  });

  test("a prefix rule matches at a word boundary: `git push:*` is not `git pushy`", () => {
    const rules = [rule("Bash(git push:*)", "never")];
    expect(decide(rules, ROOT, "Bash", { command: "git push" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Bash", { command: "git push -f" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Bash", { command: "git pushy" }).decision).toBe("unknown");
  });

  test("a line with a command no rule covers is unknown, unless another command is already never", () => {
    expect(decide(base, ROOT, "Bash", { command: "git push && npm publish" }).decision).toBe("unknown");
    expect(decide(base, ROOT, "Bash", { command: "npm publish && gh release create v1" }).decision).toBe("never");
  });

  test("a pending suggestion decides nothing", () => {
    const pending = { ...rule("Bash(npm publish:*)", "never"), pending: true };
    expect(decide([pending], ROOT, "Bash", { command: "npm publish" }).decision).toBe("unknown");
  });

  test("other tools match by name, and a path pattern by glob", () => {
    const rules = [rule("Edit", "ask"), rule("Write(/etc/**)", "never")];
    expect(decide(rules, ROOT, "Edit", { file_path: "/x/y.ts" }).decision).toBe("ask");
    expect(decide(rules, ROOT, "Write", { file_path: "/etc/hosts" }).decision).toBe("never");
    expect(decide(rules, ROOT, "Write", { file_path: "/tmp/hosts" }).decision).toBe("unknown");
  });
});

describe("ruleFor", () => {
  test("a Bash command keeps its first two words", () => {
    expect(ruleFor("Bash", { command: "npm publish --tag beta" })).toEqual({ action: "bash.npm.publish", match: "Bash(npm publish:*)" });
    expect(ruleFor("Bash", { command: "git commit -m hi" })?.match).toBe("Bash(git commit:*)");
  });
  test("a flag or a path is not a subcommand", () => {
    expect(ruleFor("Bash", { command: "ls -la" })).toBeNull();
    expect(ruleFor("Bash", { command: "make -j4 build" })?.match).toBe("Bash(make:*)");
    // a path is not a plain word: it must not be skipped so that its flag becomes the rule
    expect(ruleFor("Bash", { command: "./run.sh --x" })).toBeNull();
    expect(ruleFor("Bash", { command: "/usr/bin/env --x" })).toBeNull();
  });
  test("another tool is its own name", () => {
    expect(ruleFor("Edit", { file_path: "/a" })).toEqual({ action: "edit", match: "Edit" });
  });
  test("a call that only reads is null", () => {
    expect(ruleFor("Read", { file_path: "/a" })).toBeNull();
    expect(ruleFor("Grep", { pattern: "x" })).toBeNull();
    expect(ruleFor("Bash", { command: "ls" })).toBeNull();
    expect(ruleFor("Bash", { command: "cd /x && cat y" })).toBeNull();
  });
});

describe("isLooser", () => {
  test("handing an agent more is looser; the same or less is not", () => {
    expect(isLooser("never", "ask")).toBe(true);
    expect(isLooser("never", "allow")).toBe(true);
    expect(isLooser("ask", "allow")).toBe(true);
    expect(isLooser("allow", "ask")).toBe(false);
    expect(isLooser("allow", "never")).toBe(false);
    expect(isLooser("ask", "ask")).toBe(false);
  });
  test("no rule counts as ask", () => {
    expect(isLooser(null, "allow")).toBe(true);
    expect(isLooser(null, "ask")).toBe(false);
    expect(isLooser(null, "never")).toBe(false);
  });
  test("a mode that asks less is looser", () => {
    expect(isLooserMode("default", "bypassPermissions")).toBe(true);
    expect(isLooserMode("auto", "default")).toBe(false);
  });
});

describe("shellSegments", () => {
  test("splits on every operator and strips env assignments", () => {
    expect(shellSegments("A=1 B=2 git push && (echo a | cat); ls")).toEqual(["git push", "echo a", "cat", "ls"]);
  });
});
