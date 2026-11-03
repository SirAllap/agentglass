/*
 * settings-search-reaches-every-row.test.ts checks that a row's words are
 * indexed at all; this drives the actual ranking a query gets, the same way
 * it always has, now through `pageScore` (settingsIndex.ts) instead of the
 * `tabScore` this file used to pull out of SettingsModal.tsx's source with a
 * transpile-and-eval — `pageScore` is an ordinary exported function, so
 * there is nothing left to extract.
 *
 * `pageScore` additionally scores every ROW on a page, not just its title and
 * `kw` bag, so a query naming a row now reaches its page even when the page's
 * OWN `kw` bag does not happen to carry that exact word — which is what
 * "notification sound" answering `prefs` (Window) used to depend on, back
 * when `kw` was the only index there was and Window's `kw` still listed
 * "sound" for a row Notifications now owns. That entry is gone from `kw`
 * (see settings-search-sound.test.ts); the row itself is what carries it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pageScore, type SettingsPage } from "../src/lib/settingsIndex.ts";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");

function loadTabs(): SettingsPage[] {
  const re = /\{ id: "([a-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*", kw: "([^"]*)"/g;
  const out: SettingsPage[] = [];
  for (const m of src.matchAll(re)) out.push({ id: m[1]!, label: m[2]!, kw: m[3]! });
  return out;
}

function reaches(tabs: SettingsPage[], q: string): string | null {
  const scored = tabs.map((t) => ({ id: t.id, s: pageScore(t, q) }));
  const top = Math.max(...scored.map((x) => x.s));
  if (top === 0) return null;
  return scored.find((x) => x.s === top)!.id;
}

describe("a realistic query lands on the page it names", () => {
  const tabs = loadTabs();

  const cases: [string, string][] = [
    ["dark mode", "appearance"],
    ["tmux prefix", "tmux"],
    ["sidebar order", "rail"],
    ["flight plan", "orchestration"],
    ["flight", "orchestration"],
    ["diff view", "diff"],
    ["task sources", "tasks"],
    ["github token", "connections"],
    ["budget limit", "budgets"],
    ["review prompts", "review-prompts"],
    ["saved replies", "saved-replies"],
    ["export data", "privacy"],
    ["privacy telemetry", "privacy"],
    ["monospace font", "terminal"],
    ["notification sound", "notifications"],
    ["install plugin", "plugins"],
    ["remote pair phone", "remote"],
    ["window fullscreen", "prefs"],
    // Activity is link-only: its own row on Data & privacy is the best answer and opens it.
    ["activity log", "privacy"],
    ["onboarding checklist", "onboarding"],
    ["hooks setup", "hooks"],
    ["font size", "terminal"],
    ["reminder alarm", "notifications"],
  ];

  for (const [q, pane] of cases) {
    test(`"${q}" reaches ${pane}`, () => {
      expect(reaches(tabs, q)).toBe(pane);
    });
  }
});

describe("the two properties that broke this week and had no test", () => {
  const tabs = loadTabs();

  test("a multi-word query needs each word matched, not the phrase as one substring", () => {
    const keys = tabs.find((t) => t.id === "keys")!;
    expect(pageScore(keys, "keyboard shortcuts")).toBeGreaterThan(0);
    expect(pageScore(keys, "keyboard zzzznotaword")).toBe(0);
  });

  test("a query that matches no page scores zero everywhere, so the box can say so", () => {
    const scored = tabs.map((t) => pageScore(t, "zzzznotasetting"));
    expect(Math.max(...scored)).toBe(0);
  });
});
