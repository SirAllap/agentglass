/*
 * The usage placeholders in the top bar pulse while no usage answer has come.
 * They sit there for as long as the window is open when the server is quiet,
 * so a smooth ease repainted every frame (60 draws/s idle, caught by `make
 * smoke`). Source-level: stepped, on the shared clock, paused when idle.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const css = read("../src/index.css");

describe("the usage placeholder pulse", () => {
  test("is stepped, not an eased loop", () => {
    expect(css).toMatch(/\.agx-daybar-pulse \{ animation: agx-daybar-step 1\.4s steps\(1, end\) infinite; \}/);
  });
  test("pauses when idle", () => {
    expect(css).toContain(':root[data-idle="1"] .agx-daybar-pulse');
  });
  test("every user takes the shared phase, not a per-slot stagger", () => {
    for (const f of ["TopBar.tsx", "PlanPace.tsx"]) {
      const src = read(`../src/components/${f}`);
      expect(src).toContain("sharedPhase(1400)");
      expect(src).not.toContain("animationDelay: `${i * 80}ms`");
    }
  });
});
