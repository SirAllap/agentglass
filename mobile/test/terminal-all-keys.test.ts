/*
 * The "All keys" sheet sends what the bar sends.
 *
 * A second place that can send bytes is a second place that can get one wrong,
 * and a wrong key does not look like a bug, it looks like the app ignoring you
 * (see keys.test.ts). So the sheet takes its bytes from the bar's own table
 * where a key is on both, builds the rest with the same encoder, and this file
 * states every byte literally — the ones that moved nowhere are the lock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ALL_KEYS } from "../src/terminal/allKeys.ts";
import { ACCESSORY_KEYS, sendFor } from "../src/terminal/keys.ts";
import { armedTip, NOTHING_HELD, press } from "../src/terminal/modifiers.ts";

const sheet = Object.fromEntries(ALL_KEYS.flatMap((g) => g.keys.map((k) => [k.label, k])));
const bytes = (label: string, held: Parameters<typeof sendFor>[1] = []): string | null => sendFor(sheet[label]!, held);

describe("the sheet's keys", () => {
  test("are the four groups of the mock, in order", () => {
    expect(ALL_KEYS.map((g) => g.title)).toEqual(["Control", "Move", "Symbols", "Function"]);
    expect(ALL_KEYS[0]!.keys.map((k) => k.label)).toEqual(["^C", "^D", "^Z", "^L", "^R", "^A", "^E", "^W"]);
    expect(ALL_KEYS[1]!.keys.map((k) => k.label)).toEqual(["Home", "End", "PgUp", "PgDn", "⇧Tab", "Del", "Ins", "⏎"]);
    expect(ALL_KEYS[2]!.keys.map((k) => k.label)).toEqual(["|", "~", "/", "\\", "-", "_", "`", "$"]);
    expect(ALL_KEYS[3]!.keys.map((k) => k.label)).toEqual(Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
  });

  test("send exactly the bytes the bar sends for the keys both have", () => {
    const bar = Object.fromEntries(ACCESSORY_KEYS.map((k) => [k.id, k.bytes]));
    for (const key of ALL_KEYS.flatMap((g) => g.keys)) {
      if (key.id in bar) expect(key.bytes, key.id).toBe(bar[key.id]);
    }
    expect(bytes("^C")).toBe("\x03");
    expect(bytes("^D")).toBe("\x04");
    expect(bytes("^Z")).toBe("\x1a");
    expect(bytes("^L")).toBe("\x0c");
    expect(bytes("^R")).toBe("\x12");
    expect(bytes("^A")).toBe("\x01");
    expect(bytes("^E")).toBe("\x05");
    expect(bytes("^W")).toBe("\x17");
    expect(bytes("Home")).toBe("\x1b[H");
    expect(bytes("End")).toBe("\x1b[F");
    expect(bytes("PgUp")).toBe("\x1b[5~");
    expect(bytes("PgDn")).toBe("\x1b[6~");
    expect(bytes("⇧Tab")).toBe("\x1b[Z");
    expect(bytes("Del")).toBe("\x1b[3~");
    expect(bytes("⏎")).toBe("\r");
  });

  test("the keys the bar never had are the terminal's own sequences", () => {
    expect(bytes("Ins")).toBe("\x1b[2~");
    expect(bytes("F1")).toBe("\x1bOP");
    expect(bytes("F4")).toBe("\x1bOS");
    expect(bytes("F5")).toBe("\x1b[15~");
    expect(bytes("F10")).toBe("\x1b[21~");
    expect(bytes("F12")).toBe("\x1b[24~");
    for (const symbol of ["|", "~", "/", "\\", "-", "_", "`", "$"]) expect(bytes(symbol)).toBe(symbol);
  });

  test("compose with a latched modifier as the bar's keys do, and refuse where the bar refuses", () => {
    const ctrl = ["ctrl" as const];
    expect(bytes("Home", ctrl)).toBe("\x1b[1;5H");
    expect(bytes("F5", ctrl)).toBe("\x1b[15;5~");
    // A control code IS a Ctrl press already; sending it plain under Ctrl would hide the modifier.
    expect(bytes("^C", ctrl)).toBeNull();
    // No control code for a pipe: null, never the plain character.
    expect(bytes("|", ctrl)).toBeNull();
    expect(bytes("/", ["alt"])).toBe("\x1b/");
  });

  test("every key names itself for a screen reader", () => {
    for (const key of ALL_KEYS.flatMap((g) => g.keys)) expect(key.spoken.length, key.id).toBeGreaterThan(2);
  });
});

describe("the bar sends what it always sent", () => {
  // The lock. The bar was made bigger, not different: these are the catalogue's
  // bytes, key by key, and a change to one is a change to what a press does.
  const GOLDEN: Record<string, string | undefined> = {
    escape: "\x1b", ctrlC: "\x03", up: "\x1b[A", down: "\x1b[B", tab: "\t", shiftTab: "\x1b[Z",
    ctrl: undefined, alt: undefined, shift: undefined,
    left: "\x1b[D", right: "\x1b[C", ctrlD: "\x04", ctrlZ: "\x1a", ctrlL: "\x0c", ctrlR: "\x12",
    ctrlA: "\x01", ctrlE: "\x05", ctrlW: "\x17", ctrlU: "\x15", ctrlK: "\x0b",
    backspace: "\x7f", delete: "\x1b[3~", home: "\x1b[H", end: "\x1b[F",
    pageUp: "\x1b[5~", pageDown: "\x1b[6~", enter: "\r",
  };

  test("key by key", () => {
    expect(ACCESSORY_KEYS.map((k) => k.id)).toEqual(Object.keys(GOLDEN));
    for (const key of ACCESSORY_KEYS) expect(key.bytes, key.id).toBe(GOLDEN[key.id]);
  });

  test("and the bar and the sheet go through one send", () => {
    const screen = readFileSync(new URL("../app/(tabs)/terminal.tsx", import.meta.url), "utf8");
    // One route: a press either way calls pressKey, which asks sendFor. A second
    // inline send in the screen would be a second place to get a byte wrong.
    expect(screen).toMatch(/const pressKey = \(key: AccessoryKey\)/);
    expect(screen.match(/onKey\(sends\)/g)?.length).toBe(1);
    expect(screen).toMatch(/onKey=\{pressKey\}/);
  });
});

describe("the tip above the bar", () => {
  test("says nothing while nothing is waiting", () => {
    expect(armedTip(NOTHING_HELD)).toBeNull();
  });

  test("says in words that the next key is changed, and how to keep it", () => {
    expect(armedTip(press(NOTHING_HELD, "ctrl"))).toBe("Ctrl is on for the next key. Tap it again to keep it on.");
  });

  test("a locked one says it stays until tapped off", () => {
    const locked = press(press(NOTHING_HELD, "ctrl"), "ctrl");
    expect(armedTip(locked)).toBe("Ctrl stays on until you tap it again.");
  });

  test("two at once, one of each kind", () => {
    const both = press(press(press(NOTHING_HELD, "alt"), "alt"), "shift");
    expect(armedTip(both)).toBe("Shift is on for the next key; Alt stays on until you tap it again.");
  });
});
