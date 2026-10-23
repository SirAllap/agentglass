/*
 * What the settings kit draws: the card's tones, the chip family, the switch and
 * the page flow. The markup is rendered (the claim is about what a page gets by
 * passing a prop); the look is asserted against the stylesheet because there is
 * no renderer for CSS here. Each test goes red when the decision it states is
 * reverted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsCard, StatusBadge } from "../src/components/SettingsKit.tsx";
import { Switch, SettingRow, choiceIsWide } from "../src/components/SettingRow.tsx";

const SRC = join(import.meta.dir, "..", "src");
const css = readFileSync(join(SRC, "index.css"), "utf8");
const modal = readFileSync(join(SRC, "components", "SettingsModal.tsx"), "utf8");
const h = React.createElement;

/** The body of the first rule whose selector is exactly `sel`. */
const rule = (sel: string): string => {
  const m = new RegExp(`\\n[ \\t]*${sel.replace(/[.[\]()*+?^$|\\]/g, "\\$&")} \\{`).exec(css);
  expect(m, sel).not.toBeNull();
  return css.slice(m!.index, css.indexOf("}", m!.index));
};

describe("SettingsCard tone", () => {
  const html = (props: Record<string, unknown>) =>
    renderToStaticMarkup(h(SettingsCard, { title: "Gate", children: h("div", null, "row"), ...props }));

  test("a plain card carries no tone; a decision card and a danger card say so", () => {
    expect(html({})).not.toContain("data-tone");
    expect(html({ tone: "default" })).not.toContain("data-tone");
    expect(html({ tone: "decision" })).toContain('data-tone="decision"');
    expect(html({ tone: "danger" })).toContain('data-tone="danger"');
  });

  test("a decision card has an amber top edge, and nothing else has one", () => {
    const edge = css.slice(css.indexOf('.agx-scard[data-tone="decision"]::before'));
    expect(edge.slice(0, edge.indexOf("}"))).toMatch(/height: 3px;[^}]*background: var\(--warning\)|background: var\(--warning\)[^}]*height: 3px/);
    expect(css.match(/\.agx-scard\[data-tone="danger"\]::before/g)).toBeNull();
  });

  test("the danger zone is red-tinted and its buttons are outlines, never filled", () => {
    expect(rule('.agx-scard[data-tone="danger"]')).toMatch(/background: color-mix\(in srgb, var\(--error\) \d+%/);
    const btn = rule('.agx-scard[data-tone="danger"] .agx-btn');
    // Button writes its fill inline, so the outline has to be `!important` to hold.
    expect(btn).toContain("background: transparent !important");
    expect(btn).toContain("color: var(--error-ink) !important");
    expect(btn).toMatch(/box-shadow: inset 0 0 0 1px color-mix\(in srgb, var\(--error\)/);
  });

  test("the page's index marks a decision card amber and the danger zone red", () => {
    const toc = readFileSync(join(SRC, "components", "SettingsToc.tsx"), "utf8");
    expect(toc).toContain('const CARD_DOT: Record<string, string> = { decision: "warn", danger: "err" };');
    expect(toc).toContain("CARD_DOT[el.dataset.tone");
  });

  test("an icon is a tinted chip before the title, and absent when not given", () => {
    expect(html({ icon: h("svg") })).toContain('class="agx-scard-ic"');
    expect(html({})).not.toContain("agx-scard-ic");
    expect(rule(".agx-scard-ic")).toContain("var(--hue");
  });

  test("wide is a class the flow reads, and it spans every column", () => {
    expect(html({ wide: true })).toContain('class="agx-scard agx-scard-wide"');
    expect(html({})).not.toContain("agx-scard-wide");
    expect(rule(".agx-settings-col .agx-scard-wide")).toContain("column-span: all");
  });

  test("the status and the action sit in the title's line, the sentence under it", () => {
    const out = html({ status: h("b", null, "S"), desc: "one line" });
    expect(out.indexOf("agx-settings-head-t")).toBeLessThan(out.indexOf("agx-slot"));
    expect(out.indexOf("agx-slot")).toBeLessThan(out.indexOf("agx-scard-desc"));
  });
});

