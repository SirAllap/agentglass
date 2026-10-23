/*
 * The live previews of the settings pages. Each decision is asserted where it
 * is made: the pure rules directly, the markup by rendering a preview with two
 * different sets of values, and the "tokens only, real components, values from
 * props" rules against the source. Each test goes red when the decision is
 * reverted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  densityPad, fontScale, jevReady, jevRows, ledgerBars, railBadge, railDrawers, redactTitle, removedCounts,
  searchPlaceholder, sentTitle, watchLine, zoomScale, type RailItem,
} from "../src/components/settings/previews/logic.ts";
import { PREVIEWS } from "../src/components/settings/previews/index.ts";
import { BrowserPreview } from "../src/components/settings/previews/BrowserPreview.tsx";
import { JevInboxPreview } from "../src/components/settings/previews/JevInboxPreview.tsx";
import { ContextDietPreview } from "../src/components/settings/previews/ContextDietPreview.tsx";
import { LocalReviewPreview } from "../src/components/settings/previews/LocalReviewPreview.tsx";
import { SidebarPreview } from "../src/components/settings/previews/SidebarPreview.tsx";
import { WindowPreview } from "../src/components/settings/previews/WindowPreview.tsx";

const DIR = join(import.meta.dir, "../src/components/settings/previews");
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f));
const src = (f: string) => readFileSync(join(DIR, f), "utf8");
/** Source without comment lines, so a word in prose does not trip a rule about code. */
const code = (f: string) => src(f).split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("the rules a preview draws by", () => {
  test("Jev: live sorts and badges at the threshold; shadow and off leave the Inbox alone", () => {
    const live = jevRows("live", 0.8);
    expect(live.map((r) => r.row.p)).toEqual(live.map((r) => r.row.p).sort((a, b) => b - a));
    expect(live.filter((r) => r.hot).length).toBe(2);
    expect(jevRows("shadow", 0.8).some((r) => r.hot)).toBe(false);
    expect(jevRows("off", 0).some((r) => r.hot)).toBe(false);
    expect(jevRows("shadow", 0.8)[0]!.row.p).toBe(0.94 /* GitHub's order: first row first */);
    expect(jevRows("shadow", 0.8)[3]!.row.p).toBe(0.31);
  });
  test("Jev: nothing is scored before a key and the consent", () => {
    expect(jevReady(true, false)).toBe(false);
    expect(jevReady(false, true)).toBe(false);
    expect(jevReady(true, true)).toBe(true);
  });
  test("Jev: links and names are removed, then the title is cut at the setting", () => {
    expect(redactTitle("@ana look at https://acme.dev/x")).toBe("[name] look at [link]");
    expect(removedCounts("@ana @bo https://a.dev")).toEqual({ links: 1, names: 2 });
    expect(sentTitle("abcdefghij", 4)).toEqual({ text: "abcd", cut: true });
    expect(sentTitle("abc", 4)).toEqual({ text: "abc", cut: false });
  });
  test("Context ledger: a smaller cap trims more turns", () => {
    const over = (c: "100K" | "200K" | "500K") => ledgerBars(c).filter((b) => b.over).length;
    expect(over("100K")).toBeGreaterThan(over("200K"));
    expect(over("200K")).toBeGreaterThan(over("500K"));
  });
  test("rail: hidden views are not drawn, a badge is a number or a dot", () => {
    const items: RailItem[] = [{ id: "a", name: "A", zone: "top" }, { id: "b", name: "B", zone: "off" }, { id: "c", name: "C", zone: "bottom", badge: true, count: 3 }, { id: "d", name: "D", zone: "top", badge: true }];
    const d = railDrawers(items);
    expect(d.top.map((i) => i.id)).toEqual(["a", "d"]);
    expect(d.bottom.map((i) => i.id)).toEqual(["c"]);
    expect([railBadge(items[0]!), railBadge(items[2]!), railBadge(items[3]!)]).toEqual(["none", "3", "dot"]);
  });
  test("size settings are clamped to what the page offers", () => {
    expect(zoomScale(200)).toBe(1.25);
    expect(zoomScale(50)).toBe(0.9);
    expect(fontScale(99)).toBeCloseTo(15 / 13);
    expect(densityPad("compact")).toBeLessThan(densityPad("roomy"));
  });
  test("Lantern and Browser words follow the settings", () => {
    expect(watchLine(false, 15)).toBe("· watch off");
    expect(watchLine(true, 30)).toContain("every 30 min");
    expect(searchPlaceholder("Brave Search")).toContain("Brave Search");
    expect(searchPlaceholder("")).toBe("Type an address");
  });
});

