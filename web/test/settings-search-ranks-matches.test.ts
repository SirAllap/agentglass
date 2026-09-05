/*
 * More than one page can answer a query. Before this, the app took whichever
 * was declared first — which is how typing "scrollback" could hand you Pane
 * engine (a paragraph about restoring a layout happens to use the word)
 * ahead of Terminal (which owns the Scrollback row). `tabScore` ranks a page
 * title above a page's `kw` bag, and an exact word above a word merely
 * prefixed above the query buried mid-word, so the better match wins.
 *
 * `tabScore` is pulled out of the source and evaluated on its own — the same
 * function the modal runs, not a reimplementation of it — because importing
 * SettingsModal.tsx here would drag in everything else it imports.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

function loadTabScore(): (t: { label: string; kw: string }, ql: string) => number {
  const from = src.indexOf("function tabScore(");
  expect(from).toBeGreaterThan(-1);
  const tsBody = src.slice(from, src.indexOf("\n}", from) + 2);
  // Strips the TS types `new Function` can't parse — this runs the same logic
  // the modal does, just transpiled the way Bun already transpiles the file.
  const jsBody = new Bun.Transpiler({ loader: "ts" }).transformSync(tsBody);
  return new Function(`${jsBody}\nreturn tabScore;`)();
}

function loadTabs(): { id: string; label: string; kw: string }[] {
  const out: { id: string; label: string; kw: string }[] = [];
  const re = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*", kw: "([^"]*)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ id: m[1]!, label: m[2]!, kw: m[3]! });
  return out;
}

describe("tabScore ranks a query match instead of taking the first one declared", () => {
  const tabScore = loadTabScore();

  test("an empty query scores everything the same, at zero", () => {
    expect(tabScore({ label: "Terminal", kw: "scrollback" }, "")).toBe(0);
  });

  test("title beats kw, exact beats prefix beats substring, within each tier", () => {
    const exactTitle = tabScore({ label: "Terminal", kw: "" }, "terminal");
    const prefixTitle = tabScore({ label: "Terminal", kw: "" }, "term");
    const subTitle = tabScore({ label: "Terminal", kw: "" }, "rmin");
    const exactKw = tabScore({ label: "Nothing", kw: "scrollback size" }, "scrollback");
    const prefixKw = tabScore({ label: "Nothing", kw: "scrollback size" }, "scroll");
    const subKw = tabScore({ label: "Nothing", kw: "scrollback size" }, "rollb");

    expect(exactTitle).toBeGreaterThan(prefixTitle);
    expect(prefixTitle).toBeGreaterThan(subTitle);
    expect(subTitle).toBeGreaterThan(exactKw);
    expect(exactKw).toBeGreaterThan(prefixKw);
    expect(prefixKw).toBeGreaterThan(subKw);
  });

  test("no match anywhere scores zero", () => {
    expect(tabScore({ label: "Terminal", kw: "scrollback" }, "budgets")).toBe(0);
  });

  test("regression: \"scrollback\" ties Terminal and Pane engine on kw, and declaration order — Terminal first — settles it", () => {
    const tabs = loadTabs();
    const terminalIdx = tabs.findIndex((t) => t.id === "terminal");
    const tmuxIdx = tabs.findIndex((t) => t.id === "tmux");
    const terminal = tabs[terminalIdx]!;
    const tmux = tabs[tmuxIdx]!;
    expect(tabScore(terminal, "scrollback")).toBe(tabScore(tmux, "scrollback"));
    expect(terminalIdx).toBeLessThan(tmuxIdx);
  });
});
