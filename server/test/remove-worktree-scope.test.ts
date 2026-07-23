// removeWorktree deletes a worktree's registration before its files, and on
// failure a fallback rebuilds that registration. Handed a linked worktree of a
// DIFFERENT repo, the removal fails and the fallback fabricates a phantom
// registration inside the in-scope repo's .git — so the path must be verified as
// a worktree of this repo first, exactly like its siblings do.
import { afterAll, describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const base = mkdtempSync(join(tmpdir(), "agx-rmwt-"));
// Restored in afterAll: process.env is shared across every test file in one
// `bun test` run, so leaking a scope root here would silently rescope an
// order-dependent suite that loads after this one.
const ROOT0 = process.env.AGENTGLASS_ROOT;
process.env.AGENTGLASS_ROOT = base; // both repos are inside the open scope
afterAll(() => { if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0; });
const A = join(base, "A");
const B = join(base, "B");
const Awt = join(base, "A-wt");
const Bwt = join(base, "B-wt");
const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });

let gitwork: typeof import("../src/gitwork.ts");

beforeAll(async () => {
  for (const r of [A, B]) {
    spawnSync("git", ["init", "-q", "-b", "main", r]);
    g(r, "config", "user.email", "t@example.com");
    g(r, "config", "user.name", "T");
    writeFileSync(join(r, "f.txt"), "x\n");
    g(r, "add", "-A"); g(r, "commit", "-qm", "seed");
  }
  g(A, "worktree", "add", "-q", Awt);
  g(B, "worktree", "add", "-q", Bwt);
  gitwork = await import("../src/gitwork.ts");
});

describe("removeWorktree membership", () => {
  test("refuses a worktree that belongs to a different repo", () => {
    const r = gitwork.removeWorktree(A, Bwt, false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a worktree of this repository");
  });

  test("still removes a real worktree of the repo", () => {
    const r = gitwork.removeWorktree(A, Awt, false);
    expect(r.ok).toBe(true);
  });
});
