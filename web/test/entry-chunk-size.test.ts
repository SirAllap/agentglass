// First-paint cost: the entry chunk must not creep back up.
//
// Two guards. The source guard always runs: the shiki regex engine
// (oniguruma-to-es, ~50 KB) is only needed by the first highlight, so
// lib/highlight.ts must load it with import(), never statically.
// The size guard runs only when `make build` has left web/dist behind (the
// unit run does not build): the entry chunk, measured at 4,064,512 bytes after
// this change, may grow by at most 10%.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ENTRY_BYTES = 4_064_512;

test("highlight.ts loads the shiki regex engine lazily", () => {
  const src = readFileSync(join(import.meta.dir, "../src/lib/highlight.ts"), "utf8");
  expect(src).not.toMatch(/^import [^;]*from "shiki\/engine\/javascript"/m);
  expect(src).toMatch(/import\("shiki\/engine\/javascript"\)/);
});

const assets = join(import.meta.dir, "../dist/assets");
const entry = existsSync(assets) ? readdirSync(assets).find((f) => /^index-.*\.js$/.test(f)) : undefined;

test.skipIf(!entry)("entry chunk stays within 10% of its measured size", () => {
  expect(statSync(join(assets, entry!)).size).toBeLessThanOrEqual(Math.round(ENTRY_BYTES * 1.1));
});
