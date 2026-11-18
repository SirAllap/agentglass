/*
 * A REUSED %id IS NOT THE SAME PANE.
 *
 * tmux renumbers panes from %0 on a fresh server, so after a restart an
 * unrelated pane can get the %id an adopted seat's row still names. Liveness
 * alone (`AgentOps.paneLiveness`) cannot tell: the id exists either way. This
 * is the pure decision `seatPaneVerdict` makes from the two reads
 * `adoptedPaneVerdict` takes — no tmux here, just the four shapes a real read
 * can come back in.
 */
import { describe, expect, test } from "bun:test";
import { seatPaneVerdict } from "../src/seat.ts";

describe("seatPaneVerdict", () => {
  test("same pid.start_time: alive", () => {
    expect(seatPaneVerdict("alive", "123.456", "123.456")).toBe("alive");
  });

  test("the %id is on the engine but answers to a different pid.start_time: dead (reused id)", () => {
    expect(seatPaneVerdict("alive", "123.456", "789.456")).toBe("dead");
  });

  test("the engine confirmed the %id is gone: dead, whatever the stored identity", () => {
    expect(seatPaneVerdict("dead", "123.456", null)).toBe("dead");
    expect(seatPaneVerdict("dead", "", null)).toBe("dead");
  });

  test("the engine could not be asked: unknown, never a match or a mismatch", () => {
    expect(seatPaneVerdict("unknown", "123.456", null)).toBe("unknown");
  });

  test("the %id is alive but its identity could not be read: unknown", () => {
    expect(seatPaneVerdict("alive", "123.456", null)).toBe("unknown");
  });

  test("a row adopted before this column existed (no stored identity): unknown, never treated as a match", () => {
    expect(seatPaneVerdict("alive", "", "123.456")).toBe("unknown");
  });
});
