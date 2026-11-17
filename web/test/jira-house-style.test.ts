/*
 * The Jira view explains itself with the one tooltip (TipHost), never the
 * browser's own `title`.
 *
 * Two ways a native title gets in, and both are locked here:
 *
 *   1. `title=` on a lowercase DOM tag (`<button title=…>`): the browser draws
 *      it, late and unstyled, beside the TipHost card or instead of it.
 *   2. `title=` on Chrome's `<Button>` without a `data-tip`: Button forwards
 *      `title` to the native attribute and only drops it when the element
 *      carries `data-tip` (workspace/Chrome.tsx). So a `<Button title=…>` in
 *      this view is a native title in disguise; the house way is `data-tip=`.
 *
 * Source-level, like house-style.test.ts. The files are the Jira view as the
 * house-style audit drew it: components/jira/**, Jira*, Tracker*, ClickUp*,
 * MergeJiraCard.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const COMPONENTS = resolve(import.meta.dir, "..", "src", "components");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const JIRA_VIEW = /^(jira\/|Jira|MergeJiraCard|Tracker|ClickUp)/;
const files = tsxFiles(COMPONENTS).filter((p) => JIRA_VIEW.test(relative(COMPONENTS, p)));

/** The opening tag that starts at `at`, braces balanced so `=>` and `{…}` do not end it early. */
function openingTag(src: string, at: number): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return src.slice(at, i + 1);
  }
  return src.slice(at);
}

function lineOf(src: string, at: number): number {
  return src.slice(0, at).split("\n").length;
}

describe("Jira view: no native title", () => {
  test("the view has files to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test("no title= on a DOM tag", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<([a-z][\w-]*)\b/g)) {
        const tag = openingTag(src, m.index!);
        if (/\stitle=[{"']/.test(tag)) bad.push(`${relative(COMPONENTS, f)}:${lineOf(src, m.index!)} <${m[1]}>`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("no <Button title=> without a data-tip", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/<Button\b/g)) {
        const tag = openingTag(src, m.index!);
        if (/\stitle=[{"']/.test(tag) && !tag.includes("data-tip")) bad.push(`${relative(COMPONENTS, f)}:${lineOf(src, m.index!)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
