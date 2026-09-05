/*
 * What Refresh actually refreshes, and what it must not blank on the way.
 *
 * Reported with six screenshots: a line comment deleted on GitHub, Refresh
 * pressed in the pull request, and the comment still there — "I have to go back
 * to the PR board, open the PR again and now it is gone… but it should be
 * reactive in the PR detail too, without causing flickers or odd behaviour".
 *
 * Two defects in one sentence:
 *
 *   - The review GitHub is holding for you (its "pending review", the comments
 *     drafted in the browser) was fetched in an effect keyed on the open pull
 *     request alone. Refresh does not change which pull request is open, so
 *     that fetch never ran again — only leaving and coming back re-mounted it.
 *   - Refresh emptied the diff to make its effect run again, because "is the
 *     text empty?" WAS the has-it-been-fetched test. So the file you were
 *     reading went blank for as long as GitHub took.
 *
 * Both answer to one counter now: everything per-pull-request re-asks when it
 * changes, and nothing is cleared first — what is on screen stays until the new
 * answer replaces it.
 *
 * Source-level: this is about which dependency arrays and which guards exist,
 * and `bun test` has no React to run them in.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "components", "PrPanel.tsx"), "utf8");

describe("Refresh, inside a pull request", () => {
  test("re-reads the review GitHub is holding", () => {
    // The shape that shipped the bug: `}, [root, selected]);` under the
    // prPendingReview fetch.
    const at = src.indexOf("api.prPendingReview(");
    expect(at).toBeGreaterThan(0);
    const deps = src.slice(at, at + 900);
    expect(deps).toContain("}, [root, selected, detailTick]);");
  });

  test("and re-asks for the diff without emptying it first", () => {
    expect(src).toContain("const key = `${detail.number}:${detailTick}`;");
    expect(src).toContain("if (diffFetchedFor.current === key) return;");
    // The old test — an empty string standing in for "not fetched" — is what
    // forced the blanking, and it is gone from the effect's condition.
    expect(src).not.toContain("if ((tab !== \"files\" && tab !== \"review\") || !detail || diff || diffErr || !root) return;");
  });

  test("the button empties nothing", () => {
    /* Everything after `loadDetail(selected, true)` in the handler: a tick, and
       no `setDiff("")`. Three occurrences of that call exist in the file; the
       one on a change of pull request is the only one that may blank. */
    const at = src.indexOf("boardForce.current = true;");
    const handler = src.slice(at, at + 900);
    expect(handler).toContain("setDetailTick((n) => n + 1);");
    expect(handler).not.toContain('setDiff("")');
  });

  test("a push asks again rather than blanking too", () => {
    // Same rule one level along: the diff on screen is the old one, but a diff
    // beats a blank pane for the length of a fetch.
    const at = src.indexOf("if (!head || !diffHead.current || head === diffHead.current) return;");
    const effect = src.slice(at, at + 600);
    expect(effect).toContain("setDetailTick((n) => n + 1);");
    expect(effect).not.toContain('setDiff("")');
  });

  test("but a different pull request still starts empty", () => {
    /* The one place where clearing is right — the previous pull request's diff
       under this one's title would be a lie — and the fetch key is reset with
       it so the new one is actually fetched. */
    const at = src.indexOf("const held = heldDetail(root, selected);");
    const effect = src.slice(at, at + 800);
    expect(effect).toContain('setDiff("")');
    expect(effect).toContain('diffFetchedFor.current = "";');
  });
});
