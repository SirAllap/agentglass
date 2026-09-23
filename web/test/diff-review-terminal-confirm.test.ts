import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * deliver() (DiffPage.tsx:229) used to clearReview(root) the instant
 * requestTermIssue was called — but requestTermIssue only PARKS the request;
 * it is sent by TerminalPanel's own effect, which only runs once a terminal
 * pane exists and its socket is live. With no pane open, the review vanished
 * with nothing visibly having happened (other callers, e.g. GitPanel's
 * askClaudeInTerminal, flash "Claude is on it in a tmux window…"), and a
 * reload before a pane opened lost the review for good.
 *
 * Source-level lock, same reasoning as diff-review-terminal.test.ts: deliver
 * is a closure inside a hook-heavy component with no renderer in this project.
 */
const src = readFileSync(new URL("../src/components/diff/DiffPage.tsx", import.meta.url), "utf8");

const between = (from: string, to: string): string => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

const deliver = between("const deliver = useCallback((stale: ReadonlySet<string>) => {", "const sendReview = useCallback");

describe("deliver() keeps the review until the terminal issue is actually sent", () => {
  test("does not clearReview in the same breath as requestTermIssue — it is deferred to a confirmation effect", () => {
    // requestTermIssue only parks the request; clearReview must not run until
    // TerminalPanel confirms it (by clearing the termIssue slot). Calling both
    // back to back in deliver() is exactly the bug.
    const reqAt = deliver.indexOf("requestTermIssue(");
    expect(reqAt).toBeGreaterThan(-1);
    const clearAt = deliver.indexOf("clearReview(", reqAt);
    expect(clearAt === -1 || clearAt - reqAt > 400).toBe(true);
  });

  test("says where it went, matching the tmux-window flash style other callers use", () => {
    expect(src).toMatch(/Claude is on it in a tmux window/);
  });

  test("opens/focuses the terminal view, like GitPanel/PrPanel's handoffs", () => {
    expect(deliver).toMatch(/requestWorktreeJump\(\s*\{\s*view:\s*"term"/);
  });

  test("a confirmation effect clears the review once the termIssue slot is actually consumed", () => {
    expect(src).toMatch(/clearReview\(\s*\w+\.root\s*\)/);
  });
});
