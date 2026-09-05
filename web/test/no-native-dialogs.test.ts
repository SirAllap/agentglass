import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The app asks its own questions.
 *
 * `window.confirm` and `window.prompt` render in the OS chrome: another
 * typeface, another button order per platform, no relationship to the panel
 * that raised them. Next to this app's own modals the seam is the loudest thing
 * on screen — and a dialog that reads as foreign is one people click through
 * without reading, which is the worst possible property for the questions here,
 * all of which are about deleting somebody's work.
 *
 * They also block the JS thread, so nothing can show a spinner, disable a
 * button or repaint while one is up. That is half of "I pressed it and nothing
 * happened".
 *
 * Use `useDialogs()` from components/ConfirmDialog.tsx instead:
 *
 *   const { ask, askText, dialog } = useDialogs();   // render {dialog}
 *   if (!(await ask({ title: "Delete branch?", danger: true }))) return;
 *
 * This is a lint, not a unit test, and it exists because the eighteen that were
 * here got there one convenient call at a time.
 */

const SRC = new URL("../src", import.meta.url).pathname;

/**
 * The one native dialog that stays, named rather than silently skipped.
 *
 * `reauthPrompt` runs when the server has started refusing every request — a
 * token appeared or rotated under a tab that is already open. A React dialog
 * needs the app mounted and talking; this is exactly the moment it is neither,
 * so the app's own dialog cannot be the answer here. Replacing it means a login
 * surface that works with no session, which is a piece of work and not a
 * migration.
 *
 * Written as the expected value rather than as a `continue`, so removing the
 * call fails this file and the exception cannot outlive what it excuses.
 */
const ALLOWED = ["lib/api.ts: prompt("];

/** Written out so this file can build the trap below without escaping games. */
const APOS = String.fromCharCode(39);
const EXTS = [".ts", ".tsx"];

/**
 * `confirm(` / `prompt(` / `alert(` — bare, or on `window`.
 *
 * The `.` inside `(?<![\w.$])` is what let four of these in with the suite
 * green. It was there to skip `foo.confirm(`, a method on somebody's object,
 * and it did — including `window.confirm(`, which is the exact call this file
 * exists to forbid. Every one of the hits it missed is spelled that way,
 * because that is how you write it when you are not thinking about a lint.
 *
 * So `window.` is matched explicitly and every OTHER receiver still skipped.
 */
const NATIVE = /(?<![\w$])(?:window\s*\.\s*)?(confirm|prompt|alert)\s*\(/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/**
 * Comment bodies and string literals, so prose about `confirm()` and a button
 * labelled "Confirm" do not fail the build.
 *
 * QUOTES DO NOT CROSS LINES, and that one character class is the difference
 * between a lint and a decoration. `'(?:[^'\\]|\\.)*'` will happily match from
 * an apostrophe in ordinary prose — `tmux's own C-b`, sitting in JSX text or in
 * a comment this function had not reached yet — all the way to the next
 * apostrophe hundreds of lines below, deleting everything in between. That is
 * how `SettingsModal.tsx:2776` was invisible: a `window.confirm` swallowed by
 * an apostrophe forty lines above it.
 *
 * A real single- or double-quoted string cannot contain a raw newline, so
 * excluding `\n` bounds the match to its own line and an unpaired apostrophe
 * can only ever eat the rest of that one. Template literals genuinely do span
 * lines and keep the greedy form.
 *
 * Measured before and after on this tree: the old version removed 59.5% of
 * web/src, and the four native dialogs it hid had been added AFTER the lint
 * with the suite green throughout.
 */
function stripNoise(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

describe("no native dialogs", () => {
  it("nothing calls window.confirm / prompt / alert", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const code = stripNoise(readFileSync(file, "utf8"));
      // The dialog component defines its own local `confirm` helper, which is
      // the replacement, not an instance of the problem.
      if (file.endsWith("ConfirmDialog.tsx")) continue;
      for (const m of code.matchAll(NATIVE)) {
        // `const confirm = () => …` inside a component is a local callback.
        const before = code.slice(Math.max(0, m.index - 30), m.index);
        if (/\b(const|let|function)\s+$/.test(before)) continue;
        hits.push(`${file.slice(SRC.length + 1)}: ${m[1]}(`);
      }
    }
    // Named in full: the point is that the failure tells you where to look.
    expect(hits).toEqual(ALLOWED);
  });

  it("and the scan can still see the code it is judging", () => {
    /*
     * THE GUARD ON THE GUARD, and this file is the reason it exists.
     *
     * Both of this lint's halves failed open. `(?<![\w.$])` was meant to skip
     * `foo.confirm(` and skipped `window.confirm(` with it — which is how every
     * one of these is written when nobody is thinking about a lint. And
     * `stripNoise` matched `'...'` across newlines, so a lone apostrophe in
     * prose (`tmux's own C-b`) ate everything up to the next one, forty lines
     * below, `window.confirm` included.
     *
     * Four native dialogs were added AFTER this file, with the suite green the
     * whole time. Green because sane and green because blind look identical
     * from the outside, so the amount actually read is now an assertion.
     */
    /*
     * The exact shape that hid `SettingsModal.tsx:2776`, as a fixture: an
     * apostrophe in ordinary prose, and a native call some lines below it.
     * With `'...'` allowed to span newlines the first eats the second and this
     * scan returns nothing while reporting success.
     *
     * A fixture rather than a percentage. The first draft of this asserted that
     * a third of web/src survived `stripNoise`, and it passed with the bug put
     * back — the broken version still left 40.5%. A threshold loose enough not
     * to fail on ordinary growth is loose enough not to fail on the bug.
     */
    const trap = [
      "const a = <p>Prefix back to tmux" + APOS + "s own C-b.</p>;",
      "function reset() {",
      '  if (!window.confirm("Reset?")) return;',
      "}",
      // The pair. One apostrophe has nothing to close with; two bracket
      // everything between them, which is what SettingsModal had.
      "const b = <p>the engine" + APOS + "s own server.</p>;",
    ].join("\n");
    expect([...stripNoise(trap).matchAll(NATIVE)].map((m) => m[1]),
      "an apostrophe above it swallowed the call").toEqual(["confirm"]);

    // And how much of the tree survives, for a reader — not an assertion,
    // because no threshold both tolerates growth and catches this.
    const kept = sources(SRC).reduce((n, f) => n + stripNoise(readFileSync(f, "utf8")).length, 0);
    const whole = sources(SRC).reduce((n, f) => n + readFileSync(f, "utf8").length, 0);
    expect(kept / whole, `${(100 * kept / whole).toFixed(1)}% of web/src survived stripNoise`)
      .toBeGreaterThan(0.33);
  });

  it("still finds a native call when one is put in front of it", () => {
    // `expect(hits).toEqual([...])` passes just as happily when the scan found
    // nothing at all, so the scan is pointed at a known offender.
    const planted = stripNoise(`function f() {\n  if (!window.confirm("x")) return;\n}`);
    expect([...planted.matchAll(NATIVE)].map((m) => m[1])).toEqual(["confirm"]);
  });
});
