/*
 * The formatting buttons, as string operations.
 *
 * What makes a composer feel finished is entirely in here: bold with nothing
 * selected leaves the caret ready to type, bold pressed twice undoes itself,
 * and a list button pressed with four lines selected prefixes four lines. None
 * of that shows up in a screenshot and all of it is the difference between
 * "there is a toolbar" and "I can write in this".
 */
import { describe, expect, test } from "bun:test";
import { bold, bullet, checklist, code, fence, heading, italic, link, newline, ordered, quote, strike, table } from "../src/lib/mdEditor.ts";

const at = (text: string, start: number, end = start) => ({ text, start, end });

describe("wrapping", () => {
  test("with a selection, the marks go round it and the selection survives", () => {
    const out = bold(at("make it loud", 5, 7));
    expect(out.text).toBe("make **it** loud");
    expect(out.text.slice(out.start, out.end)).toBe("it");
  });

  test("with nothing selected, the caret lands between the marks", () => {
    const out = bold(at("say ", 4));
    expect(out.text).toBe("say ****");
    expect(out.start).toBe(6);
    expect(out.start).toBe(out.end);
  });

  test("pressed again it takes the marks off rather than nesting them", () => {
    const once = bold(at("loud", 0, 4));
    const twice = bold(once);
    expect(twice.text).toBe("loud");
    expect(twice.text.slice(twice.start, twice.end)).toBe("loud");
  });

  test("and it undoes marks that are just OUTSIDE the selection", () => {
    // Which is what a double-click on the word inside `**word**` gives you.
    const out = bold(at("**word**", 2, 6));
    expect(out.text).toBe("word");
  });

  test("italic, strike and code use their own marks", () => {
    expect(italic(at("x", 0, 1)).text).toBe("*x*");
    expect(strike(at("x", 0, 1)).text).toBe("~~x~~");
    expect(code(at("x", 0, 1)).text).toBe("`x`");
  });
});

describe("links", () => {
  test("selected text becomes the label and the caret waits for the url", () => {
    const out = link(at("see the PR", 8, 10));
    expect(out.text).toBe("see the [PR]()");
    expect(out.start).toBe(13);
  });

  test("with nothing selected the caret goes where the label goes", () => {
    const out = link(at("", 0));
    expect(out.text).toBe("[]()");
    expect(out.start).toBe(1);
  });
});

describe("line prefixes", () => {
  test("every line the selection touches gets the mark", () => {
    const out = bullet(at("one\ntwo\nthree", 0, 8));
    expect(out.text).toBe("- one\n- two\n- three");
  });

  test("a numbered list counts", () => {
    expect(ordered(at("one\ntwo", 0, 7)).text).toBe("1. one\n2. two");
  });

  test("pressing it again gives the text back", () => {
    const on = quote(at("careful", 0, 7));
    expect(on.text).toBe("> careful");
    expect(quote(on).text).toBe("careful");
  });

  test("a checklist and a heading are the same operation with another mark", () => {
    expect(checklist(at("do it", 0, 5)).text).toBe("- [ ] do it");
    expect(heading(at("Title", 0, 5)).text).toBe("## Title");
  });

  test("the caret is inside the line, not before the mark", () => {
    const out = bullet(at("item", 4));
    expect(out.text).toBe("- item");
    expect(out.start).toBe(6);
  });
});

describe("blocks", () => {
  test("a fence gets its own lines and the caret lands on the language", () => {
    const out = fence(at("make test", 0, 9));
    expect(out.text).toBe("```\nmake test\n```");
    expect(out.text.slice(out.start, out.end)).toBe("make test");
  });

  test("a fence after a sentence starts on a new line", () => {
    expect(fence(at("here:", 5)).text).toBe("here:\n```\n\n```");
  });

  test("a table comes ready to type over", () => {
    const out = table(at("", 0));
    expect(out.text.split("\n")[1]).toBe("|---|---|");
    expect(out.text.slice(out.start, out.end)).toBe("Column");
  });
});

describe("Enter inside a list", () => {
  test("carries the list on", () => {
    const out = newline(at("- one", 5))!;
    expect(out.text).toBe("- one\n- ");
    expect(out.start).toBe(out.text.length);
  });

  test("numbers count up", () => {
    expect(newline(at("1. one", 6))!.text).toBe("1. one\n2. ");
  });

  test("a ticked box does not carry its tick", () => {
    expect(newline(at("- [x] done", 10))!.text).toBe("- [x] done\n- [ ] ");
  });

  test("an empty item ends the list instead of adding another", () => {
    const out = newline(at("- one\n- ", 8))!;
    expect(out.text).toBe("- one\n");
  });

  test("outside a list it is not our key", () => {
    expect(newline(at("a sentence", 10))).toBeNull();
  });
});
