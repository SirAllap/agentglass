import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const rail = src("components/settings/shell/PageRail.tsx");

describe("page rail review fixes", () => {
  test("a scope switch, or a list that drops the pinned entry, starts unpinned", () => {
    const effect = rail.slice(rail.indexOf("useEffect(() => {"));
    expect(effect).toContain("if (lastScope.current !== scopeKey) { lastScope.current = scopeKey; pinnedId.current = null; }");
    expect(effect).toContain("if (pinnedId.current && !ids.includes(pinnedId.current)) pinnedId.current = null;");
    expect(effect.indexOf("pinned.current = pinnedId.current !== null;")).toBeLessThan(effect.indexOf("IntersectionObserver ==="));
  });
  test("chip band publishes its measured height and sections use it as scroll margin", () => {
    expect(rail).toContain("--agx-rail-band");
    expect(rail).toContain("getBoundingClientRect().height");
    expect(src("components/settings/shell/Section.tsx")).toContain("scroll-mt-[var(--agx-rail-band,16px)]");
    expect(src("components/settings/shell/Section.tsx")).not.toContain("scroll-mt-4");
  });
  test("pointerdown releases the pin (the entry's own press comes before its click, which re-pins)", () => {
    expect(rail).toContain('"pointerdown"');
  });
  test("sticky top observes the column's parent too", () => {
    expect(rail).toContain("ro.observe(el.parentElement)");
  });
  test("the dead .agx-toc rules are gone", () => {
    expect(src("index.css")).not.toContain(".agx-toc");
    expect(src("index.css")).not.toContain("--agx-stick-toc");
    expect(src("components/orchestration/orchestration.css")).not.toContain(".agx-toc");
  });
});
