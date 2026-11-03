import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/*
 * The browser's agent dock draws its words through class names that live in
 * index.css, and every other stylesheet in the app is global too: one that
 * defines a rule for the same name restyles the dock wherever both are mounted.
 * PrPanel's viewed switch was `.agx-sw`, the same name as the dock's word host,
 * and gave every word a 14 px dark strip at its top and a knob over its icon,
 * on a blank page as much as any other. So: no file but index.css may write a
 * rule for a class the dock uses.
 */
const SRC = join(import.meta.dir, "../src");
const dock = await Bun.file(join(SRC, "components/browser/AgentPresence.tsx")).text();
const classes = [...new Set(dock.match(/(?<![\w-])agx-[a-z0-9-]*[a-z0-9]/g) ?? [])];

const files = (readdirSync(SRC, { recursive: true }) as string[])
  .filter((f) => /\.(css|tsx?)$/.test(f) && f !== "index.css");
const sources = await Promise.all(files.map(async (f) => [f, await Bun.file(join(SRC, f)).text()] as const));

/** A rule for `.name`: the selector runs on to a `{` without leaving a string, so `querySelector(".name")` is not one. */
const ruleFor = (name: string) => new RegExp(`\\.${name}(?![\\w-])(?:\\[[^\\]\\n]*\\]|[^{};\\n"'\`[])*\\{`);

describe("agent dock class names", () => {
  test("the dock uses the classes this guard checks", () => {
    expect(classes).toContain("agx-presence-dock");
    expect(classes).toContain("agx-swap");
    expect(classes).toContain("agx-swap-lay");
  });

  test("no stylesheet but index.css writes a rule for one of them", () => {
    const clashes = sources.flatMap(([f, text]) => classes.filter((c) => ruleFor(c).test(text)).map((c) => `${f}: .${c}`));
    expect(clashes).toEqual([]);
  });

  test("the guard sees a clash written the way PrPanel writes its sheet", () => {
    expect(ruleFor("agx-swap").test('.agx-swap{position:relative;height:14px}')).toBe(true);
    expect(ruleFor("agx-swap").test('.agx-swap[data-on="1"]::after{transform:none}')).toBe(true);
    expect(ruleFor("agx-swap").test('el.querySelector(".agx-swap")')).toBe(false);
    expect(ruleFor("agx-swap").test('if (el.querySelector(".agx-swap")) {')).toBe(false);
    expect(ruleFor("agx-swap").test('.agx-swap-lay { gap: 8px; }')).toBe(false);
  });
});
