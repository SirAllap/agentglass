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

/*
 * AND THE SERVER'S OWN LAST WORDS, which used to live nowhere.
 *
 * The sidecar's stderr was kept in memory to paint in the banner at the top of
 * the window, and nowhere else. So a crash explained itself exactly once, in a
 * strip that a popover can cover — and restarting the app, which is what the
 * banner tells you to do, threw the explanation away. Reported after a SIGILL
 * from the runtime: by the time anybody went looking there was nothing on the
 * machine to read.
 */
describe("a server that dies leaves its words behind", () => {
  test("the failure is written to a file, not only to the banner", () => {
    expect(main).toContain("function writeSidecarLog(failure) {");
    expect(main).toContain('path.join(app.getPath("userData"), "server.log")');
    // From reportSidecar, which is the one place that learns of a failure.
    expect(main).toContain("if (failure) writeSidecarLog(failure);");
  });

  test("it appends, because the second crash is often the one that names the cause", () => {
    expect(main).toContain("fs.appendFileSync(file,");
    expect(main).toMatch(/writeSidecarLog[\s\S]*?fs\.appendFileSync/);
  });

  test("it is capped, so a sidecar dying in a loop cannot fill a disk", () => {
    expect(main).toContain("const SERVER_LOG_MAX =");
    expect(main).toContain("fs.statSync(file).size > SERVER_LOG_MAX");
  });

  test("it never throws — a log nobody can write must not break the app that is already failing", () => {
    const body = main.slice(main.indexOf("function writeSidecarLog"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("try {");
  });
});
