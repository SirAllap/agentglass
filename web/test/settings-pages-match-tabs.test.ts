/*
 * SETTINGS_PAGES (generated, in settingsRows.gen.ts) is what the command
 * palette uses to list "Settings: <page>" entries — CommandBar.tsx does not
 * import SettingsModal.tsx (that would drag React and every pane's own
 * dependencies into the palette's bundle for a list of 24 strings). This
 * checks the two lists never drift apart instead of trusting the generator
 * was run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_PAGES } from "../src/lib/settingsRows.gen.ts";

function loadTabs(): { id: string; label: string }[] {
  const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
  const re = /\{ id: "([A-Za-z-]+)"(?: as const)?, label: "([^"]*)", group: "[^"]*"(?: as const)?, kw: "([^"]*)"/g;
  const out: { id: string; label: string }[] = [];
  for (const m of src.matchAll(re)) out.push({ id: m[1]!, label: m[2]! });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

describe("SETTINGS_PAGES matches TABS", () => {
  test("same ids, same labels", () => {
    const tabs = loadTabs();
    const pages = [...SETTINGS_PAGES].sort((a, b) => a.id.localeCompare(b.id));
    expect(pages).toEqual(tabs);
  });
});
