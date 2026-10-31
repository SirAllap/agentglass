/*
 * Every `data-tip` in the window is drawn by ONE host, mounted at the app root.
 * It used to be mounted by three views (Starboard, Pull requests, Jira list),
 * so the rail's tips drew nothing on any other view, and two views mounted at
 * once would have drawn two cards. A rule about source is asserted against
 * source: there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";

const root = new URL("../src/", import.meta.url).pathname;
const mounts: string[] = [];
for (const f of new Glob("**/*.tsx").scanSync(root)) {
  const src = readFileSync(root + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const _ of src.matchAll(/<TipHost\s*\/>/g)) mounts.push(f);
}

describe("one tooltip host", () => {
  test("exactly one <TipHost /> in web/src", () => {
    expect(mounts.length).toBe(1);
  });
  test("and it is the app root's", () => {
    expect(mounts[0]).toBe("App.tsx");
  });
});
