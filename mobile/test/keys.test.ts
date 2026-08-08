/*
 * The bytes the key bar sends.
 *
 * Every one of these is a sequence a terminal has understood since the VT100,
 * and getting one wrong does not look like a bug — it looks like the app
 * ignoring you. A wrong arrow prints `[A` into the line you were editing; a
 * wrong Ctrl+C types a letter at a prompt while the command keeps running.
 *
 * So the table is asserted literally, and the generator is asserted against the
 * cases that are easy to get subtly wrong: the modifier parameter is 1-based,
 * unmodified F1–F4 are SS3 rather than CSI, and Ctrl over a character that has
 * no control code has to REFUSE rather than quietly send the character.
 */
import { describe, expect, test } from "bun:test";
import { ACCESSORY_KEYS, keyBytes, prefixKey } from "../src/terminal/keys.ts";

const byId = (id: string): string => {
  const key = ACCESSORY_KEYS.find((k) => k.id === id);
  if (!key) throw new Error(`no key ${id}`);
  return key.bytes;
};

describe("the bar", () => {
  test("sends what a terminal expects", () => {
    expect(byId("escape")).toBe("\x1b");
    expect(byId("tab")).toBe("\t");
    expect(byId("shiftTab")).toBe("\x1b[Z");
    expect(byId("enter")).toBe("\r");
    expect(byId("up")).toBe("\x1b[A");
    expect(byId("down")).toBe("\x1b[B");
    expect(byId("right")).toBe("\x1b[C");
    expect(byId("left")).toBe("\x1b[D");
    expect(byId("backspace")).toBe("\x7f");
    expect(byId("delete")).toBe("\x1b[3~");
    expect(byId("ctrlC")).toBe("\x03");
    expect(byId("ctrlD")).toBe("\x04");
    expect(byId("ctrlZ")).toBe("\x1a");
  });

  test("does NOT hardcode a tmux prefix", () => {
    /*
     * It used to carry `^B`, which is tmux's default and was wrong on the
     * first machine this was ever pointed at — that one is `C-f`. A prefix
     * button that sends the wrong key does nothing visible, which reads as the
     * feature being broken rather than as a setting being different.
     *
     * The real one arrives on the terminal socket and is built by prefixKey.
     */
    expect(ACCESSORY_KEYS.some((k) => k.bytes === "\x02")).toBe(false);
  });

  test("marks as repeatable only what is safe to hold down", () => {
    const repeat = ACCESSORY_KEYS.filter((k) => k.repeatable).map((k) => k.id).sort();
    expect(repeat).toEqual(["backspace", "delete", "down", "left", "pageDown", "pageUp", "right", "up"]);
    // The rule, stated as an assertion: nothing that runs a command or changes
    // a mode repeats. A stuck finger must not be able to send four interrupts.
    for (const key of ACCESSORY_KEYS) {
      if (key.repeatable) expect(key.bytes, key.id).not.toBe("\r");
      if (/^ctrl/.test(key.id)) expect(key.repeatable ?? false, key.id).toBe(false);
    }
  });

  test("every key says what it is out loud", () => {
    // `⌫` and `^C` are not readable by a screen reader, and `^` is not a word.
    for (const key of ACCESSORY_KEYS) {
      expect(key.spoken.length, key.id).toBeGreaterThan(2);
      expect(key.bytes.length, key.id).toBeGreaterThan(0);
    }
    expect(new Set(ACCESSORY_KEYS.map((k) => k.id)).size).toBe(ACCESSORY_KEYS.length);
  });

  test("opens with what a thumb reaches for first", () => {
    /*
     * The bar scrolls, so the order is the design: whatever is past the fold
     * is effectively not there.
     *
     * Seven, because seven is what fits — measured on a 411dp screen with the
     * prefix key present and the two width pills pinned at the end. This used
     * to assert the first three and the fold fell after the FIFTH, which is how
     * Ctrl+C and both horizontal arrows ended up behind a swipe while the file
     * that ordered them said they were the ones that had to be reachable.
     */
    const fold = ACCESSORY_KEYS.slice(0, 6).map((k) => k.id);
    expect(fold).toEqual(["escape", "ctrlC", "up", "down", "tab", "shiftTab"]);
  });

  test("the keys that are narrow are the ones that are one glyph", () => {
    // 36dp instead of 44 is under the tap target, so it is spent only where the
    // label cannot want the width — and it is what pays for the seventh key.
    const narrow = ACCESSORY_KEYS.filter((k) => k.narrow).map((k) => k.id).sort();
    expect(narrow).toEqual(["down", "left", "right", "up"]);
    for (const key of ACCESSORY_KEYS) {
      if (key.narrow) expect(key.label.length, key.id).toBe(1);
    }
  });
});

