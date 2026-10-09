/*
 * How often the card watcher looks.
 *
 * Every look is two requests plus a comment read per changed card, and it ran
 * every three minutes whether or not anybody was looking at the app: 40
 * requests an hour at idle. Six minutes halves that; the interval is pinned
 * and the timer is asserted to use it, so the number cannot be edited in one
 * place and forgotten in the other.
 */
import { expect, test } from "bun:test";
import { WATCH_MS } from "../src/clickupwatch.ts";

const src = await Bun.file(new URL("../src/clickupwatch.ts", import.meta.url)).text();

test("the watcher looks every six minutes", () => {
  expect(WATCH_MS).toBe(6 * 60_000);
});

test("and the timer is the one that uses it", () => {
  expect(src).toContain("setInterval(() => { void tick(); }, WATCH_MS)");
});
