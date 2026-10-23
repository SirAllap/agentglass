/*
 * "Open" on an installed plugin card switches the app to the plugin's own
 * panel underneath, but Settings drew on top of it — the switch happened,
 * invisibly, behind a modal that never moved. Fixed by reusing the same
 * close App's "Back to app" button already uses (see lib/openSettings.ts),
 * not the "esc" control command, which peels other overlays but never
 * touches Settings.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const at = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const openSettingsSrc = at("../src/lib/openSettings.ts");
const appSrc = at("../src/App.tsx");
const paneSrc = at("../src/components/PluginsPane.tsx");

describe("closeSettings is the same one-slot bus idiom as openSettings", () => {
  test("declared with an install hook, mirroring onOpenSettings", () => {
    expect(openSettingsSrc).toContain("export function onCloseSettings(fn: (() => void) | null): () => void {");
    expect(openSettingsSrc).toContain("export function closeSettings(): void {");
  });

  test("App wires it to the exact body onClose already runs", () => {
    expect(appSrc).toContain("onCloseSettings(() => { setSettingsOpen(false); setSettingsJump(null); })");
  });

  test("the Open button on a plugin card calls it", () => {
    const open = paneSrc.slice(paneSrc.indexOf("const openIt = "));
    expect(open.slice(0, open.indexOf(";\n"))).toContain("closeSettings()");
    expect(paneSrc).toContain("onClick={openIt}");
  });
});
