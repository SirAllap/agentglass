// A card key typed into the search: where GitHub is asked, where git is asked,
// and how many requests each costs.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "agx-refs-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.XDG_DATA_HOME = dir;
process.env.XDG_CACHE_HOME = dir;
process.env.AGENTGLASS_STATE_DIR = dir;
process.env.AGENTGLASS_DB = join(dir, "s.db");

const prs = await import("../src/prs.ts");
const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" } as never;
const expr = (q: string) => prs.__test_searchExpr(repo, "all", "all", q);

describe("the search GitHub is asked for a card key", () => {
  test("the key is quoted and scoped to the title and the description, once", () => {
    const e = expr("ref:orbit-1042");
    expect(e).toContain('"ORBIT-1042"');
    expect(e.match(/in:title,body/g)).toHaveLength(1);
    expect(expr("ref:ORBIT-1 ref:ORBIT-2").match(/in:title,body/g)).toHaveLength(1);
  });
  test("no key, no scoping; a malformed key is dropped, not sent", () => {
    expect(expr("retry")).not.toContain("in:title");
    expect(expr("ref:nope")).not.toContain("nope");
    expect(expr("ref:")).not.toContain("ref");
  });
  test("other qualifiers stay beside it", () => {
    const e = expr("author:ana-dev ref:ORBIT-1042");
    expect(e).toContain("author:ana-dev");
    expect(e).toContain('"ORBIT-1042"');
  });
});

const HEADS = [
  "aaa1\trefs/heads/main",
  "aaa2\trefs/heads/ORBIT-1042-Add-thing",
  "aaa3\trefs/heads/feat/orbit-1042-lower",
  "aaa4\trefs/heads/Orbit-1042_mixed".replace("_", "-"),
  "aaa5\trefs/heads/ORBIT-10420-other-card-with-longer-number",
  "aaa6\trefs/heads/ORBIT-77",
  "aaa7\trefs/tags/ORBIT-1042",
  "aaa8\trefs/heads/ORBIT-1042 spaced",
].join("\n");

describe("branches that carry a key", () => {
  test("any case, only heads, only safe names", () => {
    expect(prs.branchesCarrying(HEADS, "ORBIT-1042")).toEqual([
      "ORBIT-1042-Add-thing", "feat/orbit-1042-lower", "Orbit-1042-mixed", "ORBIT-10420-other-card-with-longer-number",
    ]);
    expect(prs.branchesCarrying(HEADS, "ORBIT-77")).toEqual(["ORBIT-77"]);
    expect(prs.branchesCarrying("", "ORBIT-1")).toEqual([]);
  });
  test("capped", () => {
    const many = Array.from({ length: 50 }, (_, i) => `s${i}\trefs/heads/ORBIT-5-x${i}`).join("\n");
    expect(prs.branchesCarrying(many, "ORBIT-5")).toHaveLength(20);
  });
});

describe("refBranchRows", () => {
  const clone = (name: string) => {
    const d = join(dir, name);
    mkdirSync(d);
    spawnSync("git", ["-C", d, "init", "-q"]);
    spawnSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/acme/orbit.git"]);
    return d;
  };
  const work = clone("clone");

  const node = (number: number, head: string) => ({
    number, title: `T${number}`, url: "", state: "OPEN", isDraft: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    baseRefName: "main", headRefName: head, author: { login: "ana-dev" }, labels: { nodes: [] }, assignees: { nodes: [] }, milestone: null,
  });

  test("one ls-remote and one GraphQL cold; nothing warm; a second key reuses the heads", async () => {
    let ls = 0, gql = 0, lastQuery = "";
    const deps = {
      lsRemote: async () => { ls++; return HEADS; },
      graphql: async (q: string) => {
        gql++; lastQuery = q;
        return { data: { repository: { b0: { nodes: [node(11, "ORBIT-1042-Add-thing")] }, b1: { nodes: [node(12, "feat/orbit-1042-lower"), node(11, "ORBIT-1042-Add-thing")] } } } };
      },
    };
    const cold = await prs.refBranchRows(work, "orbit-1042", deps);
    expect(cold.ok).toBe(true);
    expect(cold.rows!.map((r) => r.number)).toEqual([11, 12]);
    expect([ls, gql]).toEqual([1, 1]);
    expect(lastQuery).toContain('headRefName: "ORBIT-1042-Add-thing"');
    await prs.refBranchRows(work, "ORBIT-1042", deps);
    expect([ls, gql]).toEqual([1, 1]);
    const other = await prs.refBranchRows(work, "ORBIT-77", { ...deps, graphql: async () => ({ data: { repository: { b0: { nodes: [] } } } }) });
    expect(other.rows).toEqual([]);
    expect(ls).toBe(1);
  });

  test("no matching branch means no GraphQL at all", async () => {
    let gql = 0;
    const r = await prs.refBranchRows(work, "ZZZ-1", { lsRemote: async () => HEADS, graphql: async () => { gql++; return {}; } });
    expect(r).toMatchObject({ ok: true, rows: [] });
    expect(gql).toBe(0);
  });

  test("refuses what is not a key before touching git or GitHub", async () => {
    let ls = 0;
    for (const bad of ["", "orbit", "1042", "orbit-1; rm", 5, null]) {
      const r = await prs.refBranchRows(work, bad as never, { lsRemote: async () => { ls++; return ""; } });
      expect(r.ok).toBe(false);
    }
    expect(ls).toBe(0);
  });

  test("a clone git cannot reach answers an error and is not cached as empty", async () => {
    let ls = 0;
    const lonely = clone("lonely");
    const deps = { lsRemote: async () => { ls++; return null; } };
    expect((await prs.refBranchRows(lonely, "ORBIT-9", deps)).ok).toBe(false);
    expect((await prs.refBranchRows(lonely, "ORBIT-9", deps)).ok).toBe(false);
    expect(ls).toBe(2);
  });
});
