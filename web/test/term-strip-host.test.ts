/*
 * The strip's keyboard doors: Alt+1..9 and the three app chords that the
 * Terminal strip answers (Go list, next window that needs you, new shell).
 */
import { describe, expect, test } from "bun:test";
import { altDigit } from "../src/lib/termKeys.ts";
import { registerStripDoors, runStripChord, stripUp } from "../src/lib/termStripHost.ts";
import { APP_CHORD_DEFAULTS, appActionForChord } from "../src/lib/keybindings.ts";

const key = (code: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
  ({ code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

describe("Alt+digit", () => {
  test("Alt+1..9 picks a number, by the physical key", () => {
    expect(altDigit(key("Digit1", { altKey: true }))).toBe(1);
    expect(altDigit(key("Digit9", { altKey: true }))).toBe(9);
  });
  test("not 0, not a bare digit, and not with another modifier (Ctrl+Alt+1..4 are the pane doors)", () => {
    expect(altDigit(key("Digit0", { altKey: true }))).toBeNull();
    expect(altDigit(key("Digit1"))).toBeNull();
    expect(altDigit(key("Digit1", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(altDigit(key("Digit1", { altKey: true, shiftKey: true }))).toBeNull();
    expect(altDigit(key("Digit1", { altKey: true, metaKey: true }))).toBeNull();
  });
});

describe("the doors", () => {
  test("with no strip on screen nothing answers, so the chord falls through", () => {
    expect(stripUp()).toBe(false);
    expect(runStripChord("goList")).toBe(false);
    expect(runStripChord("needYou")).toBe(false);
    expect(runStripChord("newShell")).toBe(false);
  });

  test("the strip on screen answers, and gives the doors back when it goes", () => {
    const seen: string[] = [];
    const off = registerStripDoors({ goList: () => seen.push("go"), needYou: () => { seen.push("need"); return false; }, newShell: () => seen.push("new") });
    expect(stripUp()).toBe(true);
    expect(runStripChord("goList")).toBe(true);
    expect(runStripChord("newShell")).toBe(true);
    // Nothing waits: the chord is not eaten.
    expect(runStripChord("needYou")).toBe(false);
    expect(seen).toEqual(["go", "new", "need"]);
    off();
    expect(stripUp()).toBe(false);
  });

  test("an older strip going away does not take the doors from the newer one", () => {
    const a = registerStripDoors({ goList: () => {}, needYou: () => true, newShell: () => {} });
    const b = registerStripDoors({ goList: () => {}, needYou: () => true, newShell: () => {} });
    a();
    expect(stripUp()).toBe(true);
    b();
    expect(stripUp()).toBe(false);
  });
});

describe("the chords", () => {
  test("Ctrl+Alt+N jumps to the window that needs you, Ctrl+Shift+T opens a shell", () => {
    expect(APP_CHORD_DEFAULTS["windows.waiting"]).toBe("mod+alt+n");
    expect(APP_CHORD_DEFAULTS["terminal.newshell"]).toBe("mod+shift+t");
    expect(appActionForChord("mod+alt+n")).toBe("windows.waiting");
    expect(appActionForChord("mod+shift+t")).toBe("terminal.newshell");
  });
});
