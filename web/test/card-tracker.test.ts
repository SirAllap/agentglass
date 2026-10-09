/*
 * The tracker block on a board card: what it draws per mode, and the rules the
 * stylesheet keeps for it. There is no renderer with a pointer in this project,
 * so the hover and touch behaviour is asserted against the CSS source — the
 * measured side (heights, overlap, wrapping) was checked in a real browser.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CardTracker } from "../src/components/CardTracker.tsx";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const tracker = read("src/components/CardTracker.tsx");
const css = read("src/index.css");
/** The rules of the block, from its first selector to the next section's comment. */
const trkCss = css.slice(css.indexOf(".agx-trk {"), css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .agx-trk-faces"));

const PEOPLE = ["Ada Lin", "Bo Nunez", "Cy Novak", "Di Park", "Er Sato", "Fy Sol", "Gu Hale"]
  .map((name, id) => ({ id, name, initials: name.slice(0, 2).toUpperCase() }));
const card = (o: Record<string, unknown> = {}) => ({
  id: "8ab12cd34", customId: "ORBIT-1042", title: "Restore the bundle", status: "code review",
  priority: "normal" as const, people: PEOPLE.slice(0, 3), at: Date.now() - 60_000, ...o,
});
const draw = (p: Partial<React.ComponentProps<typeof CardTracker>>) =>
  renderToStaticMarkup(React.createElement(CardTracker, { block: "card", card: card(), task: null, prOpen: true, ...p }));

describe("what the block draws, per mode", () => {
  it("a repository without a tracker draws nothing at all", () => {
    expect(draw({ block: "none", card: undefined })).toBe("");
  });
  it("a card draws its id as a button, its status and its faces", () => {
    const html = draw({});
    expect(html).toContain('data-block="card"');
    expect(html).toContain("ORBIT-1042");
    expect(html).toContain("CODE REVIEW");
    expect(html).toContain("Card assigned to Ada Lin, Bo Nunez, Cy Novak");
  });
  it("seven assignees draw five faces and +2, and the tooltip names all seven", () => {
    const html = draw({ card: card({ people: PEOPLE }) });
    expect((html.match(/>(AD|BO|CY|DI|ER|FY|GU)</g) ?? []).length).toBe(5);
    expect(html).toContain("+2");
    expect(html).toContain("Gu Hale");
  });
  it("offers the three copy buttons in order, with the words the tooltips use", () => {
    const html = draw({ card: card({ url: "https://tracker.example/t/ORBIT-1042" }) });
    const at = ["Copy card ID", "Copy card name", "Copy card link"].map((l) => html.indexOf(`aria-label="${l}"`));
    expect(at.every((n) => n > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(html).toContain('data-k="link"');
  });
  it("has no copy-link button for a card with no address, and keeps the other two", () => {
    for (const url of [undefined, "", "   ", "not a link", "javascript:alert(1)", "file:///etc/hosts"]) {
      const html = draw({ card: card({ url }) });
      expect(html).toContain('aria-label="Copy card ID"');
      expect(html).toContain('aria-label="Copy card name"');
      expect(html).not.toContain("Copy card link");
      expect(html).not.toContain("data-wide");
    }
  });
  it("has no copy-name button for a card without a title, and keeps the id one", () => {
    const html = draw({ card: card({ title: "" }) });
    expect(html).toContain('aria-label="Copy card ID"');
    expect(html).not.toContain("Copy card name");
  });
  it("a stale reading dims the status and carries its age", () => {
    const html = draw({ card: card({ at: Date.now() - 3 * 3_600_000 }) });
    expect(html).toContain("3h ago");
  });
  it("a fresh one says nothing about its age", () => {
    expect(draw({})).not.toContain("h ago");
  });
  it("a card marked done under an open pull request gets the dot, and not under a closed one", () => {
    const done = card({ statusKind: "done", status: "done" });
    expect(draw({ card: done, prOpen: true })).toContain("while this pull request is still open");
    expect(draw({ card: done, prOpen: false })).not.toContain("while this pull request is still open");
  });
  it("a card nobody has cached draws the id and says so", () => {
    const html = draw({ block: "id", card: undefined, task: { label: "ORBIT-9999", query: "ORBIT-9999", confidence: "convention" } });
    expect(html).toContain("ORBIT-9999");
    expect(html).toContain("card not found on your boards");
    expect(html).not.toContain("Copy card");
  });
  it("the hint is quiet: marked so the stylesheet drops the tint, with no copy buttons", () => {
    const html = draw({ block: "hint", card: undefined });
    expect(html).toContain('data-quiet="1"');
    expect(html).toContain("No card linked");
    expect(html).not.toContain("Copy card");
  });
  it("loading draws the shape of the answer and no words", () => {
    const html = draw({ block: "loading", card: undefined });
    expect(html).toContain('aria-hidden');
    expect(html).not.toContain("No card linked");
  });
});

describe("the copy buttons", () => {
  it("press without opening the card underneath", () => {
    expect(tracker.slice(tracker.indexOf("function CopyButton("))).toContain("e.stopPropagation()");
  });
  it("say Copied for a moment, and the id button opens the card inside the app", () => {
    expect(tracker).toContain("const COPIED_MS = 1500;");
    expect(tracker).toContain("openCard(card.customId || card.id, card.customId)");
  });
  it("come in three kinds, each with its words and a glyph already in the set", () => {
    expect(tracker).toContain('type CopyKind = "id" | "name" | "link";');
    expect(tracker).toContain('kind="id" label="Copy card ID" done={`Copied ${id}`}');
    expect(tracker).toContain('kind="name" label="Copy card name" done="Copied card name"');
    expect(tracker).toContain('kind="link" label="Copy card link" done="Copied card link"');
    expect(tracker).toContain("<LinkIcon size={ICON.xs} />");
  });
  it("are the house 26px", () => {
    expect(tracker).toContain("style={{ width: HIT, height: HIT }}");
  });
  it("name no tracker: the repository is public and the block is generic", () => {
    const code = tracker.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code.toLowerCase()).not.toContain("clickup");
  });
});

describe("the block's stylesheet", () => {
  it("reserves a box for the copy buttons, so reaching for one moves nothing", () => {
    expect(trkCss).toMatch(/\.agx-trk-fz \{[^}]*min-width: 56px/);
  });
  it("widens the box to three buttons only for a card that has the third", () => {
    expect(trkCss).toContain(".agx-trk-fz[data-wide] { min-width: 78px; }");
    expect(trkCss).toContain(".agx-trk-fz, .agx-trk-fz[data-wide] { min-width: 0; gap: 4px; }");
  });
  it("hangs the last button's tooltip from its right edge, whichever button is last", () => {
    expect(trkCss).toContain(".agx-trk-cp:last-child .agx-trk-tip { left: auto; right: 0; transform: none; }");
  });
  it("swaps the faces for the buttons on pointer-over AND on focus-within", () => {
    expect(trkCss).toContain(".agx-trk:is(:hover, :focus-within) .agx-trk-faces { opacity: 0; }");
    expect(trkCss).toContain(".agx-trk:is(:hover, :focus-within) .agx-trk-ovl { opacity: 1; pointer-events: auto; }");
  });
  it("keeps the invisible buttons from catching the pointer at rest", () => {
    expect(trkCss).toMatch(/\.agx-trk-ovl \{[^}]*opacity: 0; pointer-events: none/);
  });
  it("gives them an inline slot where there is no hover", () => {
    const media = trkCss.slice(trkCss.indexOf("@media (hover: none) and (pointer: coarse)"));
    expect(media).toContain(".agx-trk-ovl { position: static; opacity: 1; pointer-events: auto; }");
    expect(media).toContain(".agx-trk-faces { opacity: 1 !important; }");
  });
  it("wraps rather than overflowing a lane narrower than the block", () => {
    expect(trkCss).toMatch(/\.agx-trk \{[^}]*flex-wrap: wrap;[^}]*max-width: 100%/);
  });
  it("is quiet when it holds only the hint: no tint, no edge", () => {
    expect(trkCss).toContain(".agx-trk[data-quiet] { background: transparent; border-color: transparent; }");
  });
  it("stops animating for a reader who asked it to", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.agx-trk-faces, \.agx-trk-ovl \{ transition: none; \}/);
  });
});
