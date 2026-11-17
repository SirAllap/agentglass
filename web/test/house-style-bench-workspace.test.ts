/*
 * The bench, the workspace chrome, the projects modal, setup and insights
 * explain themselves through the one tooltip (TipHost, `data-tip`), never the
 * browser's native `title`: a native title is a different box on every
 * platform and opens over the house card. One test per view, so a `title=` that
 * comes back names the view it came back in.
 *
 * A `title=` on a component (`<StateCard title=…>`, `<Chip title=…>`) is a prop,
 * not the native attribute, and is allowed: only lowercase DOM tags are checked.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src", "components");

const VIEWS: Record<string, RegExp> = {
  bench: /^(bench\/|Bench)/,
  workspace: /^workspace\//,
  projects: /^projects\//,
  setup: /^setup\//,
  insights: /^(insights\/|Insights)/,
};

function files(dir = SRC, rel = ""): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const r = rel ? `${rel}/${n}` : n;
    if (statSync(p).isDirectory()) return files(p, r);
    return /\.tsx$/.test(n) && !n.includes(".test.") ? [r] : [];
  });
}

/** Every native `title=` on a lowercase DOM tag, as `file:line <tag`. */
function nativeTitles(rel: string): string[] {
  const t = readFileSync(join(SRC, rel), "utf8");
  const out: string[] = [];
  for (const m of t.matchAll(/(?<![\w-])title=[{"']/g)) {
    const i = m.index ?? 0;
    const open = t.lastIndexOf("<", i);
    const tag = /^<([A-Za-z][\w.]*)/.exec(t.slice(open, open + 40))?.[1];
    // A prop on a component, or a `<` that opened a component inside an earlier prop.
    if (!tag || tag[0] !== tag[0].toLowerCase()) continue;
    const between = t.slice(open, i);
    if (/\/>|<\/|>\s*</.test(between)) continue;
    out.push(`${rel}:${t.slice(0, i).split("\n").length} <${tag}`);
  }
  return out;
}

const ALL = files();

describe("house style: no native title in bench / workspace / projects / setup / insights", () => {
  for (const [view, rx] of Object.entries(VIEWS)) {
    test(view, () => {
      const mine = ALL.filter((f) => rx.test(f));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.flatMap(nativeTitles)).toEqual([]);
    });
  }
});
