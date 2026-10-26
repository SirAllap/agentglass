/*
 * A pull request whose conflict has been handed to Claude says so, instead of
 * offering the same two buttons as if nothing were running.
 *
 * There is no renderer in this project, so the rules are asserted against the
 * source they live in: where the answer comes from, what it replaces, and that
 * it cannot be a timer.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const hook = await read("../src/lib/liveWindow.ts");
const pr = await read("../src/components/PrPanel.tsx");
const git = await read("../src/components/GitPanel.tsx");
const sendTo = await read("../src/lib/sendToTerminal.ts");
const term = await read("../src/components/TerminalPanel.tsx");
const termIssueSrc = await read("../src/lib/termIssue.ts");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

const body = (src: string, head: string) => {
  const at = src.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const close = src.indexOf("\n}\n", at);
  return src.slice(at, close);
};

describe("where the answer comes from", () => {
  test("the engine is asked, by name and repository, and nothing is remembered between loads", () => {
    const c = code(hook);
    expect(c).toContain("api.tmuxLiveWindow(root, name, path)");
    expect(c).not.toMatch(/localStorage|sessionStorage/);
  });

  test("no timer drives it: focus, visibility and a changed tab strip do", () => {
    const c = code(hook);
    expect(c).not.toMatch(/setInterval|usePoll/);
    expect(c).toContain('"focus"');
    expect(c).toContain('"visibilitychange"');
    expect(code(term)).toContain("noteWindowSet(s.tmuxWindows)");
  });

  test("another card's answer is never shown on this one", () => {
    expect(code(hook)).toContain("w && w.name === name ? w : null");
  });

  test("a failed read keeps the last answer, because a silent server is not a closed window", () => {
    expect(code(hook)).toMatch(/\.catch\(\(\) => \{[^}]*\}\)/);
    expect(code(hook)).not.toMatch(/\.catch\(\(\) => setW\(null\)\)/);
  });
});

describe("the pull request's conflict card", () => {
  const card = body(pr, "function ConflictActions(");
  const c = code(card);

  test("the window it looks for is the one it opens, named from the same constant", () => {
    expect(c).toContain("const windowName = `conflict-${number}`;");
    expect(c).toContain("useLiveWindow(root, windowName)");
    expect(c).toContain("requestTermIssue(p.root, windowName,");
  });

  test("while it is live, the handoff button becomes Open tab and starts nothing", () => {
    expect(c).toContain("{live ? (");
    expect(c).toContain("openLiveWindow(live)");
    expect(c).toContain("Open tab");
  });

  test("while it is live, the in-app resolver is off, with the reason as its title", () => {
    expect(c).toMatch(/disabled=\{disabled \|\| !!busy \|\| !!live\} warn/);
    expect(c).toContain("two things must not edit the same checkout");
  });

  test("the note saying Claude is on it goes when its window does", () => {
    expect(c).toContain("if (wasLive.current && !live) setNote(\"\")");
  });

  test("a press that raced and found the window already there says so", () => {
    expect(c).toContain("done.reused");
  });
});

describe("the git panel's conflicts window", () => {
  test("is keyed by the checkout as well as the name, so another worktree's is not this one's", () => {
    expect(code(git)).toContain('useLiveWindow(root, "conflicts", root)');
    expect(code(git)).toContain("if (conflictWindow) { void openLiveWindow(conflictWindow); return; }");
  });
});

describe("reuse is asked for, never the default", () => {
  /* A different prompt sent to a window that is already running is dropped, so
     a name that does not stand for ONE piece of work must not reuse. */
  const issue = code(termIssueSrc);
  test("requestTermIssue does not reuse unless told to", () => {
    expect(issue).toContain(`effort = "", reuse = false, kind = "", mode?: LaunchMode)`);
  });
  test("the handoffs whose window is one piece of work ask for it", () => {
    expect(code(pr)).toContain('h.model, h.effort, true)');
    // The check goes through the shared helper, which is what asks for reuse (and starts the default engine).
    expect(code(pr)).toContain('sendToTerminal(r.cwd, prompt, `check-${detail.number}`)');
    expect(sendTo).toContain('requestTermIssue(cwd, windowNameFor(title), prompt, true, false, title, "", "", true,');
    expect(code(git)).toContain('h.model, h.effort, true)');
  });
  test("the socket carries it", () => {
    expect(code(term)).toContain("reuse: issue.reuse");
  });
});
