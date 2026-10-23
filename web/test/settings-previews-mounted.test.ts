/*
 * The previews, mounted in the pages. Each decision is asserted where it is
 * made and goes red when reverted: every page passes the values its own
 * controls hold (no copy of the state), no empty slot is left behind, a
 * plugin's page draws its picture from the values it is editing, and Wrap in
 * the diff wraps.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PREVIEWS } from "../src/components/settings/previews/index.ts";
import { capLabel } from "../src/components/settings/previews/logic.ts";
import { railItems } from "../src/components/settings/previews/MiniApp.tsx";
import { SHIPPED_RAIL } from "../src/components/workspace/views.ts";
import { pluginPreview } from "../src/components/settings/pluginPreviews.tsx";
import { PreviewCard, WithPreview } from "../src/components/settings/PreviewCard.tsx";
import { UnifiedDiff } from "../src/components/diff/DiffLines.tsx";
import type { Field } from "../src/lib/pluginTypes.ts";

const SRC = join(import.meta.dir, "../src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const h = React.createElement;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

/** The attribute names written on the first `<Tag ... />` in a source. */
function attrsOf(source: string, tag: string): string[] {
  const at = source.indexOf(`<${tag} `);
  expect(at).toBeGreaterThan(-1);
  const end = source.indexOf("/>", at);
  const open = source.slice(at + tag.length + 1, end);
  // `={...}` values may hold `>` or nested braces; only the names matter.
  return [...open.replace(/=\{[^}]*(\{[^}]*\}[^}]*)*\}/g, "=").replace(/="[^"]*"/g, "=").matchAll(/(?:^|\s)([A-Za-z]\w*)(?=\s|=|$)/g)].map((m) => m[1]!);
}

const required = (id: keyof typeof PREVIEWS) => PREVIEWS[id].props.filter((p) => !p.endsWith("?"));

const MOUNTS: [keyof typeof PREVIEWS, string, string][] = [
  ["prefs", "components/SettingsModal.tsx", "WindowPreview"],
  ["appearance", "components/ThemePicker.tsx", "AppearancePreview"],
  ["rail", "components/SettingsModal.tsx", "SidebarPreview"],
  ["diff", "components/SettingsModal.tsx", "DiffPreview"],
  ["lantern", "components/SettingsModal.tsx", "LanternPreview"],
  ["browser", "components/SettingsModal.tsx", "BrowserPreview"],
  ["jev-inbox", "components/settings/pluginPreviews.tsx", "JevInboxPreview"],
  ["context-diet", "components/settings/pluginPreviews.tsx", "ContextDietPreview"],
  ["local-review", "components/settings/pluginPreviews.tsx", "LocalReviewPreview"],
];

describe("every page mounts its preview with the props the preview declares", () => {
  for (const [id, file, tag] of MOUNTS) {
    test(`${id}: <${tag}> in ${file} carries every required prop`, () => {
      const got = attrsOf(read(file), tag);
      for (const p of required(id)) expect(got).toContain(p);
    });
  }
  test("the page's values are state it already holds, not literals", () => {
    const modal = read("components/SettingsModal.tsx");
    expect(modal).toContain("<DiffPreview split={dSplit} wrap={dWrap} syntaxTheme={dTheme} />");
    expect(modal).toContain("<LanternPreview watch={watch} everyMin={watchMinutes} wakeMin={cacheTtl} />");
    expect(modal).toContain("<SidebarPreview items={railItems(rail)}");
    expect(modal).toContain("fullscreen={fullscreen}");
    expect(modal).toContain("startAtLogin={autostart === true}");
    expect(modal).toContain("launchAnimation={splash}");
    expect(modal).toContain("codexQuota={usageRefresh}");
    expect(modal).toContain("zoomPct={Math.round(scale * 100)}");
    expect(modal).toContain("<BrowserPreview home={savedHome} searchEngine={SEARCH_ENGINE_LABELS[engine]} />");
    // The same pair the controls write through.
    for (const pair of ["[dSplit, setDSplitState]", "[dWrap, setDWrapState]", "[dTheme, setDThemeState]", "[splash, setSplash]", "[usageRefresh, setUsageRefreshState]"]) {
      expect(modal.split(`const ${pair}`).length - 1).toBe(1);
    }
    const picker = read("components/ThemePicker.tsx");
    expect(picker).toContain("theme={current} accent={accent}");
  });
  test("the shell holds no state of its own for a picture", () => {
    expect(read("components/settings/PreviewCard.tsx")).not.toMatch(/useState|useEffect|localStorage/);
    expect(read("components/settings/pluginPreviews.tsx")).not.toMatch(/useState|useEffect|localStorage/);
  });
  test("Orchestration keeps the live, interactive flow in its side slot", () => {
    // The OrchestrationPreview is the same FlowView made read-only; the page's own slot
    // must keep the Change buttons that drive the fine-tune card.
    const pane = read("components/orchestration/OrchestrationPane.tsx");
    const side = pane.slice(pane.indexOf('<aside className="agx-split-side">'), pane.indexOf("</aside>"));
    expect(side).toContain("<FlowView");
    expect(side).toContain("onChange={(field) => { setPicking(field)");
  });
});

