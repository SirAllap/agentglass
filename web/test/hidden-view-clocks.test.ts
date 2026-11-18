/*
 * A clock deep inside a view stops while that view is behind another one.
 *
 * Visited views stay mounted under `visibility: hidden`. Neither
 * `document.hidden` nor an IntersectionObserver sees that, so a card's minute
 * tick, a plugin canvas's loops and 1 Hz countdown, the browser overview's 5 s
 * clock and a plugin run's 1 s timer kept running in views nobody looked at.
 * The view box now provides `ViewActive`; these pins keep it wired.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ViewActive, useViewActive } from "../src/lib/viewActive.ts";

const SRC = join(import.meta.dir, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

function Probe() { return createElement("i", null, String(useViewActive())); }

describe("ViewActive", () => {
  test("true outside any view, so a modal's clock runs as before", () => {
    expect(renderToString(createElement(Probe))).toContain(">true<");
  });

  test("false inside a hidden view, true inside the one on screen", () => {
    expect(renderToString(createElement(ViewActive.Provider, { value: false }, createElement(Probe)))).toContain(">false<");
    expect(renderToString(createElement(ViewActive.Provider, { value: true }, createElement(Probe)))).toContain(">true<");
  });

  test("the view box and the board host both provide it", () => {
    const ws = read("components/workspace/Workspace.tsx");
    expect(ws).toContain("<ViewActive.Provider value={active}>{children}</ViewActive.Provider>");
    expect(ws).toMatch(/<ViewActive\.Provider value=\{active\}>\s*<BoardBody kind=\{kind\} active=\{active\}/);
  });
});

describe("the clocks that ran behind another view", () => {
  test("each one reads the view's word", () => {
    expect(read("components/jira/detail/useCardLifecycle.ts")).toContain("useMinuteNow(useViewActive())");
    expect(read("components/plugins/PluginCanvas.tsx")).toContain("return hidden || !onScreen || !viewOn;");
    expect(read("components/browser/BrowserIsland.tsx")).toContain("useNow(open && viewOn, 5000)");
    expect(read("components/plugins/PluginPrActions.tsx")).toContain('state === "running" && viewOn)');
  });

  test("no component clock is always on: a view can hide every one of them", () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, "components"))) {
      const n = readFileSync(f, "utf8").split("\n").filter((l) => /\buse(Now|VisibleInterval)\(\s*true\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)).length;
      if (n) bad.push(`${relative(SRC, f)}: ${n}`);
    }
    expect(bad).toEqual([]);
  });
});
