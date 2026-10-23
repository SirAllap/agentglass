/*
 * Pinned folders: what is read back from storage and what a toggle does. A
 * pin is a path the person chose, so whatever else is in the stored value
 * (a number, a relative path, a duplicate) is dropped on the way in.
 */
import { describe, expect, test } from "bun:test";
import { PIN_MAX, readPins, togglePin, writePins } from "../src/lib/finderPins.ts";

describe("pins", () => {
  test("a missing or broken value is no pins", () => {
    expect(readPins(null)).toEqual([]);
    expect(readPins("{not json")).toEqual([]);
    expect(readPins('{"a":1}')).toEqual([]);
  });
  test("only absolute paths survive, once each, in order", () => {
    expect(readPins(JSON.stringify(["/h/a", 5, "rel/x", "/h/a", "/h/b/"]))).toEqual(["/h/a", "/h/b"]);
  });
  test("the filesystem root is never a pin", () => {
    expect(readPins(JSON.stringify(["/", "/h"]))).toEqual(["/h"]);
  });
  test("a toggle adds at the end, and removes", () => {
    expect(togglePin(["/h/a"], "/h/b")).toEqual(["/h/a", "/h/b"]);
    expect(togglePin(["/h/a", "/h/b"], "/h/a")).toEqual(["/h/b"]);
  });
  test("the list has a ceiling and keeps the oldest", () => {
    const full = Array.from({ length: PIN_MAX }, (_, i) => `/h/${i}`);
    expect(togglePin(full, "/h/new")).toEqual(full);
  });
  test("what is written reads back", () => {
    expect(readPins(writePins(["/h/a", "/h/b"]))).toEqual(["/h/a", "/h/b"]);
  });
});
