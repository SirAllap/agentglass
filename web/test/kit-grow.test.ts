/*
 * The kit's newer parts: a quiet button, a bare icon button, a list row, a
 * textarea, a checkbox and radio, a section and a card, and the field that
 * lays them out. Markup is rendered; the look that lives in a stylesheet is
 * asserted against the stylesheet, since there is no renderer for CSS here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button, Card, Checkbox, CHIP, BAR_CTRL, CTRL_RADIUS, IconButton, INPUT, ListRow, Radio, Section, TEXTAREA, Textarea,
} from "../src/components/workspace/Chrome.tsx";
import { Field, LinkButton } from "../src/components/SettingsKit.tsx";

const SRC = join(import.meta.dir, "..", "src");
const css = readFileSync(join(SRC, "index.css"), "utf8");
// createElement's overloads reject a props object without `children` for components that require it; the children are the third argument here.
const h = React.createElement as (type: unknown, props: object | null, ...children: React.ReactNode[]) => React.ReactElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("one radius", () => {
  test("is rounded-lg and every control class list spells it", () => {
    expect(CTRL_RADIUS).toBe("rounded-lg");
    for (const cls of [CHIP, BAR_CTRL, INPUT, TEXTAREA]) expect(cls).toContain(CTRL_RADIUS);
  });
});

describe("quiet and bare", () => {
  test("a quiet Button is transparent with a hover tint, a plain one keeps its grey fill", () => {
    const quiet = html(h(Button, { tone: "quiet" }, "Open"));
    expect(quiet).toContain("background:transparent");
    expect(quiet).toContain("agx-chip");
    const plain = html(h(Button, {}, "Open"));
    expect(plain).toContain("color-mix(in srgb, var(--text) 5%, transparent)");
    expect(plain).not.toContain("agx-chip");
  });

  test("a quiet LinkButton is a quiet Button; the default one is not", () => {
    expect(html(h(LinkButton, { href: "https://example.com", quiet: true }, "Docs"))).toContain("background:transparent");
    expect(html(h(LinkButton, { href: "https://example.com" }, "Docs"))).not.toContain("background:transparent");
  });

  test("a bare IconButton has no edge and the hover tint; a plain one has neither", () => {
    const bare = html(h(IconButton, { title: "Close", onClick: () => {}, bare: true }, "x"));
    expect(bare).toContain("agx-chip");
    expect(bare).not.toContain("border");
    expect(html(h(IconButton, { title: "Close", onClick: () => {} }, "x"))).not.toContain("agx-chip");
  });
});

describe("the new parts", () => {
  test("ListRow marks the current row and takes a leading and trailing slot", () => {
    const row = html(h(ListRow, { current: true, leading: "L", trailing: "T" }, "main"));
    expect(row).toContain('aria-current="true"');
    expect(row).toContain("L");
    expect(row).toContain("T");
    expect(html(h(ListRow, {}, "main"))).not.toContain("aria-current");
  });

  test("Textarea wears TEXTAREA and the edge; a Checkbox and a Radio are native inputs in a label", () => {
    expect(html(h(Textarea, { defaultValue: "a" }))).toContain("resize-y");
    expect(html(h(Checkbox, { checked: true, onChange: () => {} }, "Pin"))).toMatch(/<label[^>]*><input[^>]*type="checkbox"[^>]*checked/);
    expect(html(h(Radio, { checked: false, name: "g", onChange: () => {} }, "A"))).toMatch(/<input[^>]*type="radio"[^>]*name="g"/);
  });

  test("Section shows its title and aside; Card is the card level, a rung rounder than a control", () => {
    const sec = html(h(Section, { title: "Open", aside: "3" }, h("p", null, "body")));
    expect(sec).toContain("Open");
    expect(sec).toContain(">3<");
    const card = html(h(Card, { "data-x": "1" }, "in"));
    expect(card).toContain("rounded-xl");
    expect(card).toContain("var(--surface-card)");
    expect(card).toContain('data-x="1"');
  });
});

describe("Field", () => {
  const field = (props: Record<string, unknown>) =>
    html(h(Field, { label: "Name", htmlFor: "n", ...props }, h("input", { id: "n" })));

  test("hint sits above the control and help below it", () => {
    const out = field({ hint: "HINT", help: "HELP" });
    expect(out.indexOf("HINT")).toBeGreaterThan(-1);
    expect(out.indexOf("HINT")).toBeLessThan(out.indexOf("<input"));
    expect(out.indexOf("HELP")).toBeGreaterThan(out.indexOf("<input"));
  });

  test("block is a data attribute, absent by default", () => {
    expect(field({ block: true })).toContain("data-block");
    expect(field({})).not.toContain("data-block");
  });

  test("a select is natural width unless the field is block, and fields are 12px apart", () => {
    expect(css).toContain(".agx-field[data-block] > select { width: 100%; }");
    expect(css).toContain(".agx-field:not([data-block]) > :where(select, .agx-select) { align-self: flex-start; }");
    expect(css).not.toMatch(/\.agx-field > :where\([^)]*\), select/);
    expect(css).toContain(".agx-field:not(:last-child) { margin-bottom: 12px; }");
    expect(css).toContain(".agx-sform > .agx-field { margin-bottom: 0; }");
  });
});
