import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { settleReview } from "../src/lib/diffReview.ts";

/*
 * deliver() used to clearReview(root) the instant
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

const deliver = between("const deliver = useCallback(async (stale: ReadonlySet<string>) => {", "const sendReview = useCallback");

const tray = readFileSync(new URL("../src/components/diff/DiffReview.tsx", import.meta.url), "utf8");

describe("Send never empties the review: the tray says how it went", () => {
  test("deliver() does not clear the review, on any answer", () => {
    // The slot empties the moment the request is SENT, and an ok answer only means a
    // window was asked for: with no agent CLI behind it the review used to be gone
    // and there was nothing to send again.
    expect(deliver).toContain("requestTermIssue(");
    expect(deliver.includes("clearReview(")).toBe(false);
  });

  test("a refusal is shown in the tray and says the review is kept", () => {
    expect(tray).toMatch(/failedSendNote\(outcome\.error, n\)/);
  });

  test("the slot is no longer the confirmation: no effect watches it", () => {
    expect(src.includes("subscribeTermIssue")).toBe(false);
  });

  test("says where it went, and offers the window", () => {
    expect(tray).toMatch(/Claude is on it in a tmux window/);
    expect(tray).toMatch(/Show the window/);
  });

  test("opens/focuses the terminal view, like GitPanel/PrPanel's handoffs", () => {
    expect(deliver).toMatch(/requestWorktreeJump\(\s*\{\s*view:\s*"term"/);
  });

  test("the tray is the only thing that discards, and it asks twice", () => {
    expect(src).toMatch(/onDiscard=\{\(\) => clearReview\(root\)\}/);
    expect(tray).toMatch(/if \(armed\)/);
  });
});

describe("settleReview reports the answer and touches nothing", () => {
  test("ok is passed through", async () => {
    expect(await settleReview(Promise.resolve({ ok: true }))).toEqual({ ok: true });
  });
  test("a refusal passes the reason", async () => {
    expect(await settleReview(Promise.resolve({ ok: false, error: "no agent" }))).toEqual({ ok: false, error: "no agent" });
  });
  test("a rejection is a failure, not a stuck wait", async () => {
    expect(await settleReview(Promise.reject(new Error("socket closed")))).toEqual({ ok: false, error: "socket closed" });
  });
  test("deliver goes through it", () => {
    expect(deliver).toContain("settleReview(answered)");
  });
});

test("the send-time stale check asks for a renamed file with its old path", () => {
  expect(src).toMatch(/api\.gitFileDiff\(root, path, mode, oldPathFor\(rows, root, path\)\)/);
});
