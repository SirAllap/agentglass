import { describe, expect, it } from "bun:test";

/*
 * The legend and the handler, checked against each other.
 *
 * A keyboard model nobody can discover is the same as not having one, and a
 * legend that lists a key nothing implements is worse than none at all — it
 * sends somebody pressing a key and concluding the app is broken. So the array
 * that draws the legend is read here against the branches of the handler, and
 * neither is allowed to grow without the other.
 *
 * The source is parsed rather than the component rendered: what is being
 * asserted is that two lists agree, and rendering to find that out would need
 * a DOM, a store, and a Taskwarrior.
 */
const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const { TASK_KEYS } = await import("../src/lib/taskGrammar.ts");

/** The bare keys the handler actually branches on. */
const handled = new Set<string>();
for (const m of src.matchAll(/k === "([^"]+)"/g)) handled.add(m[1]!);
// `Escape` is matched off `e.key` before the `k` shorthand exists, and Enter
// shares its branch with the space bar.
if (/e\.key === "Escape"/.test(src)) handled.add("Escape");

/** What the legend claims. */
const advertised = TASK_KEYS.flatMap((k) => k.keys);
const canon = (k: string) => k;

describe("the legend and the handler", () => {
  it("advertises nothing the handler does not implement", () => {
    for (const k of advertised) {
      expect(handled.has(canon(k)), `the legend offers "${k}" and nothing handles it`).toBe(true);
    }
  });

  it("hides nothing the handler implements", () => {
    // Arrow keys are the same branch as j/k and are not worth a legend entry;
    // capital G is listed as part of "g / G".
    const silent = new Set(["ArrowDown", "ArrowUp", " ", "i"]);
    const shown = new Set(advertised.map(canon));
    for (const k of handled) {
      if (silent.has(k)) continue;
      expect(shown.has(k), `"${k}" works and nobody is told about it`).toBe(true);
    }
  });

  it("says something about every key it lists", () => {
    for (const k of TASK_KEYS) {
      expect(k.what.trim().length, k.keys.join()).toBeGreaterThan(2);
      expect(k.keys.length, k.what).toBeGreaterThan(0);
    }
  });

  it("lists each key once", () => {
    const seen = advertised.map(canon);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
