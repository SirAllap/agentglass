/*
 * The "waiting on you" panel: when it stays open and where it is drawn.
 */
import { describe, expect, it } from "bun:test";
import { NEEDS_PANEL_W, needsPanelLeft, needsStaysOpen } from "../src/lib/needsPanel.ts";
import { LAYER } from "../src/lib/layers.ts";

const topBar = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();
const popover = await Bun.file(new URL("../src/components/NeedsPopover.tsx", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("needsStaysOpen", () => {
  it("stays open while something it was opened for is still waiting", () => {
    expect(needsStaysOpen(["wait:a", "wait:b"], ["wait:b"])).toBe(true);
  });
  it("closes once everything it was opened for has cleared", () => {
    expect(needsStaysOpen(["wait:a"], [])).toBe(false);
  });
  it("does not reopen for a later, unrelated alert", () => {
    // The flag used to outlive its alerts, so the next one drew the panel by
    // itself. An alert that arrives after the panel was opened is not one it
    // was opened for.
    expect(needsStaysOpen(["wait:a"], ["wait:z"])).toBe(false);
  });
});

describe("needsPanelLeft", () => {
  const W = 1600;
  it("centres under the chip when there is room", () => {
    expect(needsPanelLeft({ left: 700, width: 200 }, W, 1300)).toBe(800 - NEEDS_PANEL_W / 2);
  });
  it("ends before the bar's right-hand group, which holds the plan usage", () => {
    const left = needsPanelLeft({ left: 1000, width: 400 }, W, 1250);
    expect(left + NEEDS_PANEL_W).toBeLessThanOrEqual(1250);
  });
  it("never leaves the window on the left, even when that means overlapping", () => {
    expect(needsPanelLeft({ left: 50, width: 100 }, 500, 200)).toBe(8);
  });
  it("without a right group, stays inside the window", () => {
    const left = needsPanelLeft({ left: 1500, width: 100 }, W, null);
    expect(left + NEEDS_PANEL_W).toBeLessThanOrEqual(W);
  });
});

describe("wiring", () => {
  it("the panel sits on its own layer, under every sheet and menu", () => {
    expect(LAYER.needs).toBeGreaterThan(LAYER.palette);
    expect(LAYER.needs).toBeLessThan(LAYER.catalog);
    expect(code(popover)).toContain("<Portal z={LAYER.needs}>");
  });
  it("the panel closes when the window loses focus to a webview or iframe", () => {
    expect(code(popover)).toContain('window.addEventListener("blur", onBlur)');
    expect(code(popover)).toContain('window.removeEventListener("blur", onBlur)');
  });
  it("the bar closes the panel once what it was opened for clears", () => {
    const c = code(topBar);
    expect(c).toMatch(/needsStaysOpen\(needsFor\.current/);
    expect(c).toContain("avoidRef={rightRef}");
  });
});
