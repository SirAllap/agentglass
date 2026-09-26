/*
 * The pull request and issue lists paint only the latest read.
 *
 * Both ask up to eight repositories at once and a chip or filter tap starts a
 * new read while the last is still out. Without a check after the await, a
 * slow answer for the filter just left landed on top of the current one.
 * Asserted against source: the check sits between the await and the first
 * state write, inside `load` itself.
 */
import { describe, expect, test } from "bun:test";

const screens = {
  prs: await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text(),
  issues: await Bun.file(new URL("../app/(tabs)/issues.tsx", import.meta.url)).text(),
};

function loadBody(src: string): string {
  const at = src.indexOf("const load = useCallback(async (");
  expect(at).toBeGreaterThan(-1);
  // The deps array varies per screen (prs also depends on its state chip).
  const end = src.slice(at).search(/\n  \}, \[host, shown, filter[^\]]*\]\);/) + at;
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe("a list paints only its latest read", () => {
  for (const [name, src] of Object.entries(screens)) {
    test(name, () => {
      const body = loadBody(src);
      const took = body.indexOf("const mine = ++asked.current;");
      const awaited = body.indexOf("await Promise.all(");
      const checked = body.indexOf("if (mine !== asked.current) return;");
      const firstWrite = body.search(/\bset[A-Z]\w*\(/);
      expect(took).toBeGreaterThan(-1);
      expect(awaited).toBeGreaterThan(took);
      expect(checked).toBeGreaterThan(awaited);
      expect(firstWrite).toBeGreaterThan(checked);
    });
  }
});
