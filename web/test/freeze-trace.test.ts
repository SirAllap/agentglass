/*
 * The freeze trace: a frozen window, a stalled main thread or a stalled
 * server each leave a line that says what happened, instead of the silent
 * gap the report ("6 lines, no unresponsive, nothing from main or the
 * server") was about.
 *
 * What these hold the code to:
 *   - the stall math (drift, threshold, rotation) is pure, so it is tested
 *     here rather than through a real timer or real files;
 *   - `unresponsive` tries for the renderer's own call stack;
 *   - a dead renderer/GPU process is its own line, not folded into a hang;
 *   - the main-process stall probe is one timer, not a poll of anything.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");
// `require`, not an ES import: the module is plain CommonJS (electron/main.js
// itself is), and a `.js` with no declaration file is otherwise a tsc error.
const { INTERVAL_MS, STALL_MS, ROTATE_BYTES, ROTATE_KEEP, lagOf, isStall, rotationPaths, shouldRotate } =
  createRequire(import.meta.url)("../../electron/stallProbe.js");

describe("the stall math (pure)", () => {
  test("lag is how much later than scheduled now is, never negative", () => {
    expect(lagOf(1000, 1000)).toBe(0);
    expect(lagOf(1000, 1700)).toBe(700);
    expect(lagOf(1000, 900)).toBe(0); // a clock that ran backwards is not a stall
  });

  test("a stall is a lag past the threshold, not at it", () => {
    expect(isStall(STALL_MS)).toBe(false);
    expect(isStall(STALL_MS + 1)).toBe(true);
    expect(isStall(0)).toBe(false);
  });

  test("the tick is two seconds, the threshold 500ms", () => {
    expect(INTERVAL_MS).toBe(2000);
    expect(STALL_MS).toBe(500);
  });

  test("rotation is needed only past the cap", () => {
    expect(shouldRotate(ROTATE_BYTES, ROTATE_BYTES)).toBe(false);
    expect(shouldRotate(ROTATE_BYTES + 1, ROTATE_BYTES)).toBe(true);
  });

  test("the rename plan shifts oldest-overwrite last, keeping 3 files", () => {
    const plan = rotationPaths("window.log", ROTATE_KEEP);
    expect(plan).toEqual([
      ["window.log.1", "window.log.2"],
      ["window.log", "window.log.1"],
    ]);
  });
});

describe("renderer hang stack", () => {
  test("unresponsive tries to collect the renderer's own call stack", () => {
    expect(main).toContain("frame.collectJavaScriptCallStack");
    expect(main).toContain("async function noteHang(win, unresponsive)");
    // Still the pair the shell alone can report, stack is additive.
    expect(main).toContain("unresponsive since=");
  });

  test("a missing/old-Electron API is a null stack, never a throw", () => {
    expect(main).toContain('typeof frame.collectJavaScriptCallStack !== "function"');
    expect(main).toContain("} catch { return null; }");
  });
});

describe("process-gone lines", () => {
  test("a dead renderer logs reason and exit code", () => {
    expect(main).toContain('win.webContents.on("render-process-gone"');
    expect(main).toContain("render-process-gone reason=${details.reason} exitCode=${details.exitCode}");
  });

  test("a dead GPU/utility process is app-wide, registered once", () => {
    expect(main).toContain('app.on("child-process-gone"');
    expect(main).toContain("child-process-gone type=${details.type}");
  });
});

describe("main-process stall probe", () => {
  test("one timer, armed once at startup — not a poll of anything external", () => {
    expect(main).toContain("function startMainStallProbe()");
    expect(main).toContain("startMainStallProbe();");
    expect(main).toContain("stallProbe.isStall(lag)");
    expect(main).toContain("main stall ms=${lag} last=${lastIpcChannel}");
  });

  test("the last IPC channel is tracked once, wrapping ipcMain itself", () => {
    expect(main).toContain("ipcMain.on = (channel, listener) =>");
    expect(main).toContain("ipcMain.handle = (channel, listener) =>");
    expect(main).toContain("lastIpcChannel = channel;");
  });
});
