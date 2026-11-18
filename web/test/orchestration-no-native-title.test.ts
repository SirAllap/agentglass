/*
 * No native tooltip left in the Starboard agent sections.
 *
 * The house tooltip is TipHost: an element carries `data-tip` and one host
 * draws the card. A `title=` on a plain DOM tag shows the browser's own grey
 * box instead, late and unstyled. AgentsSections.tsx was moved to `data-tip`;
 * this file fails the day it gets a native `title` back.
 *
 * Source-level, like no-native-title-browser.test.ts. Only lowercase tags
 * count: `title` on SectionHead or Empty is that component's own prop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const COMPONENTS = resolve(import.meta.dir, "../src/components");
const FILES = ["agents/AgentsSections.tsx"];

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

describe("Starboard agent sections: house tooltip", () => {
  test("no native title= on a DOM tag", () => {
    expect(FILES.flatMap(nativeTitles)).toEqual([]);
  });

  test("icon sizes on a rung use ICON", () => {
    const text = readFileSync(join(COMPONENTS, FILES[0]), "utf8");
    expect([...text.matchAll(/<Ph [^>]*size=\{(12|14|16|18)\}/g)].map((m) => m[0])).toEqual([]);
  });
});
