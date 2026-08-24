/*
 * Keys somebody added themselves.
 *
 * The rules that matter here are the ones about what is REFUSED, because a
 * malformed custom key does not throw — it reaches the bar, where it is a
 * blank button that does nothing, or a stored value from an older build that
 * takes the whole strip down with it.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_CUSTOM, MAX_LABEL, add, bytesFor, mintId, parseCustom, problemWith, remove, tidy,
  type CustomKey,
} from "../src/terminal/customKeys.ts";

const key = (over: Partial<CustomKey> = {}): CustomKey =>
  ({ id: "custom:a", label: "st", text: "git status", enter: true, ...over });

describe("what makes a key worth keeping", () => {
  test("a good one has no problem", () => {
    expect(problemWith(key())).toBeNull();
  });

  test("a blank label is refused", () => {
    // It would draw a key nobody can hit on purpose.
    expect(problemWith(key({ label: "" }))).toBeTruthy();
    expect(problemWith(key({ label: "   " }))).toBeTruthy();
  });

  test("a long label is refused", () => {
    // A word wearing a key's clothes pushes everything after it off the fold.
    expect(problemWith(key({ label: "x".repeat(MAX_LABEL) }))).toBeNull();
    expect(problemWith(key({ label: "x".repeat(MAX_LABEL + 1) }))).toBeTruthy();
  });

  test("empty text is refused", () => {
    // It would draw a key that does nothing when it IS hit.
    expect(problemWith(key({ text: "" }))).toBeTruthy();
  });

  test("the reason is a sentence, not a boolean", () => {
    expect(typeof problemWith(key({ text: "" }))).toBe("string");
  });
});

describe("trimming", () => {
  test("the label is trimmed", () => {
    expect(tidy(key({ label: "  st  " })).label).toBe("st");
  });

  test("the text is NOT", () => {
    // A trailing space is how somebody writes a prefix they mean to finish
    // typing — `git checkout ` — and eating it makes the key worse in a way
    // that is hard to see.
    expect(tidy(key({ text: "git checkout " })).text).toBe("git checkout ");
  });
});

describe("the list", () => {
  test("adding keeps what was there", () => {
    const one = add([], key());
    expect(add(one, key({ id: "custom:b" }))).toHaveLength(2);
  });

  test("a bad one does not go in", () => {
    expect(add([], key({ text: "" }))).toEqual([]);
  });

  test("the cap holds", () => {
    // Not a storage limit — the keystore would hold hundreds. Past a dozen the
    // thing being scrolled is the problem this screen exists to solve.
    let list: CustomKey[] = [];
    for (let i = 0; i < MAX_CUSTOM + 5; i++) list = add(list, key({ id: `custom:${i}` }));
    expect(list).toHaveLength(MAX_CUSTOM);
  });

  test("removing takes one and leaves the rest", () => {
    const list = add(add([], key()), key({ id: "custom:b" }));
    expect(remove(list, "custom:a").map((k) => k.id)).toEqual(["custom:b"]);
  });

  test("removing something that is not there changes nothing", () => {
    const list = add([], key());
    expect(remove(list, "nope")).toEqual(list);
  });
});

describe("ids", () => {
  test("they are namespaced so they cannot collide with a built-in", () => {
    // The layout's order and hidden set hold both kinds.
    expect(mintId(Date.now(), Math.random()).startsWith("custom:")).toBe(true);
  });

  test("two minted in the same millisecond differ", () => {
    const now = 1_700_000_000_000;
    expect(mintId(now, 0.1)).not.toBe(mintId(now, 0.9));
  });
});

describe("reading what was stored", () => {
  test("a round trip keeps the keys", () => {
    const list = [key(), key({ id: "custom:b", label: "cl", text: "/clear", enter: false })];
    expect(parseCustom(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });

  test("anything that is not a list is none", () => {
    expect(parseCustom(null)).toEqual([]);
    expect(parseCustom("nope")).toEqual([]);
    expect(parseCustom({ id: "x" })).toEqual([]);
  });

  test("one bad row costs that row, not the ones around it", () => {
    const got = parseCustom([
      key(),
      { id: "custom:b" },
      { label: "no id", text: "x" },
      key({ id: "custom:c", label: "cl", text: "/clear" }),
    ]);
    expect(got.map((k) => k.id)).toEqual(["custom:a", "custom:c"]);
  });

  test("a duplicate id places once", () => {
    expect(parseCustom([key(), key()])).toHaveLength(1);
  });

  test("a missing enter reads as false, not as undefined", () => {
    // It ends up deciding whether a command RUNS. Anything other than an
    // explicit true is "put it on the line".
    const [got] = parseCustom([{ id: "custom:a", label: "st", text: "git status" }]);
    expect(got?.enter).toBe(false);
  });

  test("a stored list longer than the cap is cut", () => {
    const many = Array.from({ length: MAX_CUSTOM + 4 }, (_, i) => key({ id: `custom:${i}` }));
    expect(parseCustom(many)).toHaveLength(MAX_CUSTOM);
  });
});

describe("what goes down the socket", () => {
  test("the text, exactly as typed", () => {
    expect(bytesFor(key({ text: "git  status ", enter: false }))).toBe("git  status ");
  });

  test("a Return is a carriage return, not a line feed", () => {
    // A shell prompt's Return is \r. A \n is a different key and does not
    // submit in several of the TUIs this app drives.
    expect(bytesFor(key({ text: "ls", enter: true }))).toBe("ls\r");
    expect(bytesFor(key({ text: "ls", enter: true }))).not.toContain("\n");
  });

  test("nothing is escaped or interpreted", () => {
    // A phone keyboard cannot type a backslash-n by accident but it can type
    // one on purpose, and a path with a backslash in it must survive.
    expect(bytesFor(key({ text: "C:\\\\Users\\\\x", enter: false }))).toBe("C:\\\\Users\\\\x");
    expect(bytesFor(key({ text: "echo \\n", enter: false }))).toBe("echo \\n");
  });
});
