/*
 * The phone polls five things, and every one of them used to run flat out with
 * the tab hidden: gates and sessions every 4s, docker every 15s, working trees
 * every 30s, pull requests every 60s, and a transcript every 5s while a chat is
 * open. On a desk that is a handful of wasted requests. On a phone each tick is
 * a radio wake, which is the part that reaches a battery graph.
 *
 * Two properties, and the second is what makes the first safe: skip while
 * hidden, and catch up on the way back — but only if a tick was actually
 * missed, so tabbing away and straight back does not fire a burst.
 *
 * The last test is the one that matters over time. Fixing the five polls that
 * exist is worth little if the sixth is written the old way, so the rule is
 * asserted over the tree rather than over the five.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pollWhileVisible, type PollDoc } from "../src/lib/poll.ts";

/** A document whose visibility the test drives. */
function fakeDoc() {
  const listeners = new Set<() => void>();
  const d = {
    hidden: false,
    addEventListener: (_t: "visibilitychange", fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_t: "visibilitychange", fn: () => void) => { listeners.delete(fn); },
  } satisfies PollDoc;
  return {
    doc: d as PollDoc,
    hide: () => { d.hidden = true; for (const fn of listeners) fn(); },
    show: () => { d.hidden = false; for (const fn of listeners) fn(); },
    listeners,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pollWhileVisible", () => {
  test("runs while visible", async () => {
    const { doc } = fakeDoc();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 20, doc);
    await wait(90);
    stop();
    expect(n).toBeGreaterThan(1);
  });

  test("stops running while hidden", async () => {
    const { doc, hide } = fakeDoc();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 20, doc);
    await wait(70);
    const before = n;
    hide();
    await wait(120);
    stop();
    // Not "no more than before" — exactly before. A tick that fires while
    // hidden is the whole cost being removed.
    expect(n).toBe(before);
  });

  test("catches up once on the way back, having missed a tick", async () => {
    const { doc, hide, show } = fakeDoc();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 20, doc);
    await wait(50);
    hide();
    await wait(80); // several ticks skipped
    const hidden = n;
    show();
    stop();
    // Exactly one catch-up, not one per skipped tick: coming back from an hour
    // away must not fire an hour of requests.
    expect(n).toBe(hidden + 1);
  });

  test("does not catch up when nothing was missed", async () => {
    const { doc, hide, show } = fakeDoc();
    let n = 0;
    const stop = pollWhileVisible(() => n++, 10_000, doc);
    hide();
    show(); // away and back inside one interval
    stop();
    expect(n).toBe(0);
  });

  test("stopping removes the listener as well as the timer", async () => {
    const { doc, listeners } = fakeDoc();
    const stop = pollWhileVisible(() => {}, 20, doc);
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  test("with no document at all it still runs, rather than silently never", async () => {
    // A test environment or SSR. Failing closed here would turn "no DOM" into
    // "no polling", which is a much worse bug than a few extra requests.
    let n = 0;
    const stop = pollWhileVisible(() => n++, 20, null as unknown as PollDoc | undefined);
    await wait(70);
    stop();
    expect(n).toBeGreaterThan(1);
  });
});

describe("every poll on the phone goes through it", () => {
  // Fixing five polls is worth little if the sixth is written the old way.
  const MOBILE = join(import.meta.dir, "..", "src", "mobile");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") || p.endsWith(".ts") ? [p] : [];
    });

  test("no raw setInterval survives in the phone tree", () => {
    const offenders = files(MOBILE)
      .filter((f) => /\bsetInterval\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(MOBILE.length + 1));
    // The message names the fix, because the person who trips this will be
    // adding a poll and will not know this rule exists.
    expect(offenders, "use pollWhileVisible() — a raw setInterval polls a phone that nobody is looking at").toEqual([]);
  });
});
