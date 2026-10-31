/*
 * esbuild's minifier turned xterm 6.0.0's requestMode into `...(void 0||(s={}))` with no `let s`, so
 * the bench terminal threw "s is not defined" the first time a program asked for a terminal mode
 * (Claude Code does, on start). Seen in the built app after Go; main builds the same. The build rewrites
 * the one pattern before minifying; this holds the rewrite to the library's real text.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { xtermRequestModeFix } from "../xtermRequestModeFix.ts";

const lib = readFileSync(new URL("../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url), "utf8");
const id = "/x/node_modules/@xterm/xterm/lib/xterm.mjs";

test("the pattern the fix targets is still in the installed xterm", () => {
  expect(lib).toContain("let r;(P=>(P[P.NOT_RECOGNIZED");
});
test("the fix removes the logical assignment on the undeclared-after-minify name", () => {
  const out = xtermRequestModeFix.transform(lib, id) as string;
  expect(out).toContain("let r={};(P=>(P[P.NOT_RECOGNIZED");
  expect(out).not.toContain("(r||={})");
});
test("other files are left alone", () => {
  expect(xtermRequestModeFix.transform(lib, "/x/other.mjs")).toBeNull();
});
