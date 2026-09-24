import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Send review opens a terminal session instead of chat — option (1).
 *
 * deliver() used to park the composed review as an unsent draft in whatever
 * chat was already open in the tree (or seed a new one), which is the pull
 * request review flow's OLD path too — before conflict resolution moved to a
 * fresh tmux window with an agent already on it (PrPanel.tsx's "Hand to
 * Claude in a terminal", requestTermIssue). This is that same move, reusing
 * the same call rather than inventing a second way to open a terminal.
 *
 * Source-level lock, not a render: there is no renderer in this project
 * (CLAUDE.md), and `deliver` is a closure inside a hook-heavy component that
 * a unit test cannot call directly without mounting the whole page.
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

describe("deliver() sends the review to a terminal, not a chat", () => {
  test("calls requestTermIssue with the checkout's own root", () => {
    expect(deliver).toContain("requestTermIssue(");
    expect(deliver).toMatch(/requestTermIssue\(\s*root\b/);
  });

  test("no longer parks it as a draft in a chat", () => {
    expect(deliver.includes("seedChat(")).toBe(false);
    expect(deliver.includes("updateChat(")).toBe(false);
  });

  test("imports requestTermIssue from lib/termIssue.ts", () => {
    const imports = src.slice(0, src.indexOf("const deliver"));
    expect(imports.includes("requestTermIssue") && imports.includes('from "../../lib/termIssue.ts"')).toBe(true);
  });
});
