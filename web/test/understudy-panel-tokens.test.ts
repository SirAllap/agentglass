/*
 * Every colour in the understudy panel comes from the theme.
 *
 * This app has 37 themes and `applyTheme()` switches between them by rewriting
 * `:root` — which works for exactly as long as nothing paints itself a colour
 * of its own. One `#8b949e` is invisible on the palette it was picked against
 * and unreadable on the other 36, and it is invisible to the person who wrote
 * it too, because they were looking at the one theme where it happened to be
 * right.
 *
 * So the rule for this panel is the rule for the app: `var(--…)` for a token,
 * `wash(token, pct)` and `edge(pct)` for a tint of one, and the `Tone` scale
 * from `git/ui.tsx` where a row is carrying a status. Nothing else.
 *
 * THE ART IS THE EXCEPTION AND IT IS NOT IN HERE. `persona/` holds the portrait
 * layers and the Endesga 32 palette they were drawn against; the understudy's
 * skin does not turn blue when you pick the blue theme, any more than a
 * photograph on a desk changes colour when you repaint the wall. That folder is
 * excluded by name, which is what makes it a decision instead of an oversight.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "src", "components", "understudy");

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .sort()
  .map((f) => ({ rel: `web/src/components/understudy/${f}`, text: readFileSync(join(DIR, f), "utf8") }));

function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const { rel, text } of FILES) {
    text.split("\n").forEach((ln, i) => {
      if (new RegExp(re.source, re.flags.replace("g", "")).test(ln)) out.push(`${rel}:${i + 1} → ${ln.trim()}`);
    });
  }
  return out;
}

/** What a colour is allowed to be made of. */
const ALLOWED = [
  "var(--",          // a theme token
  "wash(",           // a tint of one — git/ui.tsx
  "edge(",           // a hairline drawn from --text — git/ui.tsx
  "LOCK_COLOUR",     // the lock ladder, which is tokens by another name
  "SEAL_COLOUR",     // the seal states, likewise
  "modeColour",      // shadow vs acting, likewise
  "STATE_TONE",      // a run's state, likewise — a table of var(--…) by name
  "colour",          // a local already resolved from one of the above
  "transparent",
  "currentColor",
  "inherit",
  "none",
  "undefined",
];

/** The CSS properties that put colour on the screen. `border` and `boxShadow`
 *  are left out on purpose: they are shorthands whose colour half is caught by
 *  the hex and rgb rules above, and matching them here would demand a parser. */
const COLOUR_PROP = /\b(?:color|background|backgroundColor|borderColor|borderTopColor|outlineColor|fill|stroke)\s*:/;

describe("the understudy panel is drawn in theme tokens", () => {
  test("there are files to check", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(4);
    expect(FILES.map((f) => f.rel)).toContain("web/src/components/understudy/UnderstudyPanel.tsx");
  });

  test("no hex literal", () => {
    // Three, four, six or eight digits — every shape a CSS hex takes.
    expect(hits(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g),
      "a hex is right on one of 37 themes and wrong on the rest").toEqual([]);
  });

  test("no rgb(), hsl() or oklch() literal", () => {
    expect(hits(/\b(?:rgba?|hsla?|oklch|lab|color-mix)\s*\(/g),
      "use var(--token), or wash(token, pct) for a tint of one — color-mix included, which is what wash() already is").toEqual([]);
  });

  test("no Tailwind colour utility", () => {
    // `bg-white/5` was the app's own long-standing mistake: on the porcelain
    // theme, where --bg is white, the affordance it drew was literally
    // invisible. See the note on `.agx-hover` in index.css.
    expect(hits(/\b(?:text|bg|border|from|via|to|fill|stroke|ring|shadow|decoration|outline|accent|caret|divide)-(?:white|black|transparent|current|inherit|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d{1,3})?\b/g),
      "Tailwind's palette is not this app's palette").toEqual([]);
  });

  test("every colour property resolves through a token", () => {
    const strays: string[] = [];
    for (const { rel, text } of FILES) {
      const lines = text.split("\n");
      lines.forEach((ln, i) => {
        if (!COLOUR_PROP.test(ln)) return;
        // A comment describing the rule is not the rule being broken.
        if (/^\s*(?:\*|\/\/|\/\*)/.test(ln)) return;
        // The value can wrap — a ternary over two lines is normal here — so a
        // token on the continuation counts.
        const window = [ln, lines[i + 1] ?? ""].join(" ");
        if (ALLOWED.some((a) => window.includes(a))) return;
        strays.push(`${rel}:${i + 1} → ${ln.trim()}`);
      });
    }
    expect(strays, "a colour has to come from var(--…), wash(), edge() or a Tone").toEqual([]);
  });

  test("an svg paints in currentColor or a token", () => {
    // `fill="#fff"` is the shape that gets past a style-attribute scan, because
    // it is not a style attribute.
    const strays: string[] = [];
    for (const { rel, text } of FILES) {
      for (const m of text.matchAll(/\b(?:fill|stroke)="([^"]*)"/g)) {
        const v = m[1] ?? "";
        if (v === "none" || v === "currentColor" || v.includes("var(--")) continue;
        strays.push(`${rel} → ${m[0]}`);
      }
    }
    expect(strays).toEqual([]);
  });

  test("each file actually uses the tokens", () => {
    // The other half of the rule. A file with no colours at all satisfies every
    // check above by saying nothing, and this panel has no such file — so if
    // one appears, somebody has moved the colours somewhere this suite is not
    // looking.
    for (const { rel, text } of FILES) {
      expect(text.includes("var(--") || text.includes("wash(") || text.includes("edge("), `${rel} paints nothing`).toBe(true);
    }
  });
});
