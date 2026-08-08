/*
 * What the file viewer renders, and what it hands to the editor.
 *
 * The rule was always "markdown, and nothing else" — the regexp has said so
 * since it was written, under a comment explaining that code belongs in the
 * editor that knows its language. What went wrong was that a SECOND place
 * decided how to open a file and did not ask this question: the palette sent
 * anything found on another branch to the document viewer, whatever it was, so
 * a `.py` came out with its lines collapsed into paragraphs, its `**` bold and
 * its backticks as chips.
 *
 * So the answer is exported and this holds it. One regexp, one answer.
 */
import { describe, expect, test } from "bun:test";
import { isRenderable } from "../src/components/PeekFile.tsx";

describe("which files are rendered rather than edited", () => {
  test("markdown, in the spellings that mean markdown", () => {
    for (const p of ["README.md", "docs/EXTENDING.markdown", "a/b/notes.mdx", "SHOUTING.MD"]) {
      expect(isRenderable(p)).toBe(true);
    }
  });

  test("code is not, whatever it is", () => {
    // Every one of these went through the markdown renderer when opened from a
    // branch. The .py is the one that was reported.
    for (const p of [
      "scripts/validate.py", "web/src/App.tsx", "server/src/index.ts", "Makefile",
      "bun.lock", ".github/workflows/ci.yml", "src/main.rs", "index.html",
    ]) {
      expect(isRenderable(p)).toBe(false);
    }
  });

  test("a name that merely mentions markdown is not markdown", () => {
    // `.md` has to be the extension, not a substring: these are code that talks
    // about documents, and one of them is a real file in this repository.
    for (const p of ["web/src/lib/markdown.tsx", "server/src/mdcache.ts", "notes.md.bak", "md"]) {
      expect(isRenderable(p)).toBe(false);
    }
  });
});
