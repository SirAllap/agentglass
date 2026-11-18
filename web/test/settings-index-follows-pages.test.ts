/*
 * Every control a settings page renders is findable in Settings search, on the page that holds it.
 *
 * The index is a regex over source text. When a row moved from a page file into a component the page
 * renders (a card, a row component), the regex stopped reading it and search could not find it. This
 * walks the same way a reader would: from the page file, through every component its JSX names, and
 * checks each literal `settingId="…"` and each literal row `label="…"` has an index row on that page.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";

const COMPONENTS = resolve(import.meta.dir, "../src/components");
const files: string[] = [];
(function walk(d: string) { for (const n of readdirSync(d).sort()) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.endsWith(".tsx") && files.push(p); } })(COMPONENTS);
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const definer = (name: string) => files.find((f) => new RegExp(`(^|\\n)(?:export )?(?:function ${name}\\b|const ${name}\\b)`).test(text.get(f)!));
const modal = text.get(join(COMPONENTS, "SettingsModal.tsx"))!;

/** pane -> page component, from the `{show("pane") && <XPage …/>}` lines of the modal. */
const PAGES = [...modal.matchAll(/\{show\("([A-Za-z-]+)"\) && <(\w+Page)\b/g)].map((m) => ({ pane: m[1]!, comp: m[2]! }));

/** The source of every component a page renders, through any depth. */
function rendered(comp: string): string {
  const seen = new Set<string>(); let out = "";
  const visit = (name: string) => {
    // The orchestration view is one component drawn as several pages (Roles & limits, the two Permissions pages): the generator reads its parts, so the walk stops here.
    if (seen.has(name) || name === "OrchestrationPane" || name === "OrchestrationView") return; seen.add(name);
    const f = definer(name); if (!f || f.endsWith("SettingsModal.tsx")) return;
    const src = text.get(f)!;
    const at = src.search(new RegExp(`(^|\\n)(?:export )?(?:function ${name}\\b|const ${name}\\b)`));
    const rest = src.slice(at + 1);
    const end = rest.slice(8).search(/\n(?:export )?(?:function|const) [A-Z]\w*\b/);
    const body = end < 0 ? rest : rest.slice(0, end + 8);
    out += "\n" + body;
    for (const m of body.matchAll(/<([A-Z]\w*)\b/g)) visit(m[1]!);
  };
  visit(comp);
  return out;
}

describe("settings index follows what a page renders", () => {
  test("the walk finds the pages", () => { expect(PAGES.length).toBeGreaterThan(10); });
  for (const { pane, comp } of PAGES) {
    test(`${pane}: every literal setting id and row label is indexed on it`, () => {
      const src = rendered(comp);
      const here = SETTINGS_ROWS.filter((r) => r.pane === pane);
      const ids = new Set(here.map((r) => r.settingId));
      const labels = new Set(here.map((r) => r.label));
      const missing: string[] = [];
      for (const m of src.matchAll(/<(?:SettingRow|ShellRow|Toggle|DoorSwitchRow)\b[^>]*?\bsettingId="([A-Za-z0-9.]+)"/g)) if (!ids.has(m[1]!) && ![...ids].some((i) => i?.endsWith("*") && m[1]!.startsWith(i.slice(0, -1)))) missing.push(m[1]!);
      for (const m of src.matchAll(/<(?:SettingRow|ShellRow)\b[^>]*?\bkind="[a-z]+"[^>]*?\blabel="([^"]{1,90})"/g)) if (!labels.has(m[1]!)) missing.push(m[1]!);
      expect(missing).toEqual([]);
    });
  }

  test("every component exported from settings/pages is rendered by some page", () => {
    // A component nobody renders is a dropped setting: its rows exist in source and nowhere on screen.
    const pagesDir = join(COMPONENTS, "settings/pages");
    const exported: { name: string; file: string }[] = [];
    for (const f of files.filter((x) => x.startsWith(pagesDir))) {
      for (const m of text.get(f)!.matchAll(/(?:^|\n)export (?:function|const) ([A-Z][a-z]\w*)\b/g)) exported.push({ name: m[1]!, file: f });
    }
    const all = [...text.values()].join("\n");
    const orphans = exported.filter((e) => !new RegExp(`<${e.name}\\b`).test(all)).map((e) => e.name);
    expect(orphans).toEqual([]);
  });
});
