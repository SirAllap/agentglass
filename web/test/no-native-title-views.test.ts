/*
 * No native tooltip left in Lantern, Manifest and the Settings leftovers.
 *
 * The house tooltip is TipHost: an element carries `data-tip` and one host
 * draws the card. A `title=` on a plain DOM tag shows the browser's own grey
 * box instead, late and unstyled, beside the house one on the next control.
 * These three views were moved to `data-tip`; this file fails the day one
 * of them gets a native `title` back.
 *
 * Source-level, like house-style.test.ts. Only lowercase tags count: a
 * `title` prop on a component (Badge, Button, SettingsCard) is that
 * component's own contract, not the browser's attribute.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const COMPONENTS = resolve(import.meta.dir, "../src/components");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return tsxFiles(p);
    return p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
  });
}

const ALL = tsxFiles(COMPONENTS).map((f) => relative(COMPONENTS, f));

/** `file:line <tag title=` for every native title on a lowercase tag. */
function nativeTitles(rel: string): string[] {
  const text = readFileSync(join(COMPONENTS, rel), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\btitle=[{"']/g)) {
    const at = m.index ?? 0;
    const open = text.lastIndexOf("<", at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(text.slice(open, open + 40));
    if (tag && /^[a-z]/.test(tag[1])) out.push(`${rel}:${text.slice(0, at).split("\n").length} <${tag[1]} title=`);
  }
  return out;
}

const VIEWS: [string, RegExp][] = [
  ["Lantern", /^Lantern/],
  ["Manifest", /^(ManifestView|manifestView)/],
  ["Settings leftovers", /^(settings\/|Settings|Setting|settings|RemoteAccess|ReviewPrompts|SavedReplies|engines\/)/],
];

describe("no native title= on a DOM tag", () => {
  for (const [view, rx] of VIEWS) {
    test(view, () => {
      const files = ALL.filter((f) => rx.test(f));
      expect(files.length).toBeGreaterThan(0);
      expect(files.flatMap(nativeTitles)).toEqual([]);
    });
  }
});
