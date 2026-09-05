/*
 * Who owns the files a pull request touches.
 *
 * Every case here is a way of reading CODEOWNERS backwards, and all of them fail
 * quietly — a wrong owner is not an error, it is a reviewer who never gets asked.
 * The one with the sharpest edge is the first: LAST match wins, so a repository that
 * narrows `*` down to a team on the next line means the opposite of what a
 * first-match reader would report.
 */
import { describe, expect, it } from "bun:test";
import { loginOf, ownersFor, ownersOf, type OwnerRule } from "../src/lib/codeowners.ts";

const rules = (...lines: [string, ...string[]][]): OwnerRule[] =>
  lines.map(([pattern, ...owners]) => ({ pattern, owners }));

describe("ownersFor", () => {
  it("takes the LAST matching rule, not the first", () => {
    const r = rules(["*", "@everyone"], ["/src/billing/", "@acme/payments"]);
    expect(ownersFor(r, "src/billing/plan.py")).toEqual(["@acme/payments"]);
    expect(ownersFor(r, "src/other/thing.py")).toEqual(["@everyone"]);
  });

  // A pattern with nobody after it takes the path back off whoever owned it.
  it("an empty owner list un-owns a path", () => {
    const r = rules(["*", "@everyone"], ["/vendor/"]);
    expect(ownersFor(r, "vendor/lib.js")).toEqual([]);
    expect(ownersFor(r, "src/app.ts")).toEqual(["@everyone"]);
  });

  it("a leading slash anchors to the root", () => {
    const r = rules(["/docs/", "@writers"]);
    expect(ownersFor(r, "docs/readme.md")).toEqual(["@writers"]);
    expect(ownersFor(r, "src/docs/readme.md")).toEqual([]);
  });

  it("a bare name matches at any depth, the way gitignore does", () => {
    const r = rules(["CHANGELOG.md", "@writers"]);
    expect(ownersFor(r, "CHANGELOG.md")).toEqual(["@writers"]);
    expect(ownersFor(r, "packages/web/CHANGELOG.md")).toEqual(["@writers"]);
  });

  it("`*` stops at a slash and `**` does not", () => {
    const star = rules(["/src/*.ts", "@a"]);
    expect(ownersFor(star, "src/app.ts")).toEqual(["@a"]);
    expect(ownersFor(star, "src/deep/app.ts")).toEqual([]);
    const deep = rules(["/src/**/*.ts", "@b"]);
    expect(ownersFor(deep, "src/deep/app.ts")).toEqual(["@b"]);
    // `**/` swallows its own slash, so it matches at the level it starts from too.
    expect(ownersFor(deep, "src/app.ts")).toEqual(["@b"]);
  });

  it("a directory owns everything under it", () => {
    const r = rules(["/server/", "@backend"]);
    expect(ownersFor(r, "server/src/deep/thing.ts")).toEqual(["@backend"]);
  });

  it("an extension pattern owns that extension anywhere", () => {
    const r = rules(["*.sql", "@dba"]);
    expect(ownersFor(r, "db/migrations/0001.sql")).toEqual(["@dba"]);
    expect(ownersFor(r, "db/migrations/0001.py")).toEqual([]);
  });

  it("several owners on one line are all of them", () => {
    const r = rules(["*", "@a", "@acme/team", "dev@example.com"]);
    expect(ownersFor(r, "x.ts")).toEqual(["@a", "@acme/team", "dev@example.com"]);
  });

  it("a pattern with regex characters in it is a path, not a pattern", () => {
    const r = rules(["/a+b/c.ts", "@a"]);
    expect(ownersFor(r, "a+b/c.ts")).toEqual(["@a"]);
    expect(ownersFor(r, "aXb/cYts")).toEqual([]);
  });

  it("nobody owns a path no rule matches", () => {
    expect(ownersFor(rules(["/docs/", "@w"]), "src/app.ts")).toEqual([]);
    expect(ownersFor([], "src/app.ts")).toEqual([]);
  });
});

describe("ownersOf", () => {
  it("counts what each owner owns, most first", () => {
    const r = rules(["*", "@all"], ["/src/billing/", "@acme/payments"], ["/lint.json", "@tools"]);
    const out = ownersOf(r, ["src/billing/a.py", "src/billing/b.py", "lint.json", "README.md"]);
    expect(out.map((o) => [o.owner, o.paths.length])).toEqual([
      ["@acme/payments", 2],
      ["@all", 1],
      ["@tools", 1],
    ]);
  });

  it("is empty when the repository has no CODEOWNERS to speak of", () => {
    expect(ownersOf([], ["a.ts"])).toEqual([]);
  });
});

describe("loginOf", () => {
  it("gives the login a picker can match", () => {
    expect(loginOf("@octocat")).toBe("octocat");
  });

  // A team is carried through as written: expanding it means asking GitHub who is in
  // it, and eleven names is not what "the backend team owns this" should look like.
  it("and refuses to turn a team or an email into one", () => {
    expect(loginOf("@acme/backend")).toBeNull();
    expect(loginOf("dev@example.com")).toBeNull();
  });
});
