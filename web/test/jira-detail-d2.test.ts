/*
 * The detail panel (d2), read from source because there is no renderer: the Card tab's order, the tabs, and the house rules for the
 * new files (no colour literal, spacing on the scale, `data-tip` and never `title`).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DETAIL = join(SRC, "components/jira/detail");
const FILES = [...readdirSync(DETAIL).map((f) => join(DETAIL, f)), join(SRC, "lib/cardLifecycle.ts"), join(SRC, "lib/cardDetailMenu.ts"), join(SRC, "lib/cardRoles.ts")];
const code = (f: string): [number, string][] =>
  readFileSync(f, "utf8").split("\n").map((l, i): [number, string] => [i + 1, l]).filter(([, l]) => !/^\s*(\/\/|\/\*|\*)/.test(l));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const card = strip(readFileSync(join(SRC, "components/jira/JiraCard.tsx"), "utf8"));

describe("the tabs and the Card tab's order", () => {
  test("Card, Work, Dev and Activity, and nothing else", () => {
    const ids = [...card.matchAll(/\{ id: "(\w+)" as const, label: "(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(ids).toEqual(["card:Card", "work:Work", "dev:Dev", "activity:Activity"]);
  });
  test("the Card tab is the lifecycle, then the fields, then the description; the sub-tasks and the links are on Work, before the workers", () => {
    const order = ["<LifecycleBlocks", "<JiraProps", "<JiraDescription"].map((w) => card.indexOf(w));
    expect(order.every((n) => n > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const work = card.indexOf('tab === "work"'), dev = card.indexOf('tab === "dev"');
    for (const w of ["<SubtaskTree", "<LinkedBlock", "<WebLinksBlock"]) { expect(card.indexOf(w)).toBeGreaterThan(work); expect(card.indexOf(w)).toBeLessThan(dev); }
    const tab = strip(readFileSync(join(DETAIL, "WorkTab.tsx"), "utf8"));
    expect(tab.indexOf("{hierarchy}")).toBeLessThan(tab.indexOf('id="sessions"'));
  });
  test("inside the lifecycle: headline, chips, bar, then the opened steps and timeline", () => {
    const t = strip(readFileSync(join(DETAIL, "LifecycleBlocks.tsx"), "utf8"));
    const from = t.indexOf("export function LifecycleBlocks");
    const order = ["agx-jd-next-t", "<Chips", "<StepBar", "<StageList", "<Timeline"].map((w) => t.indexOf(w, from));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
  });
  test("the old Files tab's body lives on Work, and the Development body on Dev", () => {
    expect(card).toContain('tab === "work" && <WorkTab');
    expect(card).toContain("<AttachmentsBlock");
    expect(card).toContain('tab === "dev"');
  });
  test("the header is the detail header, fed the close and next/previous the caller's head carries", () => {
    expect(card).toContain("<DetailHeader");
    expect(card).toContain("chromeOf(header(");
  });
});

describe("the header block, as the mockup has it", () => {
  const head = strip(readFileSync(join(DETAIL, "DetailHeader.tsx"), "utf8"));
  test("the key line wraps and the path has its own line, so a narrow dock never cuts the space to one letter", () => {
    expect(head).toContain('agx-jd-path min-w-0 flex items-center order-last basis-full');
  });
  test("the status pill, the worker pill and the \"...\" share a row; Send to terminal follows the primary action", () => {
    const row = head.indexOf("agx-jd-row"), actions = head.indexOf("agx-jd-actions");
    expect(head.indexOf('"More"')).toBeGreaterThan(row);
    expect(head.indexOf('"More"')).toBeLessThan(actions);
    expect(head.indexOf('data-dock="next"')).toBeLessThan(head.indexOf("Send to terminal<CaretIcon"));
  });
});

describe("the new files", () => {
  test("no colour literal", () => {
    const found = FILES.flatMap((f) => code(f).filter(([, l]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(l)).map(([n]) => `${f.slice(SRC.length)}:${n}`));
    expect(found).toEqual([]);
  });
  test("every gap, padding and margin is on the scale", () => {
    const ON = new Set([0, 1, 2, 4, 6, 8, 10, 12, 16, 24]);
    const prop = /\b(?:gap|rowGap|columnGap|padding[A-Za-z-]*|margin[A-Za-z-]*)\s*:\s*([^;,}]+)/g;
    const found: string[] = [];
    for (const f of FILES) for (const [n, l] of code(f)) for (const m of l.matchAll(prop)) {
      if (/^\s*"?(var|calc)/.test(m[1]!)) continue;
      for (const v of m[1]!.matchAll(/(-?\d+(?:\.\d+)?)px\b/g)) if (!ON.has(Math.abs(Number(v[1])))) found.push(`${f.slice(SRC.length)}:${n} ${m[0].trim()}`);
      for (const v of m[1]!.matchAll(/^\s*"?(-?\d+(?:\.\d+)?)\b(?!px|%|vh|vw|em|rem)/g)) if (!ON.has(Math.abs(Number(v[1])))) found.push(`${f.slice(SRC.length)}:${n} ${m[0].trim()}`);
    }
    expect(found).toEqual([]);
  });
  test("a hint is a data-tip, never a native title", () => {
    const found = FILES.flatMap((f) => code(f).filter(([, l]) => /\btitle=\{?["`]/.test(l) && !/<(EditText|JiraSection)/.test(l)).map(([n]) => `${f.slice(SRC.length)}:${n}`));
    expect(found).toEqual([]);
  });
  test("the lifecycle and the menus read no store and make no request", () => {
    for (const f of ["cardLifecycle.ts", "cardDetailMenu.ts"]) {
      const t = strip(readFileSync(join(SRC, "lib", f), "utf8"));
      expect(t).not.toMatch(/fetch\(|api\.|localStorage|useState|document\./);
    }
  });
  test("the panel sends no Jira write the board did not already have", () => {
    const t = strip(["SubtaskTree.tsx", "DetailHeader.tsx", "WorkTab.tsx", "LifecycleBlocks.tsx"].map((f) => readFileSync(join(DETAIL, f), "utf8")).join("\n"));
    const writes = [...t.matchAll(/api\.(jira\w+)/g)].map((m) => m[1]).sort();
    expect(writes).toEqual(["jiraRank"]);
  });
});
