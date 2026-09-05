/*
 * When the window stops being maximised, something has to write it down.
 *
 * Reported as "if I paste what I have in the clipboard it shrinks and stays
 * like that" — a maximised window back at its normal size after a paste. Nothing in
 * the app asks for that: the only two callers of `unmaximize` are the window
 * button and the context menu. So it is the window manager, an extension, or a
 * relaunch that came back differently — and from the outside, after the fact,
 * those are indistinguishable. An isolated Electron window with the same
 * frameless shape was driven through a real paste here and stayed maximised, so
 * the answer is not "Electron does this".
 *
 * What the log has to carry, and what these tests hold it to:
 *   - whether THIS process asked (the button, the menu), so "we did it" and
 *     "it was done to us" are never confused;
 *   - whether a keyboard chord had just arrived — Ctrl+V is the whole question;
 *   - what the relaunch made of the saved state, because every install of this
 *     app kills the running one and reopens it.
 *
 * And one line this file exists to keep out: a plain keystroke. A diagnostic
 * that records what somebody typed is a keylogger with a nicer name, so only
 * chords are recorded, and only their modifiers plus a key name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

describe("the window log", () => {
  test("writes on the transition that was reported, not on every resize", () => {
    /* `resize` fires continuously through a drag and would drown the file;
       leaving maximised happens once and is the thing being explained. */
    expect(main).toContain('win.on("unmaximize", () => noteWindow("unmaximize", win));');
    expect(main).not.toContain('win.on("resize", () => noteWindow');
  });

  test("says whether this process asked for it", () => {
    // Both callers stamp it — a log that cannot tell the button apart from the
    // window manager answers nothing.
    expect((main.match(/askedAt = Date\.now\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(main).toContain("asked=${askedAt && Date.now() - askedAt < 3000");
  });

  test("records chords only, never what was typed", () => {
    /* The guard is the point of the line: without `ctrl || input.alt` this
       would be every keystroke in the app, saved to disk. */
    expect(main).toContain("if (ctrl || input.alt) lastChord =");
    expect(main).toContain("key: String(input.key).slice(0, 12)");
  });

  test("and what the relaunch made of the saved state", () => {
    // Every install kills the running app and reopens it, so "the window
    // changed on its own" may be a new window that came back differently.
    expect(main).toContain('noteWindow(`opened wanted-max=${st.max === true}`, win)');
    expect(main).toContain("re-maximised after open");
  });

  test("the file is capped, like the popup log beside it", () => {
    expect(main).toContain("WINDOW_LOG_MAX");
    expect(main).toContain("fs.statSync(file).size > WINDOW_LOG_MAX");
  });
});
