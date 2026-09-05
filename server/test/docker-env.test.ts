/*
 * Comparing two containers' environments.
 *
 * One property matters more than everything else in this file: a credential
 * must never reach the client. A diff view is precisely the surface that ends
 * up in a screenshot in a chat, and an environment is the densest pile of
 * secrets on a developer's machine.
 *
 * The second property is that masking must not cost the answer: a rotated token
 * still has to show up as "changed", because "the token differs" is very often
 * the whole reason one container works and the other does not.
 */
import { describe, expect, test } from "bun:test";
import { diffSummary, envDiff, envMap, isSecret } from "../src/dockerenv.ts";

describe("reading KEY=value", () => {
  test("a value containing = is normal and only the first one splits", () => {
    const m = envMap(["DATABASE_URL=postgres://u:p@host/db?x=1", "DEBUG=1"]);
    expect(m.get("DATABASE_URL")).toBe("postgres://u:p@host/db?x=1");
    expect(m.get("DEBUG")).toBe("1");
  });

  test("an empty value stays empty rather than disappearing", () => {
    expect(envMap(["EMPTY="]).get("EMPTY")).toBe("");
  });
});

describe("what counts as a credential", () => {
  test("the obvious ones, in the shapes people write them", () => {
    for (const n of ["AWS_SECRET_KEY", "GITHUB_NPM_TOKEN", "DB_PASSWORD", "API_KEY", "SESSION_SECRET", "SIGNING_SALT", "SENTRY_DSN", "PRIVATE_KEY"]) {
      expect(isSecret(n)).toBe(true);
    }
  });

  test("and plain words that are obviously one", () => {
    expect(isSecret("password")).toBe(true);
    expect(isSecret("token")).toBe(true);
  });

  /* Broad on purpose: a false positive costs one masked row in a diff nobody
     needed. A false negative puts somebody's production token in a screenshot. */
  test("ordinary settings are not masked", () => {
    for (const n of ["DEBUG", "APP_BASE_URL", "DJANGO_SETTINGS_MODULE", "KEYPAD_FEATURE", "MONKEY"]) {
      expect(isSecret(n)).toBe(false);
    }
  });
});

describe("the diff", () => {
  const a = ["DEBUG=1", "APP_BASE_URL=http://a.test", "ONLY_A=yes", "AWS_SECRET_KEY=aaaa"];
  const b = ["DEBUG=1", "APP_BASE_URL=http://b.test", "ONLY_B=yes", "AWS_SECRET_KEY=bbbb"];

  test("what only one side has, what changed, and what did not", () => {
    const rows = envDiff(a, b);
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by["ONLY_A"]!.change).toBe("only-a");
    expect(by["ONLY_B"]!.change).toBe("only-b");
    expect(by["APP_BASE_URL"]!.change).toBe("changed");
    expect(by["DEBUG"]!.change).toBe("same");
  });

  test("ordinary values travel", () => {
    const row = envDiff(a, b).find((r) => r.name === "APP_BASE_URL")!;
    expect(row.a).toBe("http://a.test");
    expect(row.b).toBe("http://b.test");
    expect(row.masked).toBe(false);
  });

  /* The property this file exists for. */
  test("a credential's value never leaves, on either side", () => {
    const row = envDiff(a, b).find((r) => r.name === "AWS_SECRET_KEY")!;
    expect(row.masked).toBe(true);
    expect(row.a).toBeUndefined();
    expect(row.b).toBeUndefined();
    expect(JSON.stringify(envDiff(a, b))).not.toContain("aaaa");
    expect(JSON.stringify(envDiff(a, b))).not.toContain("bbbb");
  });

  /* …and masking must not cost the answer: "the token differs" is very often
     the whole reason one container works and the other does not. */
  test("but a rotated credential still reads as changed", () => {
    expect(envDiff(a, b).find((r) => r.name === "AWS_SECRET_KEY")!.change).toBe("changed");
    expect(envDiff(["T=x"], ["T=x"]).find((r) => r.name === "T")!.change).toBe("same");
  });

  test("the interesting rows come first", () => {
    // The answer is nearly always in the first three rows and never in the
    // eightieth, so "same" sinks to the bottom.
    expect(envDiff(a, b).map((r) => r.change)).toEqual(["only-b", "only-a", "changed", "changed", "same"]);
  });

  test("the summary the view leads with", () => {
    expect(diffSummary(envDiff(a, b))).toEqual({ differ: 4, total: 5 });
  });

  test("two identical environments say so", () => {
    expect(diffSummary(envDiff(a, a))).toEqual({ differ: 0, total: 4 });
  });
});
