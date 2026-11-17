/*
 * The sleep inhibitor's decisions, with no logind and no child process.
 * A person who wants to suspend must win: the hard `block` mode is never
 * chosen for sleep, and "Let it sleep" lasts until the next agent turn.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error plain CommonJS module
import rules from "../../electron/power-rules.js";

describe("sleep mode by systemd version", () => {
  test("257 and later hold block-weak", () => {
    expect(rules.sleepModeFor(257)).toBe("block-weak");
    expect(rules.sleepModeFor(261)).toBe("block-weak");
  });
  test("before 257 there is no sleep lock, never block", () => {
    expect(rules.sleepModeFor(256)).toBeNull();
    expect(rules.sleepModeFor(252)).toBeNull();
  });
  test("unknown version tries block-weak; a refusal then removes the sleep lock", () => {
    expect(rules.sleepModeFor(null)).toBe("block-weak");
    expect(rules.sleepLockPlan({ version: null, weakRefused: true })).toEqual({ sleep: null, idle: true });
  });
  test("plan: old systemd keeps only the idle lock, new keeps sleep and no idle", () => {
    expect(rules.sleepLockPlan({ version: 255, weakRefused: false })).toEqual({ sleep: null, idle: true });
    expect(rules.sleepLockPlan({ version: 258, weakRefused: false })).toEqual({ sleep: "block-weak", idle: false });
  });
  test("parses systemctl --version", () => {
    expect(rules.parseSystemdVersion("systemd 257 (257.2-1)\n+PAM")).toBe(257);
    expect(rules.parseSystemdVersion("")).toBeNull();
    expect(rules.parseSystemdVersion("not systemd")).toBeNull();
  });
});

describe("let it sleep lasts until the next agent turn starts", () => {
  const r = rules.releaseStillApplies;
  test("stays released while the same turn keeps working", () => {
    expect(r({ released: true, wasWorking: true, working: true })).toBe(true);
  });
  test("stays released while idle", () => {
    expect(r({ released: true, wasWorking: false, working: false })).toBe(true);
    expect(r({ released: true, wasWorking: true, working: false })).toBe(true);
  });
  test("no baseline yet (polling just started): the first answer never ends it", () => {
    expect(r({ released: true, wasWorking: null, working: true })).toBe(true);
    expect(r({ released: true, wasWorking: null, working: false })).toBe(true);
  });
  test("ends when a turn starts: idle to working", () => {
    expect(r({ released: true, wasWorking: false, working: true })).toBe(false);
  });
  test("not released stays not released", () => {
    expect(r({ released: false, wasWorking: false, working: true })).toBe(false);
  });
});