describe("no empty slot is left", () => {
  test("PreviewSlot is gone: no file, no use", () => {
    expect(existsSync(join(SRC, "components/SettingsPreviewSlot.tsx"))).toBe(false);
    for (const f of walk(SRC)) expect(readFileSync(f, "utf8")).not.toContain("PreviewSlot");
  });
  test("a slot holds a preview, never a note saying one will come", () => {
    for (const f of walk(SRC)) expect(readFileSync(f, "utf8")).not.toMatch(/data-preview-slot="[^"]+"\s*\/>/);
  });
});

describe("the shell", () => {
  test("cards left, picture right from 1280px, picture after the cards when stacked, in view while scrolling", () => {
    const m = html(h(WithPreview, { preview: h("i", { id: "pic" }), children: h("b", { id: "cards" }) }));
    expect(m).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]");
    expect(m).toContain("xl:sticky");
    expect(m.indexOf('id="cards"')).toBeLessThan(m.indexOf('id="pic"'));
  });
  test("the card names the page it follows", () => {
    expect(html(h(PreviewCard, { id: "diff", title: "T", children: "x" }))).toContain('data-preview-slot="diff"');
  });
});

describe("the rail the pictures draw is the rail the person has", () => {
  test("drawers keep their zone and a hidden view is off", () => {
    const items = railItems({ work: [SHIPPED_RAIL.work[0]!], utility: [SHIPPED_RAIL.utility[0]!], hidden: [SHIPPED_RAIL.work[1]!] });
    expect(items.map((i) => i.zone)).toEqual(["top", "bottom", "off"]);
    expect(items[2]!.id).toBe(SHIPPED_RAIL.work[1]!.id);
  });
  test("the Rail page highlights the view last touched, through every way of moving one", () => {
    const m = read("components/SettingsModal.tsx");
    const pane = m.slice(m.indexOf("function RailPane()"), m.indexOf("function MiniBtn"));
    expect(pane).toContain("selected={touched ?? rail.work[0]?.id ?? \"\"}");
    expect(pane).not.toContain("moveView(v.id");
    expect(pane).toContain("setTouched(v.id); setting(`rail.place.${v.id}`).set(p)");
  });
});

