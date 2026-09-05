/*
 * The settings redesign complaints, held in place.
 *
 * The maintainer reviewed the settings redesign screen by screen and said the same
 * class of thing eight times — no contrast, titles do not stand out, no
 * space between sections, it all looks flat — and every one had to be
 * pointed out by hand, after the work had shipped. The failure was not
 * taste, it was METHOD: fixes landed page by page, on whichever pages
 * somebody happened to open. index.css now says so directly, at "A GROUP
 * DRAWS ITSELF": the card lives in `.agx-settings-section` /
 * `.agx-settings-rows`, on the SHAPE and not on a component, precisely so a
 * page written next month gets it without being told. This file is what
 * makes that claim true instead of aspirational — it fails the day a ninth
 * page hand-rolls its own box.
 *
 * Two rules, source-level like spacing-scale.test.ts and hook-tdz.test.ts:
 *
 *   1. Every `.agx-settings-section` carries a heading — `.agx-settings-head`
 *      or `.panel-eyebrow` — before its rows. An untitled box of rows is the
 *      page he called "a book".
 *   2. The class string that opens a `.agx-settings-section` never also
 *      carries a spacing utility (`pb-`, `pt-`, `mb-`, `mt-`). The gap
 *      between groups is the single `margin-bottom: 24px` on that selector
 *      in index.css — it was a `pb-` utility at eight call sites before that,
 *      and seven of them disagreed.
 *
 * A third rule was drafted and dropped: "a `.agx-settings-rows` never appears
 * without a `.agx-settings-section` around it, and vice versa." It reads
 * right and it is wrong — the look editor (`understudy/Appearance.tsx`) puts
 * `.agx-settings-rows` directly under `.agx-settings-col` with no card at
 * all, which index.css targets on purpose (`.agx-settings-col
 * .agx-settings-rows > *`), and `SettingsModal.tsx`'s engine-config block
 * nests a second `.agx-settings-rows` inside a section that already opened
 * one, as a sub-group. Both are correct today. A static "nearest preceding
 * tag" search cannot tell those from a half-migrated page without parsing
 * real JSX nesting, so it would either miss the real case or flag two
 * legitimate ones — worse than no rule, per the brief. `SavedRepliesPane.tsx`
 * is the closer call: it has the card and the heading but its body is a
 * hand-rolled `flex flex-col` list, not `.agx-settings-rows`, because the
 * rows are reply cards with an inline edit form, not toggles — genuinely not
 * the same shape `SettingRow` draws. Locking "every section has rows" would
 * fail on that page today for a reason that is a design call, not a bug, and
 * this task is not the one restyling it.
 *
 * Two complaints from the same review are NOT here, on purpose:
 *
 *   - Icon size ("the icons are tiny", "the checkbox is enano"). Already
 *     locked in icon-scale.test.ts — an ICON.xs floor and a HIT target wider
 *     than the glyph. Duplicating it here would just be a second lock on the
 *     same rule, drifting the moment one of them gets edited and not both.
 *   - "Reads as raised" / hand-written color-mix vs. the surface tokens. The
 *     violation that prompted it was specific — the rail painting `color-mix
 *     (--bg 55%, transparent)` against a `--bg` background, i.e. nothing —
 *     but `color-mix(in srgb, var(--bg) N%, transparent)` alone is not the
 *     bug: the same pattern is correct and common as a scrim (a fixed overlay
 *     dimming what is behind it), a spinner border, or a chip tint, none of
 *     which are "a surface that is meant to read as raised." A static grep
 *     cannot tell a scrim from a mistaken card without knowing what sits
 *     behind the element, so a rule here would either miss the real case or
 *     flag two dozen correct ones. Not locked; see the closing note in the
 *     commit for what would have to exist first.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..", "src");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const FILES = tsxFiles(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, "utf8") }));

/** Class-attribute occurrences of one token, each as a line number and the
 *  full class string it was found in — plain `className="…"` and the
 *  template-literal form both, since both appear in this codebase. */
function classHits(text: string, token: string): { line: number; index: number; classes: string }[] {
  const hits: { line: number; index: number; classes: string }[] = [];
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const classes = m[1] ?? m[2] ?? "";
    if (!new RegExp(`\\b${token}\\b`).test(classes)) continue;
    hits.push({ line: text.slice(0, m.index).split("\n").length, index: m.index, classes });
  }
  return hits;
}

describe("a settings group always names itself", () => {
  test("a heading appears before the rows, on every group", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      for (const section of classHits(text, "agx-settings-section")) {
        const after = text.slice(section.index, section.index + 2000);
        const rowsAt = after.search(/agx-settings-rows/);
        // No rows box nearby (e.g. SavedRepliesPane's hand-rolled list body):
        // not this rule's concern, see the header note on what was dropped.
        if (rowsAt === -1) continue;
        const before = after.slice(0, rowsAt);
        if (!/agx-settings-head\b|panel-eyebrow\b/.test(before)) {
          bad.push(`${rel}:${section.line} — rows with no .agx-settings-head or .panel-eyebrow heading before them`);
        }
      }
    }
    expect(bad.join("\n") || null).toBeNull();
  });
});

describe("the gap between groups is not re-decided per page", () => {
  test("no .agx-settings-section carries its own spacing utility", () => {
    // The gap is `margin-bottom: 24px` on the selector in index.css. A pb-/
    // pt-/mb-/mt- riding along on the same element re-opens the thing that
    // shipped inconsistent the first time: eight call sites, seven numbers.
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      for (const section of classHits(text, "agx-settings-section")) {
        const stray = section.classes.match(/\b(?:pb|pt|mb|mt)-\S+/);
        if (stray) bad.push(`${rel}:${section.line} — "${stray[0]}" on the section itself; the gap is index.css's margin-bottom, not a per-page utility`);
      }
    }
    expect(bad.join("\n") || null).toBeNull();
  });
});
