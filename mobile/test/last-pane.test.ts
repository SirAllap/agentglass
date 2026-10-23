/*
 * Each computer remembers the window it was last on, so switching away and
 * back lands where you were instead of on whichever window the "best session"
 * rule picks. In memory only: pane ids are a tmux server's and do not outlive it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetPanes, lastPane, rememberPane } from "../src/state/last-pane.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

beforeEach(() => __resetPanes());

describe("the window each computer was last on", () => {
  test("is kept per computer, and %5 on one is not %5 on the other", () => {
    rememberPane("a", "%5");
    rememberPane("b", "%9");
    expect(lastPane("a")).toBe("%5");
    expect(lastPane("b")).toBe("%9");
  });
  test("a computer never visited has none", () => {
    expect(lastPane("a")).toBeNull();
    expect(lastPane(undefined)).toBeNull();
  });
  test("remembering nothing does not erase what was kept", () => {
    // Broken on purpose: the terminal's `active` is null for a frame while a
    // strip loads, and writing that down forgets the window just left.
    rememberPane("a", "%5");
    rememberPane("a", null);
    expect(lastPane("a")).toBe("%5");
  });
});

describe("the terminal", () => {
  const src = readFileSync(join(import.meta.dir, "../app/(tabs)/terminal.tsx"), "utf8");
  test("writes the window down when it changes and reads it back when the strip loads", () => {
    expect(src).toContain("rememberPane(host?.id, active)");
    expect(src).toMatch(/lastPane\(host\?\.id\)/);
  });
});
