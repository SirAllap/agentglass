/*
 * tmux and nvim kept a days-stale palette: the theme was broadcast only on a
 * deliberate switcher click (pickTheme → sync), never when the cockpit restored
 * the saved theme on boot. So the machine's terminals stayed on whatever was
 * last clicked while the app itself moved on.
 *
 * These guard the boot re-sync, and — the part that matters for safety — that it
 * fires only from the desktop shell. A phone or a paired browser reaches the
 * same server; neither may repaint the host's terminals just by loading.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the cockpit re-syncs the theme on boot", () => {
  const main = src("../src/main.tsx");

  test("boot applies the saved theme WITH sync, not silently", () => {
    expect(main).toMatch(/applyTheme\(\s*initialTheme\(\),\s*\{\s*sync:/);
  });

  test("and only from the desktop shell — never a blanket broadcast", () => {
    // A bare `sync: true` here would let a phone or a paired browser repaint the
    // host's tmux/nvim just by opening the cockpit.
    expect(main).toContain("IS_DESKTOP");
    expect(main, "boot does a blanket broadcast").not.toMatch(/initialTheme\(\),\s*\{\s*sync:\s*true\s*\}/);
  });
});

describe("IS_DESKTOP marks the local desktop shell", () => {
  const api = src("../src/lib/api.ts");

  test("is exported, derived from the shell's injected apiOrigin", () => {
    expect(api).toMatch(/export const IS_DESKTOP\b/);
    // DESKTOP_API is window.agentglass.apiOrigin, present only in the packaged
    // shell — a phone or paired browser never has it.
    expect(api).toMatch(/IS_DESKTOP[^\n]*=\s*!!\s*DESKTOP_API/);
  });
});
