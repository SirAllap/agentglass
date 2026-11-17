import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errorActions, splitPath, treeBeside, BP_TREE, filesViewedProgress } from "../src/lib/prFilesLayout.ts";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

describe("prFilesLayout", () => {
  test("splitPath", () => {
    expect(splitPath("src/orbit/a.ts")).toEqual({ name: "a.ts", dir: "src/orbit" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
  test("tree beside from BP_TREE", () => {
    expect([439, 479, 480, 1280].map(treeBeside)).toEqual([false, false, true, true]);
  });
  test("filesViewedProgress", () => {
    expect(filesViewedProgress(0, 0)).toEqual({ pct: 0, done: false });
    expect(filesViewedProgress(1, 4)).toEqual({ pct: 25, done: false });
    expect(filesViewedProgress(9, 4)).toEqual({ pct: 100, done: true });
  });
  test("errorActions", () => {
    expect(errorActions({ hasUrl: false, hasLocal: false })).toEqual(["retry"]);
    expect(errorActions({ hasUrl: true, hasLocal: true })).toEqual(["retry", "github", "local"]);
  });
  test("css literal for the tree breakpoint matches BP_TREE", () => {
    expect(css).toContain(`@container prf (min-width: ${BP_TREE}px)`);
  });
});

import { SPLIT_MIN_PX, splitFits } from "../src/lib/prFilesLayout.ts";
describe("splitFits", () => {
  test("two columns of code need SPLIT_MIN_PX; narrower falls back to Unified", () => {
    expect(splitFits(SPLIT_MIN_PX)).toBe(true);
    expect(splitFits(SPLIT_MIN_PX - 1)).toBe(false);
    expect(splitFits(580)).toBe(false);
  });
  test("a box not measured yet is not judged", () => {
    expect(splitFits(0)).toBe(true);
  });
});
