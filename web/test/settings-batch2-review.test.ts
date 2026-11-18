/*
 * The batch-2 review of Plugins and Remote & devices: the approval and stopped
 * bands live on the list, the plugin modal owns focus, and the link strip names
 * paired phones rather than whatever addresses connected. Invented names only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { trapTarget } from "../src/components/plugins/PluginModal.tsx";

const at = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");

describe("a plugin that needs you says why on the list", () => {
  const src = at("../src/components/PluginsPane.tsx");
  test("the band is drawn before the modal, not inside it", () => {
    const band = src.indexOf("{band && (");
    const modal = src.indexOf("{viewing && (");
    expect(band).toBeGreaterThan(0);
    expect(band).toBeLessThan(modal);
    expect(src.indexOf("<PluginWhyStopped plugin={plugin} />")).toBeLessThan(modal);
    expect(src.indexOf("This plugin is asking for something different now.")).toBeLessThan(modal);
  });
  test("the approval band has its own way into the review", () => {
    // The band's fix is the review itself: setEnabled(true) opens the declaration before anything runs.
    const band = src.slice(src.indexOf("{band && ("), src.indexOf("{viewing && ("));
    // With the system off it still opens the details window to read what it declares (never a dead button).
    expect(band).toMatch(/band === "approval" \? <Button tone="primary" disabled=\{busy\} onClick=\{\(\) => \(masterOn \? void setEnabled\(true\) : setViewing\(true\)\)\}>Review and switch on…<\/Button>/);
    expect(band).toContain("onClick={() => setViewing(true)}");
  });
});

describe("the plugin modal owns focus", () => {
  const el = (id: string) => ({ id }) as unknown as HTMLElement;
  const [a, b, c] = [el("a"), el("b"), el("c")];
  test("Tab on the last wraps to the first, Shift+Tab on the first to the last", () => {
    expect(trapTarget([a, b, c], c, false)).toBe(a);
    expect(trapTarget([a, b, c], a, true)).toBe(c);
  });
  test("focus outside the dialog is pulled in; inside the middle is left to the browser", () => {
    expect(trapTarget([a, b, c], null, false)).toBe(a);
    expect(trapTarget([a, b, c], null, true)).toBe(c);
    expect(trapTarget([a, b, c], b, false)).toBeNull();
    expect(trapTarget([], null, false)).toBeNull();
    expect(trapTarget([a], a, false)).toBe(a);
  });
  test("it focuses itself on open and gives focus back to the opener on close", () => {
    const src = at("../src/components/plugins/PluginModal.tsx");
    expect(src).toContain("box.current?.focus();");
    expect(src).toContain("if (opener?.isConnected) opener.focus();");
    expect(src).toContain("ref={box} tabIndex={-1} role=\"dialog\"");
  });
});

describe("the link strip names paired phones, not connections", () => {
  test("peer comes from the paired list PairPanel reports", () => {
    const page = at("../src/components/settings/pages/RemoteDevicesPage.tsx");
    expect(page).toContain("peer={peerLabel(pairedNames)}");
    expect(page).not.toContain("peerLabel(seen");
    const panel = at("../src/components/PairPanel.tsx");
    expect(panel).toContain("state.devices.filter((d) => !d.revokedAt).map((d) => d.label)");
  });
});
