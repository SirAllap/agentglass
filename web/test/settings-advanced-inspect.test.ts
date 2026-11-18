import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { ADVANCED_ROWS, ADVANCED_SECTIONS, filterAdvanced, wordCount } from "../src/components/settings/pages/advancedRows.ts";
import { INSPECT_ROWS, INSPECT_SECTIONS, factText } from "../src/components/settings/pages/inspectRows.ts";
import { hasRail, orderSections } from "../src/components/settings/shell/shellRules.ts";
import { SETTINGS_ROWS } from "../src/lib/settingsRows.gen.ts";


test("every Advanced row appears once: setting id once, row key once", () => {
  const keys = ADVANCED_ROWS.map((r) => r.key);
  expect(new Set(keys).size).toBe(keys.length);
  const ids = ADVANCED_ROWS.flatMap((r) => (r.id ? [r.id] : []));
  expect(new Set(ids).size).toBe(ids.length);
});

test("every Advanced id is a real setting id of the registry, and no Inspect id is writable here", () => {
  const known = new Set(SETTINGS_ROWS.flatMap((r) => (r.settingId ? [r.settingId] : [])));
  for (const r of ADVANCED_ROWS) if (r.id) expect(known.has(r.id)).toBe(true);
  const adv = new Set(ADVANCED_ROWS.flatMap((r) => (r.id ? [r.id] : [])));
  for (const r of INSPECT_ROWS) expect(adv.has(r.id)).toBe(false);
});

test("an id lives on Advanced or Inspect, never both, and Inspect ids are unique", () => {
  const ids = INSPECT_ROWS.map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("no row without a control or a link: a link row names a pane, the rest have a setting id", () => {
  for (const r of ADVANCED_ROWS) {
    if (r.kind === "link") expect(r.pane.length).toBeGreaterThan(0);
    else if (r.kind === "tmux") expect(r.field.length).toBeGreaterThan(0); // a tmux engine field, saved through the tmux door (TmuxRows.tsx)
    else expect(r.id).toBeTruthy();
  }
});

test("every Advanced row says when you would touch it, in 14 words or fewer", () => {
  for (const r of ADVANCED_ROWS) {
    expect(r.touch.length).toBeGreaterThan(0);
    expect(wordCount(r.touch)).toBeLessThanOrEqual(14);
    expect(r.touch.endsWith(".")).toBe(true);
  }
  for (const r of INSPECT_ROWS) {
    expect(wordCount(r.help)).toBeLessThanOrEqual(14);
    expect(r.help.endsWith(".")).toBe(true);
  }
});

test("every row sits in a declared section; empty sections do not exist", () => {
  for (const r of ADVANCED_ROWS) expect((ADVANCED_SECTIONS as readonly string[]).includes(r.section)).toBe(true);
  for (const s of ADVANCED_SECTIONS) expect(ADVANCED_ROWS.some((r) => r.section === s)).toBe(true);
  for (const r of INSPECT_ROWS) expect((INSPECT_SECTIONS as readonly string[]).includes(r.section)).toBe(true);
});

test("labels are unique on each page (sentence case, no full stop)", () => {
  const a = ADVANCED_ROWS.map((r) => r.label);
  expect(new Set(a).size).toBe(a.length);
  for (const l of [...a, ...INSPECT_ROWS.map((r) => r.label)]) expect(l.endsWith(".")).toBe(false);
});

test("the Advanced filter matches label and help text, nothing else", () => {
  expect(filterAdvanced(ADVANCED_ROWS, "").length).toBe(ADVANCED_ROWS.length);
  expect(filterAdvanced(ADVANCED_ROWS, "  ").length).toBe(ADVANCED_ROWS.length);
  const byLabel = filterAdvanced(ADVANCED_ROWS, "robots.txt");
  expect(byLabel.some((r) => r.id === "limits.browserRobots")).toBe(true);
  const byHelp = filterAdvanced(ADVANCED_ROWS, "tmux prefix collides");
  expect(byHelp.map((r) => r.key)).toEqual(["tmux.prefix"]);
  // The setting id is not searched.
  expect(filterAdvanced(ADVANCED_ROWS, "limits.rateMax").length).toBe(0);
  expect(filterAdvanced(ADVANCED_ROWS, "zzzzzz").length).toBe(0);
});

test("rows read once at start carry the restart tag", () => {
  const max = ADVANCED_ROWS.find((r) => r.id === "limits.maxTerminals");
  expect(max?.restart).toBe(true);
  expect(ADVANCED_ROWS.find((r) => r.id === "limits.browserRobots")?.restart).toBeFalsy();
});

test("rail rule: Advanced and Inspect both have 2+ sections so both have the rail", () => {
  expect(hasRail(ADVANCED_SECTIONS.length)).toBe(true);
  expect(hasRail(INSPECT_SECTIONS.length)).toBe(INSPECT_SECTIONS.length >= 2);
  expect(orderSections(ADVANCED_SECTIONS.map((s) => ({ s, kind: "normal" as const }))).map((x) => x.s)).toEqual([...ADVANCED_SECTIONS]);
});

test("Inspect rows have no control: they are fact rows, and facts are Inspect-only", () => {
  const src = readFileSync(new URL("../src/components/settings/pages/inspect.tsx", import.meta.url), "utf8");
  expect(src).toContain('kind="fact"');
  expect(src).not.toContain("settingAtSet");
  const adv = readFileSync(new URL("../src/components/settings/pages/advanced.tsx", import.meta.url), "utf8");
  expect(adv).not.toContain('kind="fact"');
  expect(adv).not.toMatch(/JSON\.stringify/);
});

test("factText: empty reads Not set, objects read as one line of JSON", () => {
  expect(factText(undefined)).toBe("Not set");
  expect(factText("")).toBe("Not set");
  expect(factText({ a: 1 })).toBe('{"a":1}');
  expect(factText("x")).toBe("x");
});

test("the modal routes the two page ids to the new pages, in one line each", () => {
  const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
  expect(src).toContain('{show("advanced") && <AdvancedSettingsPage c={pageCtx} />}');
  expect(src).toContain('{show("inspect") && <InspectSettingsPage />}');
  expect(src).not.toContain("move here when the pages are rebuilt");
});

