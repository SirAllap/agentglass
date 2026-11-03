/*
 * The Jira list and card dock run on the house tokens in both themes: no colour literal, and every gap, padding and margin
 * a number of the spacing scale (0/2/4/6/8/12/16/24, and 10 as a control's inline padding). A literal paints one theme only,
 * and an odd number is a gap nobody chose; both were found by grep after the slices were written, so this keeps them out.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
};
const FILES = [
  ...walk(join(SRC, "components/jira/list")),
  ...["DockParts", "JiraCard", "JiraFacts", "JiraSections", "JiraActivity", "JiraCardPrs", "JiraDev", "JiraJoins", "JiraDescription", "JiraFollow"].map((n) => join(SRC, `components/jira/${n}.tsx`)),
  join(SRC, "components/tasks/ReadOnlyNote.tsx"), join(SRC, "components/tasks/WritesSwitch.tsx"),
];
const lines = (f: string): [number, string][] =>
  readFileSync(f, "utf8").split("\n").map((l, i): [number, string] => [i + 1, l]).filter(([, l]) => !/^\s*(\/\/|\/\*|\*)/.test(l));

describe("the Jira list and dock files", () => {
  test("no colour literal", () => {
    const found = FILES.flatMap((f) => lines(f).filter(([, l]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(l)).map(([n]) => `${f.slice(SRC.length)}:${n}`));
    expect(found).toEqual([]);
  });

  test("every gap, padding and margin is on the scale", () => {
    const ON = new Set([0, 1, 2, 4, 6, 8, 10, 12, 16, 24]);
    const prop = /\b(?:gap|row-gap|column-gap|rowGap|columnGap|padding[A-Za-z-]*|margin[A-Za-z-]*)\s*:\s*([^;,}]+)/g;
    const found: string[] = [];
    for (const f of FILES) for (const [n, l] of lines(f)) {
      for (const m of l.matchAll(prop)) {
        if (/^\s*"?(var|calc)/.test(m[1]!)) continue;
        for (const v of m[1]!.matchAll(/(-?\d+(?:\.\d+)?)px\b/g)) if (!ON.has(Math.abs(Number(v[1])))) found.push(`${f.slice(SRC.length)}:${n} ${m[0].trim()}`);
        for (const v of m[1]!.matchAll(/^\s*"?(-?\d+(?:\.\d+)?)\b(?!px|%|vh|vw|em|rem)/g)) if (!ON.has(Math.abs(Number(v[1])))) found.push(`${f.slice(SRC.length)}:${n} ${m[0].trim()}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("the Tailwind spacing utilities are steps of the scale", () => {
    const ON = new Set(["0", "0.5", "1", "1.5", "2", "2.5", "3", "4", "6", "px"]);
    const rx = /(?<![\w-])-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(\[[^\]]+\]|[\d.]+)(?![\w.])/g;
    const found: string[] = [];
    for (const f of FILES) for (const [n, l] of lines(f)) for (const m of l.matchAll(rx)) {
      const v = m[1]!;
      if (v.startsWith("[")) { if (/^\[(var|calc)/.test(v)) continue; for (const x of v.matchAll(/(\d+(?:\.\d+)?)px/g)) if (![0, 1, 2, 4, 6, 8, 10, 12, 16, 24].includes(Number(x[1]))) found.push(`${f.slice(SRC.length)}:${n} ${m[0]}`); }
      else if (!ON.has(v)) found.push(`${f.slice(SRC.length)}:${n} ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});
