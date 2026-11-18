/**
 * The renderer's half of the hang watchdog.
 *
 * A window that freezes writes nothing, because the thing that would write is
 * the thing that stopped. The shell can see it from the outside and logs the
 * pair `unresponsive`/`responsive` (electron/main.js, alongside the window
 * events); this adds the one fact the shell cannot know: HOW MUCH OF IT WAS THE
 * MAIN THREAD. Chromium reports every task that held it for over 50 ms as a
 * `longtask`, so the ones over 500 ms are kept — a fifth of a second is slow,
 * half a second is the freeze people report — with the view, the focused pane
 * and the renderer's heap as it is when the thread can answer again.
 *
 * Both ends land in the same `window.log`, so one read tells the story: what
 * held the thread, and whether the thread was held long enough for Chromium to
 * call the window unresponsive.
 *
 * Cheap, and deliberately: event-driven only. No timer, no poll, no request —
 * the observer fires after the person has already waited, which is the only
 * moment this costs anything at all. A browser tab has no window log and
 * installs nothing.
 */
import { HAS_WINDOW_LOG, noteWindowLog } from "./desktop.ts";

/** A task slower than this is worth a line. */
export const LONG_TASK_MS = 500;
/** A window that wakes from a freeze reports its long tasks in a burst; one
 *  line a second is enough to see it, and the alternative is a hundred lines
 *  for one freeze. */
export const MIN_GAP_MS = 1_000;

/** `performance.memory` is Chromium's, non-standard and absent elsewhere. */
export interface MemoryFacts {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface LongTask {
  startTime: number;
  duration: number;
}

let view = "";
let pane = "";
let lastBeganAt = -Infinity;
let installed = false;
let observer: PerformanceObserver | null = null;

/** Which view the shell is showing. Called on every change; one assignment. */
export function noteActiveView(id: string): void { view = id; }
/** The pane the keyboard is in: the tmux `window:pane` when the window is
 *  split, otherwise the shell's own id. */
export function noteFocusedPane(id: string): void { pane = id; }

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

/** The line one long task writes. `beganAt` is passed by the caller so a test
 *  need not depend on the page clock. */
export function longTaskLine(entry: LongTask, at: { view: string; pane: string; memory?: MemoryFacts | null; beganAt: number }): string {
  const heap = at.memory
    ? `${mb(at.memory.usedJSHeapSize)}/${mb(at.memory.totalJSHeapSize)}mb of ${mb(at.memory.jsHeapSizeLimit)}mb`
    : "-";
  return `longtask began=${new Date(at.beganAt).toISOString()} ms=${Math.round(entry.duration)} `
    + `view=${at.view || "-"} pane=${at.pane || "-"} heap=${heap}`;
}

/** The entries worth a line, one per second of the page's own clock. Pure but
 *  for reading the mark it is handed, so a burst can be tested without a real
 *  freeze. */
export function worthReporting(entries: readonly LongTask[], since: number): { take: LongTask[]; lastAt: number } {
  let last = since;
  const take: LongTask[] = [];
  for (const e of entries) {
    if (!(e.duration >= LONG_TASK_MS)) continue;
    if (e.startTime - last < MIN_GAP_MS) continue;
    last = e.startTime;
    take.push(e);
  }
  return { take, lastAt: last };
}

function memoryNow(): MemoryFacts | null {
  try {
    const m = (performance as unknown as { memory?: MemoryFacts }).memory;
    return m && typeof m.usedJSHeapSize === "number" ? m : null;
  } catch { return null; }
}

/** Install the observer. Idempotent, and a no-op where nothing reads the log:
 *  a browser tab and a shell older than this keep their idle budget. */
export function watchHangs(): void {
  if (installed || !HAS_WINDOW_LOG || typeof PerformanceObserver === "undefined") return;
  installed = true;
  try {
    observer = new PerformanceObserver((list) => {
      const at = performance.now();
      const r = worthReporting(list.getEntries(), lastBeganAt);
      lastBeganAt = r.lastAt;
      if (!r.take.length) return;
      const mem = memoryNow();
      for (const e of r.take) {
        noteWindowLog(longTaskLine(e, { view, pane, memory: mem, beganAt: Date.now() - (at - e.startTime) }));
      }
    });
    // `buffered` catches a freeze during the first paint, before this ran.
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // No `longtask` support in this engine: the shell's own pair of events is
    // still the watchdog, and it costs nothing to have tried.
    installed = false;
    observer = null;
  }
}
