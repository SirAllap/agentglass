/*
 * Every script this app injects into a page has to be valid JavaScript.
 *
 * That reads like it could not possibly need saying. It did: `COLLECTOR` — the
 * script that makes `console`, `network` and `observe` able to report anything
 * at all — shipped with `const w` declared twice in one scope, from the commit
 * that introduced the feature. The whole string was a SyntaxError, so the
 * injection threw, `.catch(() => 0)` swallowed the throw, and every `console`
 * and `network` call came back `{ rows: [], listening: 0 }`.
 *
 * That answer is the one shape those verbs must never produce by accident.
 * `listening` exists because an empty `rows` has to mean "the page said
 * nothing" and nothing else; "nobody was collecting" is a different fact
 * wearing the same clothes, and it was the fact being reported, always.
 *
 * Measured against the real app before the fix: `window.__agxLog` did not
 * exist after a `console` call, and `listening` was 0 for a page that had just
 * logged two errors. After it: `listening` is a timestamp and the known marker
 * comes back. The detail worth keeping is what the collector caught FIRST once
 * it was injected by hand — the SyntaxError that had been keeping it out:
 *
 *     error | Uncaught SyntaxError: Identifier 'w' has already been declared
 *
 * No unit test reached this, because the verb is exercised against a fake guest
 * that accepts any string and runs none of it: ninety tests stayed green over a
 * collector that could not parse. So this asserts the one thing the fake guest
 * can never tell us — that the string is a program.
 *
 * `new Function` rather than `eval`: it parses without running, which is the
 * whole point. These scripts touch `window`, wrap `console` and patch
 * `XMLHttpRequest`; running one here would rewrite the test process.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The injected scripts, read from source rather than imported.
 *
 * Importing `browserDrive.ts` reaches `api.ts`, which reads `location` at
 * module scope — the reason this repo cannot import components in tests. And
 * the constants there are module-private anyway. Reading the text keeps this
 * test honest about what is in the file, which is exactly what was wrong.
 */
function templatesIn(file: string): Array<{ name: string; body: string }> {
  const src = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8");
  const out: Array<{ name: string; body: string }> = [];
  // `const NAME = ` followed by a template literal that opens with an IIFE.
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*`(\(\(\)\s*=>\s*\{[\s\S]*?)`;/g;
  for (const m of src.matchAll(re)) {
    // A template that interpolates is not a program until it is built, so its
    // raw text cannot be parsed and asserting on it would fail for a healthy
    // script. REMOVE_HIGHLIGHT_SCRIPT is one: it carries ${jsLit(...)}. The
    // ones this test is for are the ones that are already whole — COLLECTOR
    // says so about itself, in the comment explaining why it holds no
    // backticks either.
    if (m[2]!.includes("${")) continue;
    out.push({ name: m[1]!, body: m[2]! });
  }
  return out;
}

const SCRIPTS = [...templatesIn("browserObserve.ts"), ...templatesIn("browserDrive.ts")];

describe("the scripts this app runs inside other people's pages", () => {
  test("there are some, and this test found them", () => {
    // Guards the regex above: a rename that stops it matching would otherwise
    // turn this whole file into four silent passes.
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(3);
    expect(SCRIPTS.map((s) => s.name)).toContain("COLLECTOR");
  });

  for (const { name, body } of SCRIPTS) {
    test(`${name} parses as JavaScript`, () => {
      // Parses, does not run. A throw here is the SyntaxError the app would
      // have swallowed at the injection site.
      expect(() => new Function(body)).not.toThrow();
    });
  }

  test("COLLECTOR declares each of its bindings once", () => {
    const { body } = SCRIPTS.find((s) => s.name === "COLLECTOR")!;
    // The specific shape that broke it, kept as its own assertion because the
    // parse check above says only "something is wrong" — this says what.
    const bare = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const dupes = [...bare.matchAll(/\bconst\s+(\w+)\s*=\s*this\.__agx\b/g)].map((m) => m[1]);
    expect(dupes.length, "one `const w = this.__agx`, not two").toBe(1);
  });
});
