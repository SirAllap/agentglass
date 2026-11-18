/*
 * Settings > Plugins against mockup v2: the layout decisions pulled out of
 * the screen. The rail lists Plugin system, Installed (count) and Market
 * (count), and a count change re-renders the rail.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marketRailCount, marketSummary, tileChip } from "../src/lib/pluginCard.ts";
import { sameEntries } from "../src/components/settings/shell/shellRules.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");

describe("On this page rail", () => {
  test("Market shows its listed count, offline when unreachable, nothing while reading", () => {
    expect(marketRailCount("ok", 18)).toBe("18");
    expect(marketRailCount("error", 0)).toBe("offline");
    expect(marketRailCount("loading", 0)).toBeUndefined();
  });
  test("the Market line says what is listed, or where the list comes from", () => {
    expect(marketSummary("ok", 18, 12)).toBe("18 plugins · 12 not installed");
    expect(marketSummary("ok", 1, 0)).toBe("1 plugin · 0 not installed");
    expect(marketSummary("error", 0, 0)).toBe("Plugins listed on this project's plugin page.");
  });
  test("a changed count is a changed rail", () => {
    const a = [{ id: "plugins-installed", title: "Installed", kind: "normal" as const, count: "1" }];
    expect(sameEntries(a, [{ ...a[0]!, count: "1" }])).toBe(true);
    expect(sameEntries(a, [{ ...a[0]!, count: "2" }])).toBe(false);
  });
  test("Market is a section the rail finds, and Installed carries its count", () => {
    expect(src("components/plugins/Market.tsx")).toMatch(/data-section="plugins-market"[^>]*data-section-count=\{marketRailCount\(/);
    expect(src("components/PluginsPane.tsx")).toMatch(/id="plugins-installed" title="Installed" count=\{/);
    expect(src("components/settings/shell/SettingsPage.tsx")).toContain('attributeFilter: ["data-section-count"]');
  });
});

describe("Plugin system card", () => {
  test("the master switch is in the card head, not a row under the tally", () => {
    const pane = src("components/PluginsPane.tsx");
    expect(pane).toContain('<Toggle settingId="plugins.master" label="Plugins may run"');
    expect(pane).not.toMatch(/settingId="plugins\.master"\s+label="Plugins"\s/);
  });
});

describe("Market tile head", () => {
  const css = src("index.css");
  const rule = (sel: string) => css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? "";
  test("an installed or updatable tile carries its chip; one to install has none", () => {
    expect(tileChip("installed")).toEqual({ tone: "ok", label: "Installed" });
    expect(tileChip("update")).toEqual({ tone: "info", label: "Update available" });
    expect(tileChip("install")).toBeNull();
  });
  test("long name + chip: the chip wraps to its own line, the name never breaks per letter", () => {
    expect(rule(".agx-mtile-hd")).toContain("flex-wrap: wrap");
    expect(rule(".agx-mtile-who")).toMatch(/min-width: 128px/);
    expect(rule(".agx-mtile-name")).toContain("overflow-wrap: break-word");
    expect(rule(".agx-mtile-name")).not.toContain("anywhere");
    expect(rule(".agx-mtile-by")).toContain("text-overflow: ellipsis");
    expect(rule(".agx-mtile-chip")).toContain("flex: none");
  });
  test("two tiles a row at most", () => {
    expect(css).not.toMatch(/\.agx-plugin-grid \{ grid-template-columns: repeat\(3/);
  });
});

describe("Installed card rows", () => {
  const pane = src("components/PluginsPane.tsx");
  const css = src("index.css");
  test("group labels with counts show from two plugins, in Needs you / Running / Off order", () => {
    expect(pane).toMatch(/plugins\.length > 1 && <div className="agx-plug-group"><span>\{g\.label\}<\/span><span className="tabular-nums">\{g\.items\.length\}<\/span>/);
  });
  test("tool row is one wide field and Refresh, the install row has the dashed plus mark", () => {
    expect(pane).toContain('<SearchRow agentExempt label="Find a plugin"');
    expect(css).toMatch(/\.agx-plug-plus \{[^}]*border: 1\.5px dashed var\(--border2\)/);
    expect(css).toMatch(/\.agx-plug-add \{[^}]*grid-template-columns: 40px minmax\(0, 1fr\) auto/);
  });
  test("bands sit under the name column with the fix inside", () => {
    expect(css).toMatch(/\.agx-plug-bandrow \{ padding: 0 14px 12px 66px; \}/);
    expect(pane).toContain('<div className="agx-plug-band-act">{action}</div>');
  });
  test("Market search has its own row", () => {
    expect(css).toMatch(/\.agx-msearch \{[^}]*flex: 1 1 100%/);
  });
});
