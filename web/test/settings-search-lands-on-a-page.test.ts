/*
 * settings-search-reaches-every-row.test.ts checks that a row's words are
 * somewhere in its page's `kw` bag — an input to the search, not the search.
 * It stayed green the whole time typing "keyboard shortcuts", "dark mode",
 * "tmux prefix", "sidebar order", "diff view", "task sources" or "github
 * token" answered "No settings match": each word of those phrases WAS in
 * some page's `kw`, but the old scorer tested the whole typed string as one
 * substring against `kw`, and "keyboard shortcuts" is never a substring of
 * a `kw` bag that has "keyboard" and "shortcut" as separate words. Comparing
 * two lists never runs that scorer, so it never saw the phrase fail.
 *
 * This drives `tabScore` itself, the same function the modal calls to
 * choose a page, pulled out of the source the way settings-search-ranks-
 * matches.test.ts already does — not reimplemented, so a change to the
 * scorer's behaviour shows up here without anyone updating a second copy.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

function loadTabScore(): (t: { label: string; kw: string }, ql: string) => number {
  const from = src.indexOf("function tabScore(");
  expect(from).toBeGreaterThan(-1);
  const tsBody = src.slice(from, src.indexOf("\n}", from) + 2);
  const jsBody = new Bun.Transpiler({ loader: "ts" }).transformSync(tsBody);
  return new Function(`${jsBody}\nreturn tabScore;`)();
}

function loadTabs(): { id: string; label: string; kw: string }[] {
  const out: { id: string; label: string; kw: string }[] = [];
  const re = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*", kw: "([^"]*)"/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ id: m[1]!, label: m[2]!, kw: m[3]! });
  return out;
}

/** The page a query must land on when typed into the search box, given
 *  every page's real `tabScore` — the same "highest score wins" the modal
 *  uses to jump the nav (search for `const best = scored.find` above). */
function reaches(tabs: { id: string; label: string; kw: string }[], tabScore: (t: { label: string; kw: string }, ql: string) => number, q: string): string | null {
  const scored = tabs.map((t) => ({ id: t.id, s: tabScore(t, q) }));
  const top = Math.max(...scored.map((x) => x.s));
  if (top === 0) return null;
  return scored.find((x) => x.s === top)!.id;
}

describe("a realistic query lands on the page it names", () => {
  const tabScore = loadTabScore();
  const tabs = loadTabs();

  // The seven phrases measured to fail before the AND-across-words fix,
  // plus enough of the rest of the findability sweep to keep every ring
  // covered, and the two pages the settings rename touched most recently.
  const cases: [string, string][] = [
    ["keyboard shortcuts", "keys"],
    ["dark mode", "appearance"],
    ["tmux prefix", "tmux"],
    ["sidebar order", "rail"],
    ["diff view", "diff"],
    ["task sources", "tasks"],
    ["github token", "connections"],
    ["budget limit", "budgets"],
    ["review prompts", "review-prompts"],
    ["saved replies", "saved-replies"],
    ["export data", "export"],
    ["privacy telemetry", "privacy"],
    ["monospace font", "terminal"],
    ["notification sound", "notifications"],
    ["install plugin", "plugins"],
    ["remote pair phone", "remote"],
    ["window fullscreen", "prefs"],
    ["activity log", "log"],
    ["onboarding checklist", "onboarding"],
    ["hooks setup", "hooks"],
  ];

  for (const [q, pane] of cases) {
    test(`"${q}" reaches ${pane}`, () => {
      expect(reaches(tabs, tabScore, q)).toBe(pane);
    });
  }
});

describe("the two properties that broke this week and had no test", () => {
  const tabScore = loadTabScore();

  test("a multi-word query needs each word matched, not the phrase as one substring", () => {
    // "keyboard" and "shortcuts" both sit in keys' kw, apart — "keyboard
    // shortcuts" is not a substring of it. If tabScore goes back to
    // testing the whole query as one string against kw, this drops to 0.
    const keys = { label: "Shortcuts", kw: "keyboard keys bindings shortcut chord rebind reset to defaults columns some others" };
    expect(tabScore(keys, "keyboard shortcuts")).toBeGreaterThan(0);
    // And it must stay an AND: one real word plus one word from nowhere
    // must not still win on the strength of the word that did match.
    expect(tabScore(keys, "keyboard zzzznotaword")).toBe(0);
  });

  test("a query that matches no page scores zero everywhere, so the box can say so", () => {
    const tabs = loadTabs();
    const scored = tabs.map((t) => tabScore(t, "zzzznotasetting"));
    expect(Math.max(...scored)).toBe(0);
  });
});
