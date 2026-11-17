/*
 * Who may choose an account, and which routes name their repo, asserted against the
 * source (the house form for a route's guard: see review-publish.test.ts). A booted
 * server needs a writable /tmp this test does not ask for.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

/** The text of one route's block: from its `pathname ===` / `startsWith` line to the next route at the same indent. */
function block(head: string): string {
  const at = src.indexOf(head);
  expect(at, `no route matching ${head}`).toBeGreaterThan(0);
  const end = src.indexOf("\n    if (pathname", at + head.length);
  return src.slice(at, end < 0 ? at + 2000 : end);
}

describe("choosing an account is the person's, never an agent's", () => {
  for (const head of [
    `if (pathname === "/providers/default" && req.method === "POST")`,
    `if (pathname === "/tracker/accounts" && req.method === "POST")`,
    `if (pathname.startsWith("/providers/") && req.method === "POST")`,
  ]) {
    test(`${head.slice(4, 50)}: mayPublishReview is asked before the body is read`, () => {
      const b = block(head);
      expect(b).toContain("mayPublishReview(req, caller)");
      expect(b.indexOf("mayPublishReview(req, caller)")).toBeLessThan(b.indexOf("req.json()"));
    });
  }
});

describe("a ClickUp route names its repo in the body as well as the query", () => {
  test("the write block enters the body's repo before any write runs", () => {
    const b = block(`if (pathname.startsWith("/clickup/") && req.method === "POST")`);
    expect(b).toContain("enterForRepo(b.repo)");
    expect(b.indexOf("enterForRepo(b.repo)")).toBeLessThan(b.indexOf("await addClickupFolder"));
  });
  test("card find skips the default account's id prefix when an account is in scope", () => {
    expect(block(`if (pathname === "/clickup/find")`)).toContain("clickupAccount() ? \"\" : knownCardPrefix()");
  });
});
