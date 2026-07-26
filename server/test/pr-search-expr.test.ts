// The panel's filter, translated into GitHub's search grammar.
//
// This is the seam that decides whether a filter searches the repository or
// only the twenty-five rows in hand. It replaced a client-side pass over the
// loaded page, which reported "Yoshiofthewire 2" for someone with three pull
// requests because the third was on another page. Every case here is a
// difference between the two grammars, or a way a body of free text could
// change the query's meaning.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-search-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "s.db");

const prs = await import("../src/prs.ts");
const repo = { key: "github.com/acme/orbit", host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" } as never;
const expr = (q?: string, filter: "mine" | "review" | "all" = "all", state: "open" | "closed" | "all" = "open") =>
  prs.__test_searchExpr(repo, filter, state, q);

describe("the base expression", () => {
  test("always names the repo, the type, and the order", () => {
    const e = expr();
    expect(e).toContain("repo:acme/orbit");
    expect(e).toContain("is:pr");
    expect(e).toContain("sort:updated-desc");
  });

  test("state maps to GitHub's own words — closed covers merged", () => {
    expect(expr(undefined, "all", "open")).toContain("is:open");
    expect(expr(undefined, "all", "closed")).toContain("is:closed");
    // "all" asks for no state at all, which is how you get both.
    const both = expr(undefined, "all", "all");
    expect(both).not.toContain("is:open");
    expect(both).not.toContain("is:closed");
  });

  test("the scope tabs are qualifiers too", () => {
    expect(expr(undefined, "mine")).toContain("author:@me");
    expect(expr(undefined, "review")).toContain("review-requested:@me");
  });
});

describe("facets become qualifiers", () => {
  test("author, assignee, label, milestone, base pass straight through", () => {
    const e = expr("author:yoshi assignee:sir label:bug milestone:v1 base:main");
    expect(e).toContain("author:yoshi");
    expect(e).toContain("assignee:sir");
    expect(e).toContain("label:bug");
    expect(e).toContain("milestone:v1");
    expect(e).toContain("base:main");
  });

  test("checks: is GitHub's status:", () => {
    expect(expr("checks:green")).toContain("status:success");
    expect(expr("checks:red")).toContain("status:failure");
    expect(expr("checks:pending")).toContain("status:pending");
    // and the panel's word never leaks through
    expect(expr("checks:green")).not.toContain("checks:");
  });

  test("is:draft / is:ready is GitHub's draft:true / draft:false", () => {
    expect(expr("is:draft")).toContain("draft:true");
    expect(expr("is:ready")).toContain("draft:false");
  });

  test("a value with spaces is quoted, so the words stay one value", () => {
    expect(expr('label:"needs review"')).toContain('label:"needs review"');
  });

  test("several values of one facet are all sent — search ORs them", () => {
    const e = expr("author:a author:b");
    expect(e).toContain("author:a");
    expect(e).toContain("author:b");
  });

  test("sort: is dropped — the order is ours to decide, not the text's", () => {
    const e = expr("sort:oldest");
    expect(e).not.toContain("sort:oldest");
    expect(e).toContain("sort:updated-desc");
  });
});

describe("free text", () => {
  test("plain words search, quoted so they cannot become qualifiers", () => {
    expect(expr("windows paths")).toContain('"windows"');
    expect(expr("windows paths")).toContain('"paths"');
  });

  test("an unknown qualifier is somebody's words, not a filter", () => {
    // `foo:bar` is not a GitHub qualifier; sending it raw would make the search
    // mean something nobody asked for.
    const e = expr("foo:bar");
    expect(e).toContain('"foo:bar"');
  });

  test("a stray quote cannot break out of the expression", () => {
    const e = expr('say"hello');
    expect(e).not.toContain('say"hello');
    expect(e.split('"').length % 2).toBe(1); // quotes stay balanced
  });

  test("empty and whitespace queries add nothing", () => {
    const base = expr();
    expect(expr("")).toBe(base);
    expect(expr("   ")).toBe(base);
  });

  test("a partial token being typed adds no qualifier", () => {
    // `author:` with nothing after it must not narrow to an empty author.
    expect(expr("author:")).not.toContain("author:@");
    expect(expr("author:")).toBe(expr());
  });
});
