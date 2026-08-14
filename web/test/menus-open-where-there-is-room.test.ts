/*
 * A menu opens where there is room for it.
 *
 * `BasePicker` learned this the first time: a row at the bottom of a long list
 * opened a list that ran off the screen, so the options at the end were the ones
 * nobody could reach. `Select` — which is the app's replacement for every native
 * dropdown — never did, and it always opened downward from the trigger.
 *
 * Reported on the ClickUp status picker: "este desplegable está mal, está como
 * dentro del contenedor y no puedo ver todas las opciones, además debe abrirse
 * para arriba, al estar tan cerca de la parte baja". Two faults in one sentence,
 * and this file holds both halves of the answer — the control portals out of
 * whatever clips it, and it flips when down does not fit.
 *
 * Source text: the decision is three lines of layout maths in a
 * `useLayoutEffect`, and this repo has no DOM harness to open a menu in. What is
 * asserted is the rule, at the place it is written.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, "..", "src", "components", f), "utf8");
const SELECT = read("Select.tsx");
const BASE = read("BasePicker.tsx");

describe("Select", () => {
  test("flips above the trigger when below does not fit and above is roomier", () => {
    expect(SELECT).toContain("const up = below < 220 && above > below;");
    // Anchored by its bottom when flipped, or the list would grow downward from
    // a top computed for the other direction.
    expect(SELECT).toContain("bottom: up ? window.innerHeight - r.top + 6 : undefined,");
    expect(SELECT).toContain("...(pos.bottom == null ? { top: pos.top } : { bottom: pos.bottom }),");
  });

  test("takes its height from the room it actually has", () => {
    /* `min(60vh, 420px)` is a guess about the window, not about this trigger:
       a control 200px from the bottom got a list 400px tall whichever way it
       opened. */
    expect(SELECT).toContain("maxHeight: Math.max(180, Math.min(420, up ? above : below)),");
    expect(SELECT).not.toContain('maxHeight: "min(60vh, 420px)"');
  });

  test("still leaves its container, which is the other half of the same bug", () => {
    expect(SELECT).toContain("<Portal z={LAYER.menu}>");
  });
});

describe("the rule is the one BasePicker already had", () => {
  test("both menus decide it the same way", () => {
    // Two menus that flip on different thresholds are two menus that feel
    // different for no reason anybody could name.
    expect(BASE).toContain("const up = below < 220 && above > below;");
  });
});
