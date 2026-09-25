/**
 * The pane routes share one in-flight tmux spawn across concurrent pollers.
 *
 * Desktop, phone and an extra tab each poll `/agent/sessions`, `/tree` and the
 * pane-hover routes on their own timer; two of them landing in the same
 * instant used to spawn tmux twice for an answer already on its way. Fixed by
 * wrapping each call in `singleFlight` (singleflight.ts already dedupes
 * overlapping work generically and is proven there), keyed on the known
 * socket -- and, for the per-window routes, the window too, since two windows
 * polled at once must not share one answer.
 *
 * There is no renderer in this project and no seam to run these routes
 * without a live server; the rule is asserted against the source that
 * `bun build` actually ships, the way tmux-prefix-heal.test.ts does for the
 * sweep's healPrefix call.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();

/** The call, wherever it is: `singleFlight(...)` wrapping the given tmuxctl
 *  call within the next 200 characters, i.e. right there at the call site and
 *  not merely present somewhere else in the file. */
function coalesced(call: string): boolean {
  const at = src.indexOf(call);
  if (at < 0) return false;
  const before = src.slice(Math.max(0, at - 200), at);
  return before.includes("singleFlight(");
}

describe("pane routes coalesce concurrent listPanes/panesWithPids/activePane", () => {
  test("both listPanes(lastTmuxTarget()?.socket) call sites are wrapped", () => {
    const calls = [...src.matchAll(/listPanes\(lastTmuxTarget\(\)\?\.socket\)/g)];
    // The `authorsNow` call site (panesHeld) has its own 10s TTL cache already
    // and is not one of the two route call sites this fix targets.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const m of calls) {
      const before = src.slice(Math.max(0, m.index! - 200), m.index!);
      const isAuthorsNow = before.includes("panesHeld");
      if (isAuthorsNow) continue;
      expect(before).toContain("singleFlight(");
    }
  });

  test("panesWithPids(lastTmuxTarget()?.socket, win) is wrapped", () => {
    expect(coalesced("panesWithPids(lastTmuxTarget()?.socket, win)")).toBe(true);
  });

  test("activePane(lastTmuxTarget()?.socket, win) is wrapped", () => {
    expect(coalesced("activePane(lastTmuxTarget()?.socket, win)")).toBe(true);
  });
});