describe("a plugin's page draws its picture from the values it is editing", () => {
  const sel = (key: string, options: [string, string][]): Field => ({ key, type: "select", label: key, options: options.map(([value, label]) => ({ value, label })) } as Field);
  test("an unknown plugin gets the plain page", () => {
    expect(pluginPreview("orbit-clock", {}, [], [])).toBeNull();
  });
  test("Jev Inbox: key, consent, mode, threshold, repo and title length each reach the picture", () => {
    const at = (v: Record<string, unknown>, keys: string[] = ["apiKey"]) => html(pluginPreview("jev-inbox", v, keys, [])!.node as React.ReactElement);
    const base = { consent: true, mode: "live", threshold: 0.8, includeRepo: false, maxTitle: 200 };
    expect(at(base, [])).toContain("not-ready");
    expect(at({ ...base, consent: false })).toContain("not-ready");
    expect(at(base)).not.toContain("not-ready");
    expect(at({ ...base, mode: "shadow" })).not.toBe(at(base));
    expect(at({ ...base, threshold: 0.2 })).not.toBe(at(base));
    expect(at({ ...base, includeRepo: true })).not.toBe(at(base));
    expect(at({ ...base, maxTitle: 40 })).not.toBe(at(base));
    expect(at({ ...base, mode: "nonsense" })).toBe(at({ ...base, mode: "off" }));
  });
  test("Jev Inbox: a secret's value is never drawn", () => {
    expect(html(pluginPreview("jev-inbox", { apiKey: "sk-live-123", consent: true, mode: "live" }, ["apiKey"], [])!.node as React.ReactElement)).not.toContain("sk-live-123");
  });
  test("Context Diet: the cap and the window reach the picture; the cap rounds to the nearest drawn", () => {
    const at = (v: Record<string, unknown>) => html(pluginPreview("context-diet", v, [], [])!.node as React.ReactElement);
    expect(at({ cap: 100000 })).not.toBe(at({ cap: 500000 }));
    expect(at({ windowDays: 7 })).toContain("week");
    expect(at({ windowDays: 30 })).toContain("month");
    expect(at({ windowDays: 90 })).toContain("month");
    expect([capLabel(50_000), capLabel(200_000), capLabel(1_000_000)]).toEqual(["100K", "200K", "500K"]);
  });
  test("Local Review: the agent's label, the model and the cap reach the picture", () => {
    const fields = [sel("agent", [["claude", "Claude Code"], ["codex", "Codex"]])];
    const at = (v: Record<string, unknown>) => html(pluginPreview("local-review", v, [], fields)!.node as React.ReactElement);
    expect(at({ agent: "codex", model: "m-1", maxUsdPerReview: 3 })).toContain("Codex · m-1");
    expect(at({ agent: "claude" })).toContain("Claude Code · default model");
    expect(at({ maxUsdPerReview: 2 })).not.toBe(at({ maxUsdPerReview: 9 }));
  });
  test("the settings page reads the picture off the same values its rows edit", () => {
    const pane = read("components/plugins/PluginSettingsPane.tsx");
    expect(pane).toContain("pluginPreview(name, values, secretsSet, fields)");
    expect(pane).toContain("onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}");
  });
});

describe("a page's layout classes do not touch the diff's", () => {
  test("no class settingsSplit.css styles is one DiffLines puts on its own rows", () => {
    const css = read("components/settingsSplit.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const defined = new Set([...css.matchAll(/\.(agx-[\w-]+)/g)].map((m) => m[1]!));
    const diff = read("components/diff/DiffLines.tsx");
    const used = new Set([...diff.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) => (m[1] ?? m[2] ?? "").split(/\s+/)));
    for (const c of defined) expect(used.has(c)).toBe(false);
    // The diff's own class stays what DiffLines and its selection CSS expect.
    expect(used.has("agx-split")).toBe(true);
  });
});

describe("Wrap in the diff", () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+" + "x".repeat(300)] }];
  test("on, the rows take the pane's width so a long line has somewhere to break; off, they keep the file's width", () => {
    const on = html(h(UnifiedDiff, { hunks, wrap: true }));
    const off = html(h(UnifiedDiff, { hunks, wrap: false }));
    expect(on).not.toContain("max-content");
    expect(on).toContain("whitespace-pre-wrap");
    expect(off).toContain("max-content");
  });
  test("the preview follows the page's syntax-theme control, not only the one saved at mount", () => {
    const src = read("components/settings/previews/DiffPreview.tsx");
    expect(src).toContain("setThemePref(syntaxTheme)");
    expect(PREVIEWS.diff.props).toContain("syntaxTheme?");
  });
});
