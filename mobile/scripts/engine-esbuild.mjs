import { createHash } from "node:crypto";

/*
 * How the terminal engine is compiled — one place, because the build script and
 * the test that guards the output must not disagree about it.
 *
 * `chrome74` because Android WebViews are not all current: esbuild lowers
 * SYNTAX to the target, so an old WebView parses the bundle.
 *
 * `minifySyntax` is OFF, and that is a measured bug and not a size choice.
 * xterm's InputHandler.requestMode starts with `let r; (…enum…)(r ||= {})`.
 * Lowered to chrome74 and minified with syntax folding, esbuild 0.25 emitted
 * `(…)(void 0||(i={}))` and dropped the `let r;` — a class body is strict, so
 * the first DECRQM query threw `ReferenceError: i is not defined`, xterm's write
 * buffer kept the chunk that threw and never ran again, and the pane stayed
 * black with a cursor. tmux 3.8 sends `ESC [ ? 2026 $ p` (is synchronized
 * output supported?) as the first thing on every attach; 3.7 did not, which is
 * why the same phone worked against a server started before the upgrade and not
 * against one started after. Whitespace and identifiers still minify; the bundle
 * is about 1% larger.
 */
export const TARGET = "chrome74";

export const ENGINE_ESBUILD = {
  bundle: true,
  format: "iife",
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: false,
  platform: "browser",
  target: TARGET,
  legalComments: "none",
  write: false,
  logLevel: "silent",
};

/** Names the recipe above in the header of what it built. The generated file is
 *  gitignored and rewritten only by `npm install`, so a checkout that pulled a
 *  change to the recipe keeps running tests against the old bundle: with the
 *  same commit, the pane tests were red for the xterm fix above on one machine
 *  and green on another. shortcut: covers these options only, not the entry
 *  shims in build-terminal-engine.mjs; widen it when one of those matters. */
export const RECIPE = createHash("sha256").update(JSON.stringify(ENGINE_ESBUILD)).digest("hex").slice(0, 12);
