/*
 * What the card screen promises about its Status row, asserted against its
 * source (there is no renderer here).
 *
 *   - The row opens the sheet only for a phone that may write, and only with
 *     statuses to show; a locked row has no handler at all.
 *   - The horizontal strip of status chips is gone: a choice of statuses is a
 *     sheet, and the strip cut "Blocked" off.
 *   - "Move it anyway" is the only write that sends a stamp other than the
 *     card's own, and it sends the one the dialog was built from.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the status row", () => {
  test("has a handler only when the phone may write and there is a list to choose from", () => {
    expect(code).toMatch(/onPress=\{access\.can && statuses\.length && !busy \? \(\) => setChoosing\(true\) : undefined\}/);
  });

  test("shows a lock, not a chevron, when the phone may not", () => {
    expect(code).toContain('access.can ? "chevron" : access.why ? "lock" : null');
  });

  test("the chip strip it replaces is gone", () => {
    expect(code).not.toContain("Move to ${m.status}");
    expect(code).not.toMatch(/ScrollView horizontal/);
  });
});

describe("the conflict dialog", () => {
  test("overwrites with the stamp of the card it described", () => {
    expect(code).toContain("void move(c.wanted, { stamp: c.stamp })");
    expect(code).toContain("stamp: theirs.updated");
  });

  test("keeping theirs writes nothing", () => {
    expect(code).toContain("onKeep={() => { setConflict(null); setAssignConflict(null); }}");
  });
});
