/*
 * A path typed in the Machine tab's search box drives the finder, the way the
 * finder's own path bar does; words keep the search they always did.
 */
import { describe, expect, test } from "bun:test";
import { finderTarget } from "../src/lib/finderQuery.ts";

const palette = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();

describe("finderTarget", () => {
  test("a home path, an absolute path and a relative one resolve to one place", () => {
    expect(finderTarget("~/code/orbit/package.json", "/home/ann", "/home/ann")).toBe("/home/ann/code/orbit/package.json");
    expect(finderTarget("/etc/hosts", "/home/ann", "/home/ann")).toBe("/etc/hosts");
    expect(finderTarget("../orbit/", "/home/ann", "/home/ann/code/acme")).toBe("/home/ann/code/orbit");
    expect(finderTarget("~", "/home/ann", "/")).toBe("/home/ann");
  });
  test("words are not a path", () => {
    expect(finderTarget("package.json", "/home/ann", "/home/ann")).toBeNull();
    expect(finderTarget("", "/home/ann", "/home/ann")).toBeNull();
    expect(finderTarget("orbit/readme", "/home/ann", "/home/ann")).toBeNull();
  });
});

describe("the palette hands a typed path to the finder", () => {
  test("finderOn accepts an empty box or a path, and nothing else", () => {
    const line = palette.split("\n").find((l) => l.includes("const finderOn ="))!;
    expect(line).toContain("looksLikePath(q)");
    expect(line).toContain("!q.trim()");
    expect(palette).toMatch(/<MachineFinder[^>]*target=\{/);
  });
});
