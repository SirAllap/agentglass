import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

test("Path and Custom prefix draw only for Custom", () => {
  // The tmux engine rows are TmuxRow fields on Advanced now: each one is locked until its choice is made.
  const rows = readFileSync(new URL("../src/components/settings/pages/TmuxRows.tsx", import.meta.url), "utf8");
  expect(rows).toContain('st.source !== "custom"');
  expect(rows).toContain("listed && !custom");
});

test("every Pane engine row is on Advanced > Terminal engine and none is on Terminal", () => {
  const on = (pane: string) => SETTINGS_ROWS.filter((r) => r.pane === pane).map((r) => r.label);
  // Restore the layout and Resume mode are person rows on the Terminal page's Restore section.
  for (const l of ["Restore the layout", "Resume mode"]) expect(on("terminal")).toContain(l);
  for (const l of ["tmux binary", "Path to the binary", "Prefix key", "Custom prefix key", "Mode", "Override config", "Terminal runs on"]) {
    expect(on("advanced"), l).toContain(l);
    expect(on("terminal"), l).not.toContain(l);
  }
});

test("Finder rows are indexed on the finder page", () => {
  const f = SETTINGS_ROWS.filter((r) => r.pane === "finder").map((r) => r.label);
  for (const l of ["Folder peeking", "Show hidden files", "Text size"]  /* Density lives on Appearance now */) expect(f).toContain(l);
});

test("diff keys keep the old three and add the page rows", () => {
  const ids = SETTINGS_ROWS.filter((r) => r.pane === "diff").map((r) => r.settingId).sort();
  expect(ids).toEqual(["diff.groupBy", "diff.showIgnored", "diff.showOutside", "diff.split", "diff.syntaxTheme", "diff.wrap"]);
});
