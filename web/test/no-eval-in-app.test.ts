/* The desktop window's CSP is `script-src 'self'` plus two hashes, with no
   'unsafe-eval'. A `new Function(...)` or `eval(...)` that runs while the
   bundle loads throws an EvalError before React mounts, and the window shows
   "The interface did not load" on every start: a smoke run in plain Chrome
   does not catch it, because the dev server sends no CSP. Code that builds a
   function from a string belongs in a test, which has no CSP; the page-side
   scripts in web/src stay strings sent to the guest page. */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files: Array<{ path: string; text: string }> = [];
for await (const rel of new Glob("**/*.{ts,tsx}").scan(SRC)) {
  files.push({ path: rel, text: await Bun.file(join(SRC, rel)).text() });
}

/* Comment lines go first: a comment may name the thing it forbids. */
const code = (text: string) =>
  text.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("no eval in the app bundle", () => {
  test("found the source", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  test("no module in web/src calls new Function or eval", () => {
    const hits = files
      .filter((f) => /\bnew Function\s*\(|(^|[^.\w])eval\s*\(/m.test(code(f.text)))
      .map((f) => f.path);
    expect(hits).toEqual([]);
  });
});
