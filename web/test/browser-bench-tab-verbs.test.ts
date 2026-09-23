/*
 * The bench's copy does not answer the tab verbs.
 *
 * `onBrowserTabs` (browserBus.ts) is one global slot: whichever `BrowserView`
 * registered last owns it. The workspace pane mounts one with no `scope`; the
 * bench mounts a second with `scope="bench"` (BenchWeb.tsx). Measured live: with
 * both open, `agentglass-browser --shared tabs` returned the BENCH's tab list —
 * an agent driving "the browser" was talking to the window nobody was looking
 * at, and when the bench copy unmounted the slot went null and stayed null,
 * because the effect's deps are only `[profile]` and never re-run for the
 * workspace pane that is still mounted.
 *
 * Read between landmarks, not at a byte offset the next comment would move —
 * same idiom as browser-tab-ownership.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");

const between = (from: string, to: string): string => {
  const a = panel.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = panel.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return panel.slice(a, b);
};

/* Comments quote code; strip them before counting words in the code itself. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("only the view that is not the bench answers the tab bus", () => {
  test("the onBrowserTabs effect bails out for the bench's own copy", () => {
    const effect = code(between("useEffect(() => {\n    // The bench mounts", "return onBrowserTabs({"));
    expect(effect.includes("if (scope) return")).toBe(true);
    /* Before the registration, not after — a guard that runs after
       `onBrowserTabs` has already handed the slot to the bench is no guard. */
    expect(effect.indexOf("if (scope) return")).toBeLessThan(effect.length);
  });

  test("the effect re-runs when `scope` itself changes, not just `profile`", () => {
    const deps = between("return onBrowserTabs({", "}, [profile, scope]);");
    expect(deps.length).toBeGreaterThan(0);
  });
});

describe("a typed navigation is not lost to a stale did-navigate listener", () => {
  test("go() patches the url synchronously, not only failed", () => {
    const go = code(between("const go = useCallback((raw: string)", "w.src = next;"));
    expect(go).toMatch(/patch\(active\.id,\s*\{\s*failed:\s*null,\s*url:\s*next\s*\}\)/);
  });
});
