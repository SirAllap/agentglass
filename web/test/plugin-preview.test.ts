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
const catalogue: Catalogue = { name: "acme", owner: "acme", plugins: [entry], total: 1 };
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
    expect(src("PluginsPane.tsx")).toMatch(/<PluginPreview src=\{preview\}/);
    expect(src("PluginsPane.tsx")).toContain("preview={marketEntry(p, catalogue)?.preview}");
    expect(src("plugins/Market.tsx")).toMatch(/<PluginPreview src=\{entry\.preview\}/);
  });
  test("a missing or broken picture draws nothing, and the host is not told who asked", () => {
    const p = src("plugins/PluginPreview.tsx");
    expect(p).toMatch(/if \(!src \|\| broken === src\) return null/);
    expect(p).toContain('referrerPolicy="no-referrer"');
  });
});
