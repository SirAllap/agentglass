/*
 * The bench's floating button: when it shows is one pure decision, and the
 * setting that picks the mode is a low-class registry setting with a row.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { classOf } from "../../shared/settingClass.ts";
import { DEFAULT_FAB, FAB_MODES, fabVisible } from "../src/lib/benchStore.ts";

describe("the default spot", () => {
  it("starts below the Starboard's bottom panel header", () => {
    const HEADER = 88; // percent of the viewport height where that panel's header sits
    const top = DEFAULT_FAB.y - (38 / 2 / 1080) * 100; // the 38px button's top edge
    expect(top).toBeGreaterThan(HEADER + 2);
  });
});

describe("fabVisible", () => {
  it("always: shown with or without tabs", () => {
    expect(fabVisible("always", 0)).toBe(true);
    expect(fabVisible("always", 2)).toBe(true);
  });
  it("open: only while the bench holds tabs", () => {
    expect(fabVisible("open", 0)).toBe(false);
    expect(fabVisible("open", 1)).toBe(true);
  });
  it("never: hidden even with tabs", () => {
    expect(fabVisible("never", 0)).toBe(false);
    expect(fabVisible("never", 5)).toBe(false);
  });
  it("the three modes are the ones the row offers", () => {
    expect([...FAB_MODES]).toEqual(["always", "open", "never"]);
  });
});

describe("the setting", () => {
  it("is low class", () => {
    expect(classOf("terminal.benchButton")?.class).toBe("low");
  });
  it("has a row with the three options, hint read from the keymap", () => {
    const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
    const at = src.indexOf('settingId="terminal.benchButton"');
    expect(at).toBeGreaterThan(0);
    const row = src.slice(at, at + 700);
    expect(row).toContain('"Only when something is open"');
    expect(row).toContain('appChordFor("bench.toggle")');
  });
  it("the button returns null when not visible", () => {
    const src = readFileSync(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url), "utf8");
    expect(src).toContain("if (!fabVisible(st.fabMode, live)) return null;");
  });
});
