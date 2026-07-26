// The effort dial, server side.
//
// `--effort` reaches a real CLI and changes what the user is billed for, so the
// value is taken from the CLI's own list or not passed at all. "Absent" is a
// deliberate third answer, not a missing one: someone who set an effort in
// their settings.json should not have every chat quietly overriding it.
import { test, expect } from "bun:test";
import { effortLevel } from "../src/chat.ts";
import { CHAT_EFFORTS } from "../../shared/types.ts";

// The pure validator rather than planTurn, following allowList's example: the
// whole plan depends on ambient git and workspace scope, which under `bun test`
// belongs to whichever file loaded config.ts first.

test("every level the CLI offers is accepted", () => {
  for (const e of CHAT_EFFORTS) expect(effortLevel(e)).toBe(e);
});

test("no effort means the CLI's own setting is left alone", () => {
  // Not defaulted to "high" or anything else — passing a flag the user never
  // asked for would silently override what they configured themselves.
  for (const absent of [undefined, null, ""]) expect(effortLevel(absent)).toBe("");
});

test("anything outside the list is dropped rather than forwarded", () => {
  // This lands on a `claude` command line. A value invented by a caller would
  // either be rejected by the CLI or, worse, quietly mean something else.
  for (const bad of ["highest", "HIGH", "max ", "; rm -rf /", 3, {}, ["max"]]) expect(effortLevel(bad)).toBe("");
});

test("the levels are ordered lowest first, because the UI reads position", () => {
  // The dial fills bars up to the index. If this array were ever reordered
  // alphabetically the meter would show `high` as more than `xhigh`.
  expect(CHAT_EFFORTS[0]).toBe("low");
  expect(CHAT_EFFORTS.indexOf("high")).toBeLessThan(CHAT_EFFORTS.indexOf("xhigh"));
  expect(CHAT_EFFORTS.indexOf("xhigh")).toBeLessThan(CHAT_EFFORTS.indexOf("max"));
  expect(CHAT_EFFORTS[CHAT_EFFORTS.length - 1]).toBe("ultracode");
});
