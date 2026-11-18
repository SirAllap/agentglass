/*
 * A plugin's card carries the picture its market listing ships. Installed
 * cards look it up by the repository a market install came from; a plugin
 * installed from a folder or its own URL is not the market's to picture.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { marketEntry } from "../src/components/PluginsPane.tsx";
import type { Catalogue, PublicPlugin } from "../../shared/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url), "utf8");

const entry = { id: "orbit-notes", source: { kind: "git" as const, url: "https://github.com/acme/orbit-notes.git", ref: null }, description: "d", categories: [], preview: "https://raw.githubusercontent.com/acme/orbit-notes/main/preview.png" };
const catalogue: Catalogue = { name: "acme", owner: "acme", plugins: [entry], total: 1, skipped: 0 };
const market = { kind: "marketplace", marketplace: { url: "https://example.test/plugins.json" }, plugin: { url: "https://github.com/acme/orbit-notes/", ref: null } };
const plugin = (source: unknown) => ({ source }) as PublicPlugin;

describe("which picture an installed card gets", () => {
  test("a market install takes the listing's picture, ignoring .git and a trailing slash", () => {
    expect(marketEntry(plugin(market), catalogue)?.preview).toBe(entry.preview);
  });
  test("a folder or git install gets none, and neither does a missing catalogue", () => {
    expect(marketEntry(plugin({ kind: "local-path", path: "/x" }), catalogue)).toBeNull();
    expect(marketEntry(plugin({ kind: "git", url: entry.source.url, ref: null }), catalogue)).toBeNull();
    expect(marketEntry(plugin(market), null)).toBeNull();
  });
});

describe("the picture is drawn where the listing is drawn", () => {
  test("both cards render it from the entry's own preview", () => {
    /* Settings v4: catalogue entries are one row, no art. The component stays for other callers. */
    // The installed row is compact and has no art; its "View more" modal and the Market tile draw the picture from the entry's own preview.
    expect(src("PluginsPane.tsx")).toContain("<PluginPreview src={preview}");
    expect(src("plugins/Market.tsx")).toContain("<PluginPreview src={entry.preview}");
  });
  test("a missing or blocked picture is a tile with the mark on it, never a broken image, and the host is not told who asked", () => {
    const p = src("plugins/PluginPreview.tsx");
    expect(p).toContain("const shown = safe && broken !== safe");
    expect(p).toContain("onError={() => setBroken(safe)}");
    expect(p).toMatch(/: children\}/);
    expect(p).toContain('referrerPolicy="no-referrer"');
  });
  test("an installed plugin gets the mark on its tile, a listing gets its initial", () => {
    expect(src("PluginsPane.tsx")).toMatch(/<PluginPreview src=\{preview\} name=\{plugin\.name\} tint=\{tint\}><PluginMark/);
    expect(src("plugins/Market.tsx")).toMatch(/<PluginPreview src=\{entry\.preview\} name=\{title\} tint=\{tint\}>\s*<span[^>]*>\{initial\}/);
  });
});

describe("a card waiting on a decision", () => {
  test("is a row with a tinted band under it: amber for an approval, red stopped, blue update, the fix inside", () => {
    // Mockup v2: the band is an inset box under the row, edged and tinted in its own hue, holding its one fix button.
    const p = src("PluginsPane.tsx");
    expect(p).toContain("<Band band={band} action={");
    expect(p).toContain('<div className="agx-plug-band" data-band={band}>');
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toContain(".agx-plug-band { --hue: var(--warning);");
    expect(css).toContain('.agx-plug-band[data-band="stopped"] { --hue: var(--error); }');
    expect(css).toContain('.agx-plug-band[data-band="update"] { --hue: var(--info); }');
    expect(css).toMatch(/\.agx-plug-band \{[^}]*border: 1px solid color-mix\(in srgb, var\(--hue\)/);
  });
  test("the page and the nav count the same tally", () => {
    // The nav's open-time count and the page's chips both come from tallyInstalled (no approval-only count).
    expect(src("SettingsModal.tsx")).toContain("tallyInstalled(plugs, () => false)");
    expect(src("SettingsModal.tsx")).not.toContain("x.approvedFingerprint !== x.fingerprint");
  });
});
