/*
 * A settings search hit on the Plugins page jumps to `[data-row=<anchor>]`.
 * Every Plugins row the index lists has to be drawn by something that renders
 * that anchor, or Enter opens the page and lands nowhere (the master switch
 * once carried only data-setting-id). Read from source, the way the index is.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";
import { rowId } from "../src/lib/settingsIndex.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const FILES = [read("../src/components/PluginsPane.tsx"), read("../src/components/plugins/PluginSettingsPane.tsx")];
/** Components that render `data-row={rowId(label)}` for the label they are given. */
const DRAWS_ANCHOR: Record<string, string> = {
  SettingRow: read("../src/components/SettingRow.tsx"),
};

function componentBody(src: string, name: string): string | null {
  const at = src.search(new RegExp(`\\nfunction ${name}\\(`));
  if (at < 0) return null;
  const next = src.slice(at + 10).search(/\n(?:export )?function \w+/);
  return src.slice(at, next < 0 ? undefined : at + 10 + next);
}

function anchored(label: string, settingId?: string): boolean {
  for (const src of FILES) {
    if (src.includes(`data-row={rowId("${label}")}`) || src.includes(`rowId(${JSON.stringify(label)})`)) return true;
    for (const m of src.matchAll(new RegExp(`<([A-Z]\\w*)\\b[^<>]*?\\blabel="${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"))) {
      const tag = m[1]!;
      const body = componentBody(src, tag) ?? (DRAWS_ANCHOR[tag] ? DRAWS_ANCHOR[tag] : null);
      if (body && /data-row=\{(?:rowId\(label\)|dataRow)\}/.test(body)) return true;
    }
  }
  return false;
}

describe("every Plugins row the index lists is a jump target", () => {
  const rows = SETTINGS_ROWS.filter((r) => r.pane === "plugins");
  test("the index lists Plugins rows", () => expect(rows.length).toBeGreaterThan(0));
  for (const r of rows) test(`${r.label} (${rowId(r.label)})`, () => expect(anchored(r.label, r.settingId)).toBe(true));
});
