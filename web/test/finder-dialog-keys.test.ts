/*
 * A dialog keeps the keys it edits with and lets the app's chords through:
 * stopping every key at the Trash list swallowed Ctrl+Shift+P.
 */
import { describe, expect, test } from "bun:test";
import { isAppChord } from "../src/lib/finderKeys.ts";

const read = (f: string) => Bun.file(new URL(`../src/components/finder/machine/${f}`, import.meta.url)).text();
const ops = await read("FinderOpsUI.tsx");
const vol = await read("VolumeDialogs.tsx");
const hook = await read("useDialogEscape.ts");

describe("isAppChord", () => {
  const k = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) => ({ ctrlKey: false, metaKey: false, shiftKey: false, ...o });
  test("Ctrl+Shift and Meta+Shift are the app's", () => { expect(isAppChord(k({ ctrlKey: true, shiftKey: true }))).toBe(true); expect(isAppChord(k({ metaKey: true, shiftKey: true }))).toBe(true); });
  test("typing, Ctrl+A and Shift alone stay in the dialog", () => { expect(isAppChord(k({}))).toBe(false); expect(isAppChord(k({ ctrlKey: true }))).toBe(false); expect(isAppChord(k({ shiftKey: true }))).toBe(false); });
});

describe("no dialog stops a key unconditionally", () => {
  test("every key handler asks first", () => {
    for (const t of [ops, vol]) {
      expect(t).not.toMatch(/onKeyDown=\{\(e\) => \{ e\.stopPropagation\(\);/);
      expect(t).toContain("if (!isAppChord(e)) e.stopPropagation();");
    }
  });
});

describe("Escape closes a dialog alone", () => {
  // The Network list has nothing to autofocus, so a key handler on the dialog never saw Escape and the Finder behind it closed too.
  test("the hook listens on window in the capture phase and stops the key", () => {
    expect(hook).toContain('addEventListener("keydown", on, true)');
    expect(hook).toContain("e.stopPropagation()");
  });
  test("every dialog of VolumeDialogs and the Sheet use it", () => {
    for (const fn of ["PassphraseDialog", "ErrorDialog", "NetworkDialog", "ConnectDialog"]) {
      const at = vol.indexOf(`export function ${fn}(`);
      expect(at).toBeGreaterThan(-1);
      const next = vol.indexOf("\nexport function ", at + 1);
      expect(vol.slice(at, next < 0 ? undefined : next)).toContain("useDialogEscape(");
    }
    const sheetAt = ops.indexOf("export function Sheet(");
    expect(ops.slice(sheetAt, ops.indexOf("\n}\n", sheetAt))).toContain("useDialogEscape(");
  });
});
