// "Claude is on it" has to be something the terminal said, not something the
// button hoped. A request used to be dropped into a one-slot bus and the caller
// wrote its success note on the next line; a refusal by the server, or no
// terminal view mounted to take the request, both read as success.
import { expect, test } from "bun:test";
import { requestTermIssue, resolveTermIssue, termIssue, clearTermIssue, UNTAKEN_MS } from "../src/lib/termIssue.ts";
import { worktreeJump } from "../src/lib/worktreeJump.ts";

test("the promise carries the server's answer, refusal and reason included", async () => {
  const p = requestTermIssue("/home/dev/orbit-wt", "conflict-7", "fix it", true);
  const n = termIssue()!.n;
  clearTermIssue(); // what the terminal does when it sends
  resolveTermIssue(n, { ok: false, error: "orbit-wt is outside the open project" });
  expect(await p).toEqual({ ok: false, error: "orbit-wt is outside the open project" });
});

test("request numbers never repeat, even after the slot is cleared", () => {
  void requestTermIssue("/x", "a", "", false); const a = termIssue()!.n; clearTermIssue();
  void requestTermIssue("/x", "a", "", false); const b = termIssue()!.n; clearTermIssue();
  expect(b).toBeGreaterThan(a);
});

test("a request nobody takes is withdrawn and reported, not left to start an agent later", async () => {
  const p = requestTermIssue("/home/dev/orbit-wt", "conflict-8", "fix it", true);
  const r = await p;
  // First it brings Terminal forward, which is what mounts a view nobody opened.
  expect(worktreeJump()?.view).toBe("term");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("Terminal view is not open");
  expect(termIssue()).toBeNull();
}, UNTAKEN_MS + 3000);
