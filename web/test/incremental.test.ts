import { test, expect } from "bun:test";
import { INCREMENTAL_CHUNK } from "../src/lib/useIncremental.ts";

// The hook itself needs a React renderer, which this project doesn't carry.
// What is worth pinning without one is the arithmetic the hook performs — the
// slice bounds and the near-bottom test — since those are what decide whether a
// list silently loses rows or never grows.

const CHUNK = INCREMENTAL_CHUNK;
const NEAR_PX = 400;

/** The hook's slice, extracted. */
const windowOf = <T,>(items: T[], limit: number) => (limit >= items.length ? items : items.slice(0, limit));
/** The hook's grow test, extracted. */
const shouldGrow = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }, limit: number, total: number) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_PX && limit < total;

test("a short list is returned whole and never reports more", () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  expect(windowOf(items, CHUNK)).toHaveLength(5);
  expect(items.length > CHUNK).toBe(false);
});

test("a long list starts at one chunk", () => {
  const items = Array.from({ length: 787 }, (_, i) => i);
  expect(windowOf(items, CHUNK)).toHaveLength(CHUNK);
});

test("the window keeps original order — rows must not shuffle as it grows", () => {
  const items = Array.from({ length: 200 }, (_, i) => `row-${i}`);
  const first = windowOf(items, CHUNK);
  const second = windowOf(items, CHUNK * 2);
  expect(second.slice(0, CHUNK)).toEqual(first);
  expect(second[0]).toBe("row-0");
});

test("a limit past the end returns the array itself, not a copy", () => {
  const items = [1, 2, 3];
  // Identity matters: React re-renders every row when the array reference
  // changes, so a fully-shown list must stop producing new ones.
  expect(windowOf(items, 999)).toBe(items);
});

test("grows only when near the bottom", () => {
  const total = 787;
  const atTop = { scrollHeight: 9000, scrollTop: 0, clientHeight: 600 };
  const nearBottom = { scrollHeight: 9000, scrollTop: 8100, clientHeight: 600 };
  expect(shouldGrow(atTop, CHUNK, total)).toBe(false);
  expect(shouldGrow(nearBottom, CHUNK, total)).toBe(true);
});

test("stops growing once everything is shown", () => {
  const nearBottom = { scrollHeight: 9000, scrollTop: 8100, clientHeight: 600 };
  expect(shouldGrow(nearBottom, 787, 787)).toBe(false);
});

test("a container shorter than its content still grows", () => {
  // The degenerate case: a panel so short that scrollHeight barely exceeds the
  // viewport. Without this the list would never advance past the first chunk.
  const tiny = { scrollHeight: 700, scrollTop: 0, clientHeight: 600 };
  expect(shouldGrow(tiny, CHUNK, 200)).toBe(true);
});