describe("the chip family", () => {
  test("a badge is its tone, a dot and the words", () => {
    for (const tone of ["ok", "warn", "err", "info", "off", "checking"] as const) {
      expect(renderToStaticMarkup(h(StatusBadge, { tone, children: "Words" }))).toBe(`<span class="agx-badge" data-tone="${tone}"><i aria-hidden="true"></i>Words</span>`);
    }
  });
  test("the switch is on in the success colour with a knob that moves", () => {
    expect(renderToStaticMarkup(h(Switch, { on: true }))).toContain("data-on");
    expect(renderToStaticMarkup(h(Switch, { on: false }))).not.toContain("data-on");
    expect(rule(".agx-switch[data-on]")).toContain("background: var(--success)");
    expect(rule(".agx-switch[data-on] .agx-switch-knob")).toContain("translateX(");
  });
});

describe("the page flow", () => {
  test("one column, two from 1180px, three from 2300px", () => {
    expect(rule(".agx-settings-col")).toContain("columns: 1;");
    expect(css).toMatch(/@media \(min-width: 1180px\) \{ \.agx-settings-col \{ columns: 2; \} \}/);
    expect(css).toMatch(/@media \(min-width: 2300px\) \{ \.agx-settings-col \{ columns: 3; \} \}/);
  });
  test("a card never splits across columns, and is the container its rows answer to", () => {
    const card = rule(".agx-settings-col .agx-scard");
    expect(card).toContain("break-inside: avoid");
    expect(card).toContain("container: agx-settings / inline-size");
  });
  test("whatever stands in the column and is not a card spans the page", () => {
    expect(rule(".agx-settings-col > :not(.agx-scard)")).toContain("column-span: all");
  });
  test("an old box spans the page until its page moves onto the kit", () => {
    expect(rule(".agx-settings-col .agx-settings-section")).toContain("column-span: all");
  });
  test("a board is one flow column at its own width, set on the page that holds the rail", () => {
    expect(css).toContain('.agx-settings-col[data-flow="single"] { columns: 1; }');
    expect(modal).toContain('data-flow={WIDE_PANES.has(pane) ? "single" : undefined}');
    // The grid that holds the rail and the column both read the width, so it is set on their ancestor.
    const page = modal.slice(modal.indexOf('<div className="agx-settings-page"'), modal.indexOf('<div className="agx-settings-content">'));
    expect(page).toContain('"--agx-settings-col": WIDE_PANES.get(pane)');
  });
  test("a card takes the page's hue for its icon chip from the group of the page", () => {
    const page = modal.slice(modal.indexOf('<div className="agx-settings-page"'), modal.indexOf('<div className="agx-settings-content">'));
    expect(page).toContain('"--hue": hueVar(');
  });
});

describe("a wide control", () => {
  test("a choice is wide from about 30 characters of options, padding counted", () => {
    expect(choiceIsWide(["4k", "10k", "25k", "50k"])).toBe(false);
    expect(choiceIsWide(["Built-in", "Neovim"])).toBe(false);
    expect(choiceIsWide(["Block", "Bar", "Underline"])).toBe(false);
    expect(choiceIsWide(["Auto", "GPU", "Canvas", "Compatibility"])).toBe(true);
    expect(choiceIsWide(["Default (separate)", "Separate", "tmux panes"])).toBe(true);
  });
  test("a wide row says so, and under 560px of card its control drops under the words", () => {
    const row = (wide?: boolean) => renderToStaticMarkup(h(SettingRow, { label: "L", control: h("b", null, "c"), wide }));
    expect(row(true)).toContain("agx-row-wide");
    expect(row()).not.toContain("agx-row-wide");
    expect(css).toMatch(/@container agx-settings \(max-width: 560px\) \{\s*\.agx-settings-row\.agx-row-wide \{ grid-template-columns: 1fr; \}/);
    expect(modal).toContain("wide={choiceIsWide(options.map((o) => o.label))}");
  });
});