describe("tmux's prefix, as tmux spells it", () => {
  test("the default, and the one this was first pointed at", () => {
    expect(prefixKey("C-b")?.bytes).toBe("\x02");
    expect(prefixKey("C-f")?.bytes).toBe("\x06");
    expect(prefixKey("C-a")?.bytes).toBe("\x01");
  });

  test("meta, and combinations", () => {
    expect(prefixKey("M-x")?.bytes).toBe("\x1bx");
    expect(prefixKey("C-M-x")?.bytes).toBe("\x1b\x18");
  });

  test("reads as what it is", () => {
    expect(prefixKey("C-f")?.label).toBe("^F");
    expect(prefixKey("C-f")?.spoken).toContain("prefix");
  });

  test("nothing at all when there is nothing to send", () => {
    // No tmux on the other end, or a prefix this cannot encode. A button that
    // sends the wrong bytes is worse than an absent one.
    expect(prefixKey(undefined)).toBeNull();
    expect(prefixKey("")).toBeNull();
    expect(prefixKey("C-")).toBeNull();
    expect(prefixKey("C-1")).toBeNull();
  });
});

describe("a key the bar does not have", () => {
  test("control codes from letters", () => {
    expect(keyBytes("c", ["ctrl"])).toBe("\x03");
    expect(keyBytes("a", ["ctrl"])).toBe("\x01");
    expect(keyBytes("z", ["ctrl"])).toBe("\x1a");
    // Case is not a second meaning: Ctrl+Shift+C is still 0x03 at this layer.
    expect(keyBytes("C", ["ctrl"])).toBe("\x03");
  });

  test("alt is a prefixed escape, which is what meta has always meant", () => {
    expect(keyBytes("b", ["alt"])).toBe("\x1bb");
    expect(keyBytes("f", ["alt"])).toBe("\x1bf");
    expect(keyBytes("backspace", ["alt"])).toBe("\x1b\x7f");
  });

  test("modified cursor keys use the 1-based parameter", () => {
    // The off-by-one people hit: no modifiers is 1, not 0 — and an unmodified
    // key drops the parameter altogether rather than sending `1`.
    expect(keyBytes("up")).toBe("\x1b[A");
    expect(keyBytes("up", ["ctrl"])).toBe("\x1b[1;5A");
    expect(keyBytes("up", ["shift"])).toBe("\x1b[1;2A");
    expect(keyBytes("right", ["alt"])).toBe("\x1b[1;3C");
    expect(keyBytes("left", ["ctrl", "shift"])).toBe("\x1b[1;6D");
  });

  test("F1 to F4 are SS3 until something modifies them", () => {
    expect(keyBytes("f1")).toBe("\x1bOP");
    expect(keyBytes("f4")).toBe("\x1bOS");
    expect(keyBytes("f1", ["ctrl"])).toBe("\x1b[1;5P");
    // F5 and up were never SS3.
    expect(keyBytes("f5")).toBe("\x1b[15~");
    expect(keyBytes("f12", ["shift"])).toBe("\x1b[24;2~");
  });

  test("shift-tab is reverse tab rather than a modified tab", () => {
    expect(keyBytes("tab", ["shift"])).toBe("\x1b[Z");
  });

  test("refuses rather than dropping a modifier it cannot encode", () => {
    /*
     * The assertion that matters most here. Ctrl+E has a control code; Ctrl+1
     * does not. Sending a plain "1" because the modifier could not be applied
     * types a character into whatever is on screen while the person believes
     * they sent a command — which is the worst of the three possible outcomes,
     * behind both "nothing" and "an error".
     */
    expect(keyBytes("1", ["ctrl"])).toBeNull();
    expect(keyBytes("é", ["ctrl"])).toBeNull();
    expect(keyBytes("")).toBeNull();
    expect(keyBytes("notakey")).toBeNull();
  });

  test("punctuation that does have one", () => {
    expect(keyBytes("[", ["ctrl"])).toBe("\x1b");
    expect(keyBytes("\\", ["ctrl"])).toBe("\x1c");
    expect(keyBytes(" ", ["ctrl"])).toBe("\x00");
    expect(keyBytes("space", ["ctrl"])).toBe("\x00");
  });
});
