/*
 * WHAT LEAVES THE MACHINE.
 *
 * The rule every arrangement of agents here runs by is that anything a
 * colleague can see belongs to the person. It was held by each agent
 * remembering it, which worked — the orchestrator running a real project said
 * so, and then said the quiet part: "por cultura, no por herramienta". These
 * are the tests for the tool.
 *
 * Two failure modes, and they pull against each other. Miss a real push and
 * the gate is decoration. Flag a `gh pr view` and the gate becomes a dialog
 * people learn to click through, which is worse than not having one.
 */
import { describe, expect, test } from "bun:test";
import { outwardAction, outwardShell, outwardLine } from "../src/outward.ts";

const bash = (command: string) => outwardAction("Bash", { command });

describe("things that leave", () => {
  test("a push, with where it lands", () => {
    const o = bash("git push origin feat/export-retry");
    expect(o?.kind).toBe("push");
    expect(o?.target).toContain("origin");
  });

  test("a push hidden behind a cd", () => {
    /* The command a person actually types. Splitting on the operators is why
       this file bothers with a tiny parser. */
    expect(bash("cd ~/code/app && git push")?.kind).toBe("push");
    expect(bash("git status; git push --force-with-lease")?.kind).toBe("push");
  });

  test("a pull request, and its body", () => {
    const o = bash(`gh pr create --base main --title "Fix the export" --body "Closes the dropped page"`);
    expect(o?.kind).toBe("pull-request");
    expect(o?.text).toBe("Closes the dropped page");
  });

  test("a comment, with the words that would appear", () => {
    const o = bash(`gh pr comment 1042 --body "This looks wrong to me, the retry drops the last page"`);
    expect(o?.kind).toBe("comment");
    expect(o?.target).toBe("1042");
    expect(o?.text).toContain("drops the last page");
  });

  test("a review, and which kind of review", () => {
    const o = bash("gh pr review 1042 --approve");
    expect(o?.kind).toBe("review");
    expect(o?.target).toContain("approve");
  });

  test("a merge", () => {
    expect(bash("gh pr merge 1042 --squash")?.kind).toBe("merge");
  });

  test("an API write, but not an API read", () => {
    expect(bash("gh api -X POST repos/o/r/issues/1/comments -f body=hello")?.kind).toBe("comment");
    expect(bash("gh api repos/o/r/pulls/1")).toBeNull();
  });

  test("a curl POST, named by where it lands", () => {
    expect(bash(`curl -X POST https://hooks.slack.com/services/xxx -d '{"text":"deployed"}'`)?.kind).toBe("chat");
    expect(bash(`curl -s -X PUT "https://api.example-tracker.com/api/v2/task/T-1" -d '{"status":"done"}'`)?.kind).toBe("comment");
    /* A GET through the same tool is a read. */
    expect(bash("curl -s https://api.example-tracker.com/api/v2/task/T-1")).toBeNull();
  });

  test("and the text rides along, because that is the point", () => {
    const o = bash(`curl -X POST https://hooks.slack.com/x -d 'the release is out'`);
    expect(o?.text).toBe("the release is out");
  });
});

describe("things that do not leave", () => {
  test("reads, listings and diffs", () => {
    for (const c of ["gh pr view 12", "gh pr list", "gh pr checks 12", "git log --oneline -5", "git diff", "git status"]) {
      expect(bash(c)).toBeNull();
    }
  });

  test("a dry run is a rehearsal", () => {
    expect(bash("git push --dry-run origin main")).toBeNull();
  });

  test("local work of every kind", () => {
    for (const c of ["bun test", "git commit -m 'wip'", "git worktree add ../x -b y", "rm -rf node_modules"]) {
      expect(bash(c)).toBeNull();
    }
  });

  test("a word inside a filename is not an action", () => {
    /* `git push` in a path is not a push. Anchoring on the command is what
       keeps this from crying wolf. */
    expect(bash("cat notes/how-to-git-push.md")).toBeNull();
    expect(bash("grep -r 'gh pr comment' docs/")).toBeNull();
  });
});

describe("tools that are not a shell", () => {
  test("a chat verb", () => {
    const o = outwardAction("mcp__slack__post_message", { channel: "#team", text: "shipping now" });
    expect(o?.kind).toBe("chat");
    expect(o?.target).toBe("#team");
    expect(o?.text).toBe("shipping now");
  });

  test("a tracker verb", () => {
    expect(outwardAction("mcp__clickup__update_task", { task_id: "T-1", status: "done" })?.kind).toBe("ticket");
  });

  test("a forge verb, by what it does", () => {
    expect(outwardAction("mcp__github__merge_pull_request", { pull_number: "3" })?.kind).toBe("merge");
    expect(outwardAction("mcp__github__create_review", { pull_number: "3" })?.kind).toBe("review");
  });

  test("but a read on the same tool is not", () => {
    expect(outwardAction("mcp__github__get_pull_request", { pull_number: "3" })).toBeNull();
    expect(outwardAction("Read", { file_path: "/tmp/x" })).toBeNull();
  });
});

describe("what a person is shown", () => {
  test("says what it does, not which tool it used", () => {
    expect(outwardLine({ kind: "push", target: "origin main" })).toBe("This pushes commits off this machine (origin main)");
    expect(outwardLine({ kind: "review" })).toBe("This submits a review");
  });
});

describe("the parser", () => {
  test("does not cut a sentence at punctuation inside quotes", () => {
    /* The body IS the thing being shown. Splitting on a `;` inside it would
       put half a comment in front of somebody deciding about the whole. */
    const o = outwardShell(`gh pr comment 7 --body "it fails; then it retries, and drops a page"`);
    expect(o?.text).toBe("it fails; then it retries, and drops a page");
  });

  test("finds the flag with an equals sign as well as a space", () => {
    expect(outwardShell(`gh pr create --body="short one"`)?.text).toBe("short one");
  });
});
