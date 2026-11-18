/*
 * A window made, renamed or killed is written to the saved layout when it
 * happens, not at the next sweep: the call sites ask `noteLayoutChanged`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { noteLayoutChanged, setCaptureHook } from "../src/tmuxpane.ts";

const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

describe("layout is noted when a window changes", () => {
  test("noteLayoutChanged reaches the capture hook and never throws", () => {
    let n = 0;
    setCaptureHook(() => { n++; });
    noteLayoutChanged();
    expect(n).toBe(1);
    setCaptureHook(() => { throw new Error("boom"); });
    expect(() => noteLayoutChanged()).not.toThrow();
  });

  test("index, agentops and terminal call it where windows are made or closed", () => {
    expect(src("index.ts")).toMatch(/"kill-window", "kill-pane", "rename"\][^\n]*noteLayoutChanged\(\)/);
    expect(src("agentops.ts").match(/noteLayoutChanged\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src("terminal.ts").match(/noteLayoutChanged\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
