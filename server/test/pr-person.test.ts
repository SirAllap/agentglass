// A person's board is two searches, merged by the panel; nothing about it may
// reach GitHub on a login that is not one.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-person-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "s.db");

const prs = await import("../src/prs.ts");
const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" } as never;
const expr = (q: string) => prs.__test_searchExpr(repo, "all", "open", q);

describe("the two searches a person's board is made of", () => {
  test("what they opened, and what they were asked to review", () => {
    expect(expr("author:ana-dev")).toContain("author:ana-dev");
    expect(expr("reviewer:ana-dev")).toContain("review-requested:ana-dev");
    expect(expr("author:ana-dev")).toContain("is:open");
  });
});

describe("personBoard", () => {
  test("refuses anything that is not a login before it asks anybody", async () => {
    for (const bad of ["", "ana dev", "ana-dev author:bo", "-ana", "a".repeat(40), "ana/dev", 5, null]) {
      const r = await prs.personBoard("/nowhere", bad as never);
      expect(r.ok).toBe(false);
      expect(r.error).toBe("not a GitHub login");
    }
  });
});
