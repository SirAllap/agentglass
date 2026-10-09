/*
 * The chip row for saved filter sets, executed. There is no DOM under
 * `bun test`, so effects and events do not run and what these see is the first
 * paint: which chips are drawn, which is pressed, who carries the dot and the
 * mark, what the Save slot says and whether it is disabled. The keys and menus
 * are not asserted here (nothing can press them); they were driven with real
 * key events in a headless browser, and the rules each one calls are pinned in
 * filter-presets.test.ts.
 *
 * Next to that, source-level locks on the two things a paint cannot show: that
 * the board really reads and writes the presets, and that the layout rules
 * this row was built to keep are still in the file.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterPresets, VISIBLE_CHIPS } from "../src/components/FilterPresets.tsx";
import type { PresetsApi } from "../src/components/useFilterPresets.ts";
import { MAX_PRESETS, type Preset } from "../src/lib/filterPresets.ts";
import type { FieldSpec, FilterSet } from "../src/components/tasks/filters.ts";

const mk = (id: string, name: string): Preset => ({
  id, name, join: "and", rules: [{ field: "cardstatus", op: "is", values: ["Pre QA"] }], order: 0,
});
const noop = () => {};
const api = (over: Partial<PresetsApi> = {}): PresetsApi => ({
  presets: [], activeId: null, active: null, modified: false, gone: {}, undo: null,
  apply: noop, saveNew: () => null, update: () => null, revert: noop, rename: () => null, move: noop,
  remove: noop, restore: noop, removeGone: noop, ...over,
});
const fields: FieldSpec[] = [{ key: "cardstatus", label: "Card status", options: [{ value: "Pre QA", label: "Pre QA" }] }];
const rule = (id: string) => ({ id, field: "cardstatus", op: "is" as const, values: ["Pre QA"] });
const none: FilterSet = { join: "and", rules: [] };
const some: FilterSet = { join: "and", rules: [rule("r1")] };

const draw = (a: PresetsApi, rules: FilterSet = none, counts: Record<string, number> = {}) =>
  renderToStaticMarkup(React.createElement(FilterPresets, { api: a, counts, rules, fields, hotkeys: false, onEditRule: noop }));
const three = [mk("a", "Mine"), mk("b", "Pre-QA"), mk("c", "In development")];
const chipsOf = (html: string) => [...html.matchAll(/data-chip="([^"]+)"/g)].map((m) => m[1]);
const saveButton = (html: string) => /<button[^>]*>\s*<span>Save<\/span>/.exec(html)?.[0] ?? "";

describe("the empty row", () => {
  test("teaches in one line and still has its Save slot, disabled with no rules", () => {
    const html = draw(api());
    expect(html).toContain("it becomes a one-click chip here");
    expect(chipsOf(html)).toEqual([]);
    const save = saveButton(html);
    expect(save).not.toBe("");
    expect(save).toContain("disabled");
    expect(save).toContain("Build a filter first");
  });
});

describe("chips", () => {
  test("one per preset, in order, each with the number of cards it would show", () => {
    const html = draw(api({ presets: three }), none, { a: 2, b: 5, c: 1 });
    expect(chipsOf(html)).toEqual(["a", "b", "c"]);
    expect(html).toMatch(/Mine<\/span>[\s\S]*?>2<\/span>/);
    expect(html).toMatch(/Pre-QA<\/span>[\s\S]*?>5<\/span>/);
  });

  test("exactly one chip is a tab stop (roving), and it is the active one when there is one", () => {
    const html = draw(api({ presets: three, activeId: "b", active: three[1] }), some, { a: 0, b: 0, c: 0 });
    const stops = [...html.matchAll(/<button[^>]*data-chip="([^"]+)"[^>]*>/g)].filter((m) => /tabindex="0"/.test(m[0])).map((m) => m[1]);
    expect(stops).toEqual(["b"]);
  });

  test("with nothing on, the first chip is the tab stop", () => {
    const html = draw(api({ presets: three }));
    const stops = [...html.matchAll(/<button[^>]*data-chip="([^"]+)"[^>]*>/g)].filter((m) => /tabindex="0"/.test(m[0])).map((m) => m[1]);
    expect(stops).toEqual(["a"]);
  });

  test("the active chip is pressed, the others are not", () => {
    const html = draw(api({ presets: three, activeId: "b", active: three[1] }), some);
    const pressed = [...html.matchAll(/<button[^>]*data-chip="([^"]+)"[^>]*aria-pressed="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(pressed).toEqual(["a:false", "b:true", "c:false"]);
  });

  test("the modified dot is on the active chip only, and says so to a screen reader", () => {
    const html = draw(api({ presets: three, activeId: "b", active: three[1], modified: true }), some);
    expect(html.match(/changed since saved/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Pre-QA, \d+ cards?, changed since saved"/);
    // The dot itself, not only its label: one warning-coloured dot, none when clean.
    expect(html.match(/background:var\(--warning\)/g)).toHaveLength(1);
    expect(draw(api({ presets: three, activeId: "b", active: three[1], modified: false }), some)).not.toContain("var(--warning)");
  });

  test("a preset with a value the board lost carries the mark", () => {
    const html = draw(api({ presets: three, gone: { c: [{ ruleIndex: 0, field: "cardstatus", fieldLabel: "Card status", value: "Gone" }] } }));
    expect(html.match(/a value is missing/g)).toHaveLength(1);
    expect(html).toMatch(/In development<\/span><span[^>]*>!<\/span>/);
  });
});

describe("more than four", () => {
  const many = Array.from({ length: 9 }, (_, i) => mk(`p${i}`, `Set ${i}`));

  test(`${VISIBLE_CHIPS} chips and a More button that counts the rest`, () => {
    const html = draw(api({ presets: many }));
    expect(chipsOf(html)).toEqual(["p0", "p1", "p2", "p3", "__more"]);
    expect(html).toMatch(/More<\/span><span[^>]*>5<\/span>/);
  });

  test("a hidden preset that is on presses More and names itself there", () => {
    const html = draw(api({ presets: many, activeId: "p7", active: many[7] }), some);
    const more = /<button[^>]*data-chip="__more"[^>]*>[\s\S]*?<\/button>/.exec(html)![0];
    expect(more).toContain('aria-pressed="true"');
    expect(more).toContain("Set 7");
    expect(more).not.toContain(">More<");
  });

  test("a visible active preset leaves More unpressed", () => {
    const html = draw(api({ presets: many, activeId: "p1", active: many[1] }), some);
    expect(/<button[^>]*data-chip="__more"[^>]*>/.exec(html)![0]).toContain('aria-pressed="false"');
  });
});

describe("the Save slot", () => {
  test("rules and nothing on: enabled, and it opens a name field", () => {
    const save = saveButton(draw(api({ presets: three }), some));
    expect(save).not.toContain("disabled");
    expect(save).toContain('aria-haspopup="dialog"');
  });

  test("a preset on and unchanged: disabled, and says why", () => {
    const save = saveButton(draw(api({ presets: three, activeId: "b", active: three[1] }), some));
    expect(save).toContain("disabled");
    expect(save).toContain("Nothing has changed since");
  });

  test("a preset on and modified: enabled, and it opens a menu", () => {
    const save = saveButton(draw(api({ presets: three, activeId: "b", active: three[1], modified: true }), some));
    expect(save).not.toContain("disabled");
    expect(save).toContain('aria-haspopup="menu"');
  });

  test("a full list with nothing on: disabled at the limit", () => {
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => mk(`p${i}`, `Set ${i}`));
    const save = saveButton(draw(api({ presets: full }), some));
    expect(save).toContain("disabled");
    expect(save).toContain(`${MAX_PRESETS} presets is the limit`);
  });

  test("the slot is drawn in every state: it is the same control, never added or removed", () => {
    for (const a of [api(), api({ presets: three }), api({ presets: three, activeId: "a", active: three[0], modified: true })]) {
      expect(saveButton(draw(a, some))).not.toBe("");
    }
  });
});

describe("the undo toast", () => {
  test("a delete is taken back from a toast that names it (rendered in a portal, so nothing in the first paint)", () => {
    // The toast is a Portal child; under static render a portal draws nothing,
    // so the assertion is that drawing with an undo pending does not throw and
    // leaves the row intact.
    const html = draw(api({ presets: three, undo: { name: "Gone", id: "g" } }));
    expect(chipsOf(html)).toEqual(["a", "b", "c"]);
  });
});

describe("the board is wired to it", () => {
  const panel = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  const builder = readFileSync(new URL("../src/components/tasks/FilterBuilder.tsx", import.meta.url), "utf8");
  const hook = readFileSync(new URL("../src/components/useFilterPresets.ts", import.meta.url), "utf8");

  test("PrPanel draws the row beside the builder and counts through the board's own predicate", () => {
    expect(panel).toContain("useFilterPresets({ repoKey: repo?.key ?? null");
    expect(panel).toContain("<FilterPresets api={presetsApi}");
    const counts = panel.slice(panel.indexOf("const presetCountsById"), panel.indexOf("const [builderOpenSignal"));
    expect(counts).toContain("applyRulesKeepUnread(");
    expect(counts).toContain("boardMineCards, boardReviewCards");
    expect(counts).toContain("(p) => p.number");
  });

  test("Edit rule opens the builder on the preset, through its open signal", () => {
    expect(panel).toContain("presetsApi.apply(id); setBuilderOpenSignal(");
    expect(panel).toContain("openSignal={builderOpenSignal}");
    expect(builder).toContain("openSignal");
  });

  test("storage is per repository and goes through the validating reader", () => {
    expect(hook).toContain("readPresetMap(read(PRESETS_KEY))");
    expect(hook).toContain("readActiveMap(read(ACTIVE_KEY))");
    expect(hook).toContain("[repoKey]: list");
  });

  test("nothing in the row asks the server for anything", () => {
    const row = readFileSync(new URL("../src/components/FilterPresets.tsx", import.meta.url), "utf8");
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const src of [row, hook]) expect(code(src)).not.toMatch(/\bfetch\(|from "[./]+\/lib\/api|XMLHttpRequest|WebSocket/);
  });
});
