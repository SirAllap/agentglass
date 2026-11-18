/*
 * The hang watchdog: what is written down when the window stops answering.
 *
 * The report it exists for is a window frozen for over a minute with nothing in
 * `window.log` between 22:13 and 22:30. Two halves have to hold for the next
 * one to be explainable: the shell writes the pair of events only it can see
 * (a renderer that froze cannot report it), and the renderer writes the long
 * tasks it lived through with enough context to know which screen and pane.
 *
 * What these hold the code to:
 *   - the events are the window's, not a timer's;
 *   - a 400 ms task is not a line and a 500 ms one is;
 *   - one freeze is one line, not the burst Chromium delivers on waking;
 *   - neither half throws when the other is absent.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LONG_TASK_MS, longTaskLine, watchHangs, worthReporting } from "../src/lib/hangWatch.ts";

const main = readFileSync(join(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

describe("the shell's half", () => {
  test("is the window's own events, not a poll", () => {
    expect(main).toContain('win.on("unresponsive", () => noteHang(win, true));');
    expect(main).toContain('win.on("responsive", () => noteHang(win, false));');
    expect(main).toContain("const hangSince = new Map();");
    // A timer asking "is it still alive?" is the loop the house rule forbids.
    expect(main).not.toContain("setInterval(() => noteHang");
  });

  test("the pair is a duration, and the log says when it began", () => {
    expect(main).toContain("responsive after=${at - began}ms");
    expect(main).toContain("unresponsive since=");
  });

  test("the renderer's lines land in the same file", () => {
    expect(main).toContain('ipcMain.on("ag:windowLog"');
    expect(main).toContain("appendWindowLog(`${new Date().toISOString()} renderer ");
  });

  test("the heap it writes is the renderer's, not a stale bucket", () => {
    /* Chromium quantises performance.memory and updates it on a slow timer
       without this switch: measured, four shells moved V8's own heap 14 -> 36
       MB while the page-facing number stayed at 20. A hang report carrying the
       wrong heap is worse than one carrying none. */
    expect(main).toContain('app.commandLine.appendSwitch("enable-precise-memory-info");');
  });
});

describe("the renderer's half", () => {
  test("a 500 ms task is a line and a 499 ms one is not", () => {
    expect(LONG_TASK_MS).toBe(500);
    const at = { view: "term", pane: "2:1", memory: null, beganAt: 0 };
    const short = worthReporting([{ startTime: 1_000, duration: 499 }], -Infinity);
    expect(short.take.length).toBe(0);
    const long = worthReporting([{ startTime: 1_000, duration: 500 }], -Infinity);
    expect(long.take.length).toBe(1);
    expect(longTaskLine(long.take[0]!, at)).toContain("ms=500");
  });

  test("one freeze is one line, not the burst Chromium delivers on waking", () => {
    // A window that was stuck for a second arrives as several entries at once.
    const burst = [
      { startTime: 2_000, duration: 900 },
      { startTime: 2_100, duration: 800 },
      { startTime: 2_300, duration: 700 },
      { startTime: 3_200, duration: 600 },
    ];
    const r = worthReporting(burst, -Infinity);
    expect(r.take.map((e) => e.startTime)).toEqual([2_000, 3_200]);
  });

  test("says which view, which pane and how big the heap was", () => {
    const line = longTaskLine(
      { startTime: 0, duration: 612 },
      {
        view: "term",
        pane: "%12:1",
        beganAt: Date.UTC(2026, 10, 4, 22, 29),
        memory: { usedJSHeapSize: 312 * 1_048_576, totalJSHeapSize: 480 * 1_048_576, jsHeapSizeLimit: 4_096 * 1_048_576 },
      },
    );
    expect(line).toBe("longtask began=2026-11-04T22:29:00.000Z ms=612 view=term pane=%12:1 heap=312/480mb of 4096mb");
  });

  test("an unknown view and no performance.memory are said, not thrown over", () => {
    const line = longTaskLine({ startTime: 0, duration: 501 }, { view: "", pane: "", memory: null, beganAt: 0 });
    expect(line).toContain("view=- pane=- heap=-");
  });

  test("installing it outside the shell costs nothing and cannot throw", () => {
    // HAS_WINDOW_LOG is false here: no window log, no observer.
    expect(() => watchHangs()).not.toThrow();
  });
});
