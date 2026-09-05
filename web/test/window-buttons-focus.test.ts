/*
 * The window buttons must not keep the keyboard.
 *
 * Reported three times as a maximised window that "se minimiza sola" — twice
 * right after pasting, and once with no paste at all, which is what ruled the
 * paste out. The log said the same thing every time: `asked=yes`, i.e. THIS app
 * asked for it, through the only control that can — the maximise button — with
 * no pointer anywhere near it.
 *
 * Measured in a real Electron window, a button wired to count its activations:
 *
 *   click it                                  → 1   (focus stays on the button)
 *   one Enter, typed nowhere near it          → 2
 *   a Space as well                           → 3
 *   the same button blurring after its click  → 1, and two Enters change nothing
 *
 * That is the whole bug: Chromium focuses a <button> when it is clicked, and a
 * focused button is activated again by Enter or Space. Pressing "maximise" once
 * arms every later Enter — a chat message, a shell command, a prompt — to
 * un-maximise the window. Close is the same gesture away from quitting the app.
 *
 * Source-level: `bun test` has no focus model, and the browser's half of this
 * was measured above rather than asserted here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const bar = readFileSync(join(import.meta.dir, "..", "src", "components", "TopBar.tsx"), "utf8");
const preload = readFileSync(join(import.meta.dir, "..", "..", "electron", "preload.js"), "utf8");
const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

describe("minimise, maximise and close", () => {
  test("all three let the keyboard go", () => {
    /* Not "the maximise one": close on a stale Enter quits the app, and
       minimise hides a window somebody is looking at. */
    expect((bar.match(/onClick=\{run\(/g) ?? []).length).toBe(3);
    expect(bar).toContain("e.currentTarget.blur();");
  });

  test("none of them is wired straight to the bridge any more", () => {
    // The shape that shipped the bug: onClick={WINDOW_CONTROLS.toggleMaximize}
    // — the handler is the bridge call, so nothing blurs anything.
    for (const which of ["minimize", "toggleMaximize", "close"]) {
      expect(bar).not.toContain(`onClick={WINDOW_CONTROLS.${which}}`);
    }
  });

  test("and the maximise button says how it was activated", () => {
    /* `detail=0` is a keyboard activation and `trusted=false` is a click nobody
       made — the two answers that would tell us this is not fixed, in the log
       rather than in a guess. */
    expect(bar).toContain("`detail=${e.detail} trusted=${e.isTrusted} focus=${focus}`");
    expect(preload).toContain("winToggleMaximize: (why) => ipcRenderer.invoke(\"ag:winToggleMaximize\", why)");
    expect(main).toContain("lastAsk = typeof why === \"string\" ? why.slice(0, 120) : \"\";");
    expect(main).toContain("why=${askedAt");
  });
});
