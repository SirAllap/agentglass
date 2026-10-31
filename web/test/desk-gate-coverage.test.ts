/*
 * The server decides "is this the person" from the desk key on every route that
 * calls mayPublishReview, mayChangePolicy, mayHostBrowser or deskKeyOk, and the
 * window sends the key only on the routes deskGate.ts lists (or where api.ts
 * passes deskHeader() by hand). The two lists drifted twice: Flight plan's Go and
 * the agent rules were refused as an agent's in the desktop app while every test
 * stayed green. This reads the server's guards as source and fails on a guarded
 * route the window would call without its key.
 */
import { describe, expect, test } from "bun:test";
import { deskGated } from "../src/lib/deskGate.ts";

const server = (await Bun.file(new URL("../../server/src/index.ts", import.meta.url)).text()).split("\n");
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();

const GUARD = /\b(mayPublishReview|mayChangePolicy|mayHostBrowser|deskKeyOk)\(req\b/;
const isComment = (l: string) => /^\s*(\*|\/\/|\/\*)/.test(l);

/** The route a guard sits in: the nearest route test above it that opens a block (a one-line `return` route is a sibling, not the parent). */
function routeOf(i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const l = server[j]!;
    if (isComment(l) || (j < i && /\breturn\b/.test(l))) continue;
    const exact = /pathname === "([^"]+)"/.exec(l);
    if (exact) return exact[1]!;
    const prefix = /pathname\.startsWith\("([^"]+)"\)/.exec(l);
    if (prefix) return prefix[1]! + "x";
    const re = /\/\^(.+?)\$?\/\.exec\(pathname\)/.exec(l);
    if (re) {
      // A sample path: innermost groups first, an optional one dropped, any other one a single segment.
      let p = re[1]!.replace(/\\\//g, "/");
      while (/\([^()]*\)/.test(p)) p = p.replace(/\([^()]*\)(\?)?/g, (_, opt) => (opt ? "" : "x"));
      return p;
    }
  }
  return null;
}

/*
 * Guarded routes the window keys another way. Each says how, and the test checks
 * that it still does: either api.ts passes deskHeader() on that call, or the
 * guarded verbs inside a wider route are themselves on the list.
 */
const KEYED_ELSEWHERE: Record<string, { header?: string; verbs?: string[] }> = {
  "/orchestration": { header: '"/orchestration"' },
  "/browser/x": { header: '"/browser/ready"' },
  "/fs/x": { verbs: ["/fs/op"] },
  // Polaris writes (settings, a click on an item, a beacon send) pass deskHeader() by hand in api.ts; the desk key tests in polaris-card-source.test.ts cover the other two.
  "/polaris/x": { header: '"/polaris/settings"' },
  "/seat/x": { verbs: ["/seat/settings", "/seat/change", "/seat/wake"] },
  "/finder/devices": { verbs: ["/finder/devices/eject"] },
};

const guarded = new Map<string, number>();
server.forEach((l, i) => {
  if (!GUARD.test(l) || isComment(l) || /^\s*function /.test(l)) return;
  const r = routeOf(i);
  if (r && !guarded.has(r)) guarded.set(r, i + 1);
});

describe("every route the server asks the desk key on gets it from the window", () => {
  test("the scan finds the guards (a broken reader would pass vacuously)", () => {
    expect(guarded.size).toBeGreaterThan(30);
    expect(guarded.has("/flight-plan/plans/x")).toBe(true);
    expect(guarded.has("/agent-rules/x/answer")).toBe(true);
    expect(guarded.has("/agent-rules")).toBe(true);
  });

  test("each guarded route is on deskGate.ts, or keyed by hand as written above", () => {
    const missing: string[] = [];
    for (const [route, line] of guarded) {
      if (deskGated(route)) continue;
      const how = KEYED_ELSEWHERE[route];
      const ok = how && (how.header ? new RegExp(`${how.header}[^\\n]*deskHeader\\(\\)`).test(api) : how.verbs!.every(deskGated));
      if (!ok) missing.push(`${route} (index.ts:${line})`);
    }
    expect(missing).toEqual([]);
  });
});
