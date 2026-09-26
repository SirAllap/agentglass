// /git/branches is cached against a fingerprint of the branch TIPS. A checkout
// moves HEAD and no tip, so a client that switched branch and asked again was
// told the old branch was still checked out. HEAD belongs in the cache key; a
// rule about source is asserted against source.
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

test("the /git/branches cache key carries HEAD", () => {
  const start = src.indexOf('if (pathname === "/git/branches") {');
  expect(start).toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf("gitBranches(root)", start));
  expect(block).toContain("headOf(root)");
  expect(block).toMatch(/const key = `branches:\$\{root\}:\$\{headOf\(root\)\}`/);
});

test("headOf reads the file, not a subprocess", () => {
  const i = src.indexOf("function headOf(");
  expect(i).toBeGreaterThan(0);
  const fn = src.slice(i, src.indexOf("\n}", i));
  expect(fn).toContain('"HEAD"');
  expect(fn).not.toMatch(/gitAsync|spawn|Bun\.\$/);
});
