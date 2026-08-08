/*
 * A source comment must never be printed on screen.
 *
 * This shipped. A slash-star comment is a comment only where JSX expects an
 * EXPRESSION; among an element's children it is text, and adding a wrapper
 * around a block silently moves every comment inside it from the first position
 * into the second. The viewer printed a paragraph of its own source above the
 * document, in an installed build, and nothing failed — not the typechecker,
 * not a test, not the build.
 *
 * So it is checked by shape, across every component: a slash-star comment whose
 * line sits directly after a line ending in `(` or `>` — the two ways children
 * begin — is in children position and must be braced.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Lines holding a comment that opens in children position. */
function leaked(text: string): { line: number; text: string }[] {
  const lines = text.split("\n");
  const bad: { line: number; text: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const here = lines[i]!.trim();
    if (!here.startsWith("/*")) continue;
    // Walk back past blank lines to the last thing that was actually written.
    let j = i - 1;
    while (j >= 0 && !lines[j]!.trim()) j--;
    const before = lines[j]?.trim() ?? "";
    /*
     * Two shapes, and only two.
     *
     * `>` ends an opening or self-closing tag, so what follows is CHILDREN.
     * `)}` ends an expression container among children, so what follows is a
     * sibling — this is the exact shape that shipped.
     *
     * A line ending in `(` is deliberately NOT matched, though the original bug
     * lived a few lines below one. `(` opens an EXPRESSION — a ternary branch,
     * an arrow's returned block — and a comment there is a real comment.
     * Twenty-five legal ones in this codebase sit exactly there, so flagging it
     * would make the rule noise and the rule would be turned off.
     *
     * Attribute position is not matched either: those follow a quote or an
     * attribute name, never `>`.
     */
    if (!/>$/.test(before) && !/\)\}$/.test(before)) continue;
    /*
     * And what follows has to be an element.
     *
     * Without this the rule fires on CSS comments inside a `<style>` template
     * literal, where the preceding line ends in `)}` because that is how a
     * declaration block closes. A comment that leaks onto the screen is always
     * followed by the markup it was written about; a CSS one is followed by a
     * selector.
     */
    let k = i + 1;
    while (k < lines.length && !lines[k]!.trim()) k++;
    // Past the rest of a multi-line comment first.
    while (k < lines.length && !here.includes("*/") && !lines[k - 1]!.includes("*/")) k++;
    const next = lines[k]?.trim() ?? "";
    if (!next.startsWith("<")) continue;
    bad.push({ line: i + 1, text: here.slice(0, 60) });
  }
  return bad;
}

describe("comments that would be printed on screen", () => {
  it("finds the shape it is looking for", () => {
    // The bug, reduced. Without this the test could pass by matching nothing.
    // The exact shape that shipped: a comment after an expression container,
    // among an element's children.
    expect(leaked(`  {open && (\n    <Bar />\n  )}\n  /* a note */\n  <div />`)).toHaveLength(1);
    expect(leaked(`<div>\n  /* a note */\n  <span />`)).toHaveLength(1);
    expect(leaked(`<Foo />\n/* a note */\n<Bar />`)).toHaveLength(1);
    // Multi-line, which is the form the real one took.
    expect(leaked(`  )}\n  /* one\n     two */\n  <div />`)).toHaveLength(1);
  });

  it("leaves the legal positions alone", () => {
    // Braced among children — the correct form.
    expect(leaked(`<div>\n  {/* a note */}\n  <span />`)).toEqual([]);
    // In attribute position, which is an expression and so a real comment.
    expect(leaked(`<div className="x"\n  /* why this width */\n  style={{}} />`)).toEqual([]);
    // In ordinary code.
    expect(leaked(`const a = 1;\n/* a note */\nconst b = 2;`)).toEqual([]);
    // Expression position: an arrow returning a block, which is where most of
    // this codebase's comments legitimately live.
    expect(leaked(`{items.map((c) => (\n  /* why this spacing */\n  <div />`)).toEqual([]);
    // A CSS comment inside a <style> literal: the line before ends in `)}`
    // because that is how a declaration block closes, and what follows is a
    // selector rather than an element.
    expect(leaked(`.a{border:1px solid color-mix(in srgb,var(--text) 24%,transparent)}\n/* why this rail */\n.b{display:flex}`)).toEqual([]);
  });

  it("none of the components has one", () => {
    const found: string[] = [];
    for (const f of tsxFiles(SRC)) {
      for (const l of leaked(readFileSync(f, "utf8"))) {
        found.push(`${f.slice(SRC.length + 1)}:${l.line}  ${l.text}`);
      }
    }
    expect(found).toEqual([]);
  });
});
