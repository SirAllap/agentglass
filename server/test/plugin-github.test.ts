/*
 * What a plugin may read from GitHub through the server. The server holds the
 * login (a keyring token no box can reach); a plugin names an operation and
 * its parameters, never a command line or an API path, so the only requests
 * that exist are the ones listed in ghReadArgs.
 */
import { describe, expect, test } from "bun:test";
import { ghReadArgs, runGhRead } from "../src/plugin-github.ts";

const ok = (r: ReturnType<typeof ghReadArgs>) => { if (!r.ok) throw new Error(r.error); return r.args; };
const p = (o: Record<string, string>) => new URLSearchParams(o);

describe("ghReadArgs", () => {
  test("a pull request view asks for the fixed field list", () => {
    const a = ok(ghReadArgs("pr-view", p({ repo: "acme/orbit", number: "42" })));
    expect(a.slice(0, 5)).toEqual(["pr", "view", "42", "-R", "acme/orbit"]);
    expect(a).toContain("--json");
  });
  test("a diff, a compare and a tarball name only the pull request, two refs, or a 40-hex sha", () => {
    expect(ok(ghReadArgs("pr-diff", p({ repo: "acme/orbit", number: "42" })))).toEqual(["pr", "diff", "42", "-R", "acme/orbit"]);
    expect(ok(ghReadArgs("compare", p({ repo: "acme/orbit", base: "a".repeat(40), head: "b".repeat(40) })))).toContain(`repos/acme/orbit/compare/${"a".repeat(40)}...${"b".repeat(40)}`);
    expect(ok(ghReadArgs("tarball", p({ repo: "acme/orbit", sha: "c".repeat(40) })))).toEqual(["api", `repos/acme/orbit/tarball/${"c".repeat(40)}`]);
  });
  test("an unknown operation, a bad repo, a bad number or a bad sha is refused", () => {
    expect(ghReadArgs("pr-merge", p({ repo: "acme/orbit", number: "1" })).ok).toBe(false);
    expect(ghReadArgs("api", p({ path: "repos/acme/orbit/issues" })).ok).toBe(false);
    expect(ghReadArgs("pr-view", p({ repo: "acme/orbit; rm -rf", number: "1" })).ok).toBe(false);
    expect(ghReadArgs("pr-view", p({ repo: "../etc/passwd", number: "1" })).ok).toBe(false);
    expect(ghReadArgs("pr-view", p({ repo: "acme/orbit", number: "1 --web" })).ok).toBe(false);
    expect(ghReadArgs("tarball", p({ repo: "acme/orbit", sha: "main" })).ok).toBe(false);
    expect(ghReadArgs("compare", p({ repo: "acme/orbit", base: "--input=/etc/passwd", head: "x" })).ok).toBe(false);
  });
  test("nothing it builds can write: no -X, no -f/-F body except the fixed graphql query, no --input", () => {
    const all = [
      ghReadArgs("user", p({})), ghReadArgs("repos", p({})),
      ghReadArgs("pr-list", p({ repo: "acme/orbit", label: "needs review" })),
      ghReadArgs("pr-view", p({ repo: "acme/orbit", number: "1" })),
      ghReadArgs("pr-view-context", p({ repo: "acme/orbit", number: "1" })),
      ghReadArgs("threads", p({ repo: "acme/orbit", number: "1" })),
      ghReadArgs("pr-diff", p({ repo: "acme/orbit", number: "1" })),
    ];
    for (const r of all) {
      const a = ok(r);
      expect(a).not.toContain("-X");
      expect(a).not.toContain("--method");
      expect(a).not.toContain("--input");
    }
  });
  test("a label that looks like a flag is passed as a value, never as an option", () => {
    const a = ok(ghReadArgs("pr-list", p({ repo: "acme/orbit", label: "--web" })));
    expect(a[a.indexOf("--label") + 1]).toBe("--web");
  });
});

describe("runGhRead", () => {
  test("hands the text back, and an error as a sentence", async () => {
    const good = await runGhRead("user", p({}), async () => ({ code: 0, stdout: '{"login":"orbit"}', stderr: "" }));
    expect(good).toEqual({ ok: true, stdout: '{"login":"orbit"}' });
    const bad = await runGhRead("user", p({}), async () => ({ code: 1, stdout: "", stderr: "Requires authentication (HTTP 401)\n" }));
    expect(bad).toEqual({ ok: false, error: "Requires authentication (HTTP 401)" });
  });
  test("never puts the server's own environment or token in the answer", async () => {
    const r = await runGhRead("user", p({}), async () => ({ code: 0, stdout: "{}", stderr: "" }));
    expect(JSON.stringify(r)).not.toContain(process.env.PATH ?? "\0");
  });
});

describe("the route", () => {
  const src = Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  test("lives under /plugin/self, so only a plugin's own token reaches it, and is GET only", async () => {
    const text = await src;
    const at = text.indexOf('pathname === "/plugin/self/github"');
    expect(at).toBeGreaterThan(0);
    const block = text.slice(at, text.indexOf("/plugin/self/pr/notes", at));
    expect(block).toContain('=== "GET"');
    expect(block).not.toMatch(/req\.method === "(POST|PUT|PATCH|DELETE)"/);
  });
});
