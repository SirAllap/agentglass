// Which key opens find in the terminal, and which keys belong to the shell (#8).
//
// The panel sits around a real PTY, so any chord it takes is a chord the
// program inside no longer gets. Ctrl+F is the obvious one to bind and the one
// that cannot be bound: readline reads it as forward-char, and less, vim and
// emacs page forward on it.
import { describe, expect, test } from "bun:test";
import { isFindChord } from "../src/lib/termKeys.ts";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ...mods });

describe("the find chord", () => {
  test("Ctrl+Shift+F opens find", () => {
    expect(isFindChord(key("F", { ctrlKey: true, shiftKey: true }))).toBe(true);
    // Some layouts report the unshifted key alongside the shift flag.
    expect(isFindChord(key("f", { ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  test("Cmd+F opens find, because Cmd is the app's and not the shell's", () => {
    expect(isFindChord(key("f", { metaKey: true }))).toBe(true);
  });

  test("plain Ctrl+F stays with the shell", () => {
    expect(isFindChord(key("f", { ctrlKey: true }))).toBe(false);
  });

  test("Alt+F stays with the shell, shift or not", () => {
    expect(isFindChord(key("f", { altKey: true }))).toBe(false);
    expect(isFindChord(key("F", { altKey: true, ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  test("f on its own is just typing", () => {
    expect(isFindChord(key("f"))).toBe(false);
    expect(isFindChord(key("F", { shiftKey: true }))).toBe(false);
  });

  test("another letter with the same modifiers is not find", () => {
    expect(isFindChord(key("g", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isFindChord(key("c", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
