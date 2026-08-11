/*
 * A hook at the top level of a module is a renderer that never draws.
 *
 * It happened: two `useState` lines belonging to one settings pane were left
 * outside it when a new pane was pasted into the file — valid TypeScript, valid
 * to every test in this suite, and fatal. A hook call at module scope runs when
 * the file is IMPORTED, and React has no dispatcher then, so `useState` read
 * `null.useState`. The renderer threw before it drew anything and the window sat
 * on "loading the interface…" for ever.
 *
 * Nothing caught it. The type checker is happy — a hook is an ordinary function
 * call. The server suite never renders. The web suite renders single components,
 * not the app's import graph. And this repository has no eslint, so
 * `react-hooks/rules-of-hooks` — the rule written for exactly this — has never
 * run over it.
 *
 * The check is the failure itself: importing the module is what ran the hook,
 * so importing it here is what catches it. No pattern matching, no scanner to
 * be fooled — React throws on the import, exactly as the renderer did. It also
 * covers the neighbouring class: anything else that dies at module scope, which
 * is how the black window of a previous week got in (see hook-tdz.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const ROOT = new URL("../src/", import.meta.url).pathname;

/* A browser has this and bun does not, and a couple of modules read a
   preference as they load. A four-line stub keeps them in the scan; excluding
   them would have taken the check off the files most likely to grow one of
   these. */
if (!("localStorage" in globalThis)) {
  const held = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => { held.set(k, String(v)); },
    removeItem: (k: string) => { held.delete(k); },
    clear: () => held.clear(),
    key: (i: number) => [...held.keys()][i] ?? null,
    get length() { return held.size; },
  };
}

/**
 * The two that reach for `document` while they are being imported.
 *
 * Legitimate — they are the entry point and the theme it applies before the
 * first paint — and impossible here, where there is no DOM. Named rather than
 * pattern-matched: an exception you have to type out is one somebody notices.
 */
const NO_DOM_HERE = new Set(["App.tsx", "main.tsx"]);

/** Every other module under web/src, in a stable order. */
const files = [...new Glob("**/*.{ts,tsx}").scanSync(ROOT)].filter((f) => !NO_DOM_HERE.has(f)).sort();

describe("every module can be imported", () => {
  it("has modules to check at all", () => {
    // A glob that matches nothing is a test that passes for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rel of files) {
    it(rel, async () => {
      // The failure this exists for reads:
      //   TypeError: Cannot read properties of null (reading 'useState')
      // and it happens right here, on the import, with no DOM needed.
      await import(ROOT + rel);
    });
  }
});
