/*
 * Every `Sheet` (ui.tsx) is a `Modal`, and a `Modal` mounts into its own
 * native root — a screen-level `KeyboardAvoidingView` never sees that
 * subtree move, so it pads a keyboard that is covering something else
 * entirely.
 *
 * MEASURED on a Pixel 7 emulator, Android 15, edge-to-edge: the card
 * "Comment" sheet's field sat at y≈1854-2106 while the keyboard started at
 * y≈1510, and "Post it" was unreachable until the keyboard was dismissed.
 * There is no renderer in this project, so what is asserted is the source
 * fact that fixes it: `Sheet` wraps its content in its own
 * `KeyboardAvoidingView`, inside the `Modal`, with `behavior="padding"` on
 * both platforms (an Android `Platform`-conditional is the same silent
 * failure `keyboard-inset.test.ts` guards against for a screen).
 */
import { describe, expect, test } from "bun:test";

const ui = await Bun.file(new URL("../src/ui.tsx", import.meta.url)).text();

/** The `Sheet` function's own body, sliced to its closing brace — never a
 *  fixed window, so a change elsewhere in the file cannot make this pass or
 *  fail for the wrong reason. */
function sheetBody(source: string): string {
  const at = source.indexOf("export function Sheet(");
  if (at === -1) throw new Error("Sheet not found");
  const open = source.indexOf("{", source.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("Sheet's closing brace not found");
}

const sheet = sheetBody(ui);

describe("Sheet rises above the keyboard", () => {
  test("it is a Modal", () => {
    expect(sheet).toContain("<Modal");
  });

  test("its content is wrapped in a KeyboardAvoidingView", () => {
    expect(sheet).toContain("<KeyboardAvoidingView");
  });

  test("padding, on both platforms, never Platform-conditional", () => {
    for (const match of sheet.matchAll(/behavior=\{[^}]*\}/g)) {
      expect(match[0]).not.toMatch(/Platform|undefined/);
    }
    expect(sheet).toContain('behavior="padding"');
  });

  // Wrapped around the sheet alone, the avoider has no height, the sheet's
  // maxHeight "75%" resolves against nothing and the sheet is drawn half off
  // the bottom of the screen (Settings › computer sheet lost its last two
  // buttons). The avoider fills the Modal and holds the scrim too.
  test("the avoider fills the Modal and holds the scrim, not just the sheet", () => {
    const avoider = sheet.indexOf("<KeyboardAvoidingView");
    expect(sheet.slice(avoider, sheet.indexOf(">", avoider))).toContain("flex: 1");
    expect(sheet.indexOf("SCRIM")).toBeGreaterThan(avoider);
  });

  test("the scroll view inside still takes a tap while the keyboard is up", () => {
    expect(sheet).toContain('keyboardShouldPersistTaps="handled"');
  });
});