describe("the markup follows the values it is given", () => {
  test("Browser: address bar and search box", () => {
    const a = html(h(BrowserPreview, { home: "https://orbit.dev/dashboard", searchEngine: "Brave Search" }));
    expect(a).toContain("https://orbit.dev/dashboard");
    expect(a).toContain("Search Brave Search or type an address");
    expect(a).toContain("Drawn, not a capture");
    expect(html(h(BrowserPreview, { home: "  ", searchEngine: "x" }))).toContain("about:blank");
  });
  test("Jev: not ready says so, ready shows the payload with the repo only when asked", () => {
    const base = { hasKey: true, consent: true, mode: "live" as const, threshold: 0.7, sendRepo: false, maxTitle: 400 };
    expect(html(h(JevInboxPreview, { ...base, consent: false }))).toContain("Nothing is scored yet");
    const a = html(h(JevInboxPreview, base));
    expect(a).not.toContain("&quot;repo&quot;");
    expect(html(h(JevInboxPreview, { ...base, sendRepo: true }))).toContain("&quot;repo&quot;: &quot;orbit&quot;");
    expect(html(h(JevInboxPreview, { ...base, mode: "off" }))).toContain("exactly as GitHub sent it");
  });
  test("Context ledger, Local review: each setting reaches the picture", () => {
    expect(html(h(ContextDietPreview, { cap: "500K", countSubagents: false, windowDays: 30 }))).toContain("Subagent turns are left out · window 30 days · cap 500K per turn");
    expect(html(h(LocalReviewPreview, { agent: "Codex CLI", model: "opus", capUsd: 5 }))).toContain("Codex CLI · opus");
    expect(html(h(LocalReviewPreview, { agent: "a", model: "m", capUsd: 5 }))).toContain("$5.00");
  });
  test("Sidebar and Window: a hidden view leaves the rail; the frame, clock and quota follow", () => {
    const on = [{ id: "git", name: "Git", zone: "top" as const }, { id: "term", name: "Term", zone: "off" as const }];
    const s = html(h(SidebarPreview, { items: on, selected: "git" }));
    expect(s).toContain('data-rail-item="git"');
    expect(s).not.toContain('data-rail-item="term"');
    const w = (o: object) => html(h(WindowPreview, { zoomPct: 100, fullscreen: false, startAtLogin: false, launchAnimation: false, showClock: false, codexQuota: false, ...o }));
    expect(w({})).toContain("data-frame");
    expect(w({ fullscreen: true })).not.toContain("data-frame");
    expect(w({ fullscreen: true, showClock: true })).toContain("data-clock");
    expect(w({ showClock: true })).not.toContain("data-clock");
    expect(w({ codexQuota: true })).toContain("data-quota");
    expect(w({ startAtLogin: true })).toContain("data-tray");
    expect(w({ launchAnimation: true })).toContain("data-cover");
  });
});

describe("what a preview is made of", () => {
  const comps = files.filter((f) => f.endsWith("Preview.tsx") || f === "MiniApp.tsx" || f === "Frame.tsx");
  test("theme tokens only: no colour literal, no image, no off-canon border or radius", () => {
    for (const f of files) {
      const c = code(f);
      expect({ f, hex: c.match(/["'`]#[0-9a-fA-F]{3,8}\b/g) }).toEqual({ f, hex: null });
      expect({ f, rgb: /\brgba?\(/.test(c.replace(/var\(--[a-z-]+\)/g, "")) }).toEqual({ f, rgb: false });
      expect({ f, img: /<img\b|\.png|\.jpe?g|data:image/.test(c) }).toEqual({ f, img: false });
      expect({ f, px: /1px solid|rounded-2xl|rounded-\[/.test(c) }).toEqual({ f, px: false });
    }
  });
  test("a preview reads its values from props, never from storage or the network", () => {
    for (const f of comps) {
      const c = code(f);
      expect({ f, store: /localStorage|sessionStorage|fetch\(|\/api\//.test(c) }).toEqual({ f, store: false });
    }
  });
  test("the real pieces are the real components", () => {
    expect(code("OrchestrationPreview.tsx")).toContain("<FlowView");
    expect(code("DiffPreview.tsx")).toMatch(/<SplitDiff[\s\S]*<UnifiedDiff/);
    expect(code("LanternPreview.tsx")).toContain("<AgentCard");
    expect(code("LanternPreview.tsx")).toContain("cacheTtlMs={wakeMin");
  });
  test("the surface tokens are redeclared as index.css has them", () => {
    const css = readFileSync(join(import.meta.dir, "../src/index.css"), "utf8");
    const mine = src("Frame.tsx").match(/--surface-(?:nav|inset|line):[^;]+;/g) ?? [];
    expect(mine.length).toBe(3);
    expect(src("Frame.tsx")).toContain("--surface-card:color-mix(in srgb, var(--bg2) 100%, transparent);");
    expect(css).toContain("--surface-card: var(--bg2);");
    const norm = (s: string) => s.replace(/\s+/g, "");
    for (const d of mine) expect(norm(css)).toContain(norm(d));
  });
  test("index maps every pane to a component and the exact props that component declares", () => {
    const ids = Object.keys(PREVIEWS).sort();
    expect(ids).toEqual(["appearance", "browser", "context-diet", "diff", "jev-inbox", "lantern", "local-review", "orchestration", "prefs", "rail"]);
    const file: Record<string, string> = {
      prefs: "WindowPreview", appearance: "AppearancePreview", rail: "SidebarPreview", diff: "DiffPreview", lantern: "LanternPreview",
      browser: "BrowserPreview", orchestration: "OrchestrationPreview", "jev-inbox": "JevInboxPreview", "context-diet": "ContextDietPreview", "local-review": "LocalReviewPreview",
    };
    for (const id of ids) {
      const body = src(`${file[id]}.tsx`).match(/export interface \w+Props \{([\s\S]*?)\n\}/)?.[1] ?? "";
      const declared = [...body.matchAll(/^\s{2}(\w+)(\??):/gm)].map((m) => m[1] + m[2]).sort();
      const listed = [...(PREVIEWS as Record<string, { props: readonly string[] }>)[id]!.props].sort();
      expect({ id, props: listed }).toEqual({ id, props: declared });
    }
  });
});
