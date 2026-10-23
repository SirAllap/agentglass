/*
 * The list + editor page type: what the picked entry looks like, what counts as
 * an unsaved change, and that the three list pages use it rather than a card
 * per item. Each test goes red when the decision it states is reverted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorFoot, ListPanel, differs } from "../src/components/SettingsListEditor.tsx";

const SRC = join(import.meta.dir, "..", "src", "components");
const h = React.createElement;

describe("ListPanel", () => {
  const sections = [{ id: "a", title: "Everywhere", entries: [{ id: "1", title: "Run checks", sub: "make check" }, { id: "2", title: "Dev" }] }];
  test("only the picked entry is marked current", () => {
    const html = renderToStaticMarkup(h(ListPanel, { sections, selected: "2", onSelect: () => {} }));
    expect(html.match(/aria-current="true"/g)?.length).toBe(1);
    expect(html.indexOf("Dev")).toBeLessThan(html.indexOf('aria-current="true"') + 80);
  });
  test("a filter that leaves nothing says so", () => {
    const html = renderToStaticMarkup(h(ListPanel, { sections: [{ ...sections[0]!, entries: [] }], selected: null, onSelect: () => {}, nothing: "Nothing matches." }));
    expect(html).toContain("Nothing matches.");
  });
});

describe("differs", () => {
  test("same fields in another order are the same", () => expect(differs({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false));
  test("a missing field is the same as an empty one", () => expect(differs({ a: 1, b: undefined }, { a: 1 })).toBe(false));
  test("a changed field differs, and a new draft always does", () => {
    expect(differs({ a: 1 }, { a: 2 })).toBe(true);
    expect(differs({ a: 1 }, undefined)).toBe(true);
  });
});

describe("EditorFoot", () => {
  test("Save only appears with something to save", () => {
    const clean = renderToStaticMarkup(h(EditorFoot, { dirty: false, canSave: true, noun: "reply", onCancel: () => {} }));
    const dirty = renderToStaticMarkup(h(EditorFoot, { dirty: true, canSave: true, noun: "reply", onCancel: () => {} }));
    expect(clean).toContain("All changes saved");
    expect(clean).not.toContain("Save reply");
    expect(dirty).toContain("Unsaved changes");
    expect(dirty).toContain("Save reply");
  });
});

describe("the list pages", () => {
  for (const f of ["RecipesPane", "ReviewPromptsPane", "SavedRepliesPane"]) {
    test(`${f} is a list beside an editor, not a card per item`, () => {
      const src = readFileSync(join(SRC, `${f}.tsx`), "utf8");
      expect(src).toContain("<ListEditorSplit");
      expect(src).toContain("<EditorPanel");
    });
  }
});
