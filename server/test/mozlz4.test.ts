/*
 * The decoder that reads a Firefox-family session file.
 *
 * Hand-built blocks, not a fixture: every case here is three or four bytes
 * whose meaning is written beside them, which is the only way to be sure the
 * thing under test is the format and not one recording of it. The overlapping
 * match in the third case is the one everybody gets wrong — LZ4 expresses a run
 * as a match that reads bytes it is still writing.
 */
import { describe, expect, test } from "bun:test";
import { MOZ_MAGIC, lz4Block, mozLz4, mozLz4Json } from "../src/mozlz4.ts";

const bytes = (...n: number[]) => new Uint8Array(n);
const text = (u: Uint8Array) => new TextDecoder().decode(u);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe("an LZ4 block", () => {
  test("literals only", () => {
    // token 0x40: four literals, no match.
    expect(text(lz4Block(bytes(0x40, ...ascii("abcd")), 4))).toBe("abcd");
  });

  test("a back-reference repeats what came before", () => {
    // "abcd", then a match of 4 at offset 4 — "abcdabcd".
    expect(text(lz4Block(bytes(0x40, ...ascii("abcd"), 0x04, 0x00, 0x00), 8))).toBe("abcdabcd");
  });

  test("an overlapping match is a run, and must be copied byte by byte", () => {
    /*
     * One literal "x", then a match of length 5 at offset 1. A copy that took a
     * snapshot of the source first would produce "x" and then four bytes of
     * whatever the buffer already held; byte-by-byte produces the run LZ4
     * meant.
     */
    expect(text(lz4Block(bytes(0x11, ...ascii("x"), 0x01, 0x00), 6))).toBe("xxxxxx");
  });

  test("lengths past fifteen carry into the bytes after the token", () => {
    // 20 literals: high nibble 15, then one more byte of 5.
    const lit = "0123456789abcdefghij";
    expect(text(lz4Block(bytes(0xf0, 5, ...ascii(lit)), 20))).toBe(lit);
  });

  test("a block that does not produce what the header claims is a corrupt file", () => {
    expect(() => lz4Block(bytes(0x40, ...ascii("abcd")), 99)).toThrow(/produced/);
  });

  test("and a match pointing before the start is refused rather than read", () => {
    // Offset 9 with only 4 bytes decoded: outside the buffer.
    expect(() => lz4Block(bytes(0x40, ...ascii("abcd"), 0x09, 0x00, 0x00), 8)).toThrow(/outside/);
  });
});

describe("the file around it", () => {
  const wrap = (block: number[], size: number) =>
    new Uint8Array([...MOZ_MAGIC, size & 255, (size >> 8) & 255, (size >> 16) & 255, (size >> 24) & 255, ...block]);

  test("magic, length, block", () => {
    expect(text(mozLz4(wrap([0x40, ...ascii("abcd")], 4)))).toBe("abcd");
  });

  test("a length past 16MB is read unsigned, not as a negative", () => {
    // The fourth byte of the size is the one a `<< 24` turns negative in JS.
    const size = 0x01000004;
    const header = wrap([], size);
    expect(header[11]).toBe(1);
    // It throws for being short, not for claiming a nonsense length.
    expect(() => mozLz4(header)).toThrow(/produced 0/);
  });

  test("a header claiming more than 64 MiB is refused before anything is allocated", () => {
    // Four bytes can say 4 GiB, and the buffer used to be allocated on their
    // word alone: a twelve-byte file asking for all the memory there is.
    expect(() => mozLz4(wrap([], 0xffffffff))).toThrow(/more than the 67108864/);
    expect(() => mozLz4(wrap([], 64 * 1024 * 1024 + 1))).toThrow(/more than the/);
    // Exactly the cap is still a size this will try — and fail on, for being short.
    expect(() => mozLz4(wrap([], 64 * 1024 * 1024))).toThrow(/produced 0/);
  });

  test("anything else is named as not being one", () => {
    expect(() => mozLz4(new Uint8Array([1, 2, 3]))).toThrow(/too short/);
    expect(() => mozLz4(new Uint8Array(20))).toThrow(/magic/);
  });

  test("and the JSON on top", () => {
    const json = '{"a":1}';
    expect(mozLz4Json<{ a: number }>(wrap([0x70, ...ascii(json)], json.length))).toEqual({ a: 1 });
  });
});
