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
const EXTS = [".ts", ".tsx"];

/** `confirm(` / `prompt(` / `alert(` as a bare call — not `foo.confirm(`, not a
 *  local named `confirm` being declared, and not the word inside a comment. */
const NATIVE = /(?<![\w.$])(confirm|prompt|alert)\s*\(/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { sources(p, out); continue; }
    if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Comment bodies and string literals, so prose about `confirm()` and a button
 *  labelled "Confirm" don't fail the build. */
function stripNoise(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
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
    expect(hits).toEqual([]);
  });
});
