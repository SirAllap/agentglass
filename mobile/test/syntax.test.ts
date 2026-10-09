/*
 * Colour for a file on a phone: five classes of token, never a changed
 * character, and the ceilings the file header names.
 */
import { describe, expect, test } from "bun:test";
import { highlight, langOf, withMarks } from "../src/model/syntax.ts";

const kinds = (line: string, path = "a.ts"): string[] => highlight([line], path)[0]!.map((t) => `${t.kind}:${t.text}`);

describe("tokens", () => {
  test("keywords, strings, numbers and the name being called", () => {
    expect(kinds('export async function pushBatch(n = 3) { return "x"; }')).toEqual([
      "keyword:export", "plain: ", "keyword:async", "plain: ", "keyword:function", "plain: ", "call:pushBatch",
      "plain:(n = ", "number:3", "plain:) { ", "keyword:return", "plain: ", 'string:"x"', "plain:; }",
    ]);
  });

  test("a line is always its own text, whatever the language", () => {
    const src = ['const a = `x ${b}` // tail', "if (x) { y = 'it\\'s' + 0x1F; } /* c */", "#!/bin/sh"];
    for (const path of ["a.ts", "a.py", "a.sh", "a.json", "a.css", "a.md", "Makefile", "noext"]) {
      const out = highlight(src, path);
      src.forEach((line, i) => expect(out[i]!.map((t) => t.text).join("")).toBe(line));
    }
  });

  test("a line comment swallows the rest of the line, a quote inside a string does not end it", () => {
    expect(kinds("x = 1 // a 'b' c")).toEqual(["plain:x = ", "number:1", "plain: ", "comment:// a 'b' c"]);
    expect(kinds('s = "a // b"')).toEqual(["plain:s = ", 'string:"a // b"']);
  });

  test("a block comment carries across lines", () => {
    const out = highlight(["a /* one", "two", "three */ b"], "a.ts");
    expect(out[1]!.map((t) => t.kind)).toEqual(["comment"]);
    expect(out[2]!.map((t) => `${t.kind}:${t.text}`)).toEqual(["comment:three */", "plain: b"]);
  });

  test("a digit inside a name is not a number", () => {
    expect(kinds("a1 = b2")).toEqual(["plain:a1 = b2"]);
  });

  test("the language comes from the extension; markdown and unknown files stay plain", () => {
    expect(langOf("src/sync/push.ts")).not.toBeNull();
    expect(langOf("notes.md")).toBeNull();
    expect(langOf("LICENSE")).toBeNull();
    expect(kinds("const x = 1", "notes.md")).toEqual(["plain:const x = 1"]);
    expect(kinds("# comment", "a.py")).toEqual(["comment:# comment"]);
  });

  test("a minified line is left alone rather than scanned", () => {
    const line = "a=1;".repeat(1000);
    expect(highlight([line], "a.js")[0]).toEqual([{ text: line, kind: "plain" }]);
  });
});

describe("find marks over tokens", () => {
  test("a match keeps its colour and gains a mark; the text is unchanged", () => {
    const line = "for (let attempt = 0; attempt <= RETRIES; attempt++)";
    const tokens = highlight([line], "a.ts")[0]!;
    const segs = withMarks(tokens, [{ at: line.indexOf("RETRIES"), len: 7, current: true }]);
    expect(segs.map((s) => s.text).join("")).toBe(line);
    expect(segs.filter((s) => s.mark).map((s) => [s.text, s.mark])).toEqual([["RETRIES", "current"]]);
  });

  test("a match across two tokens is cut at the edge", () => {
    const tokens = [{ text: "ab", kind: "keyword" as const }, { text: "cd", kind: "string" as const }];
    expect(withMarks(tokens, [{ at: 1, len: 2, current: false }])).toEqual([
      { text: "a", kind: "keyword" }, { text: "b", kind: "keyword", mark: "hit" }, { text: "c", kind: "string", mark: "hit" },
      { text: "d", kind: "string" },
    ]);
  });
});
