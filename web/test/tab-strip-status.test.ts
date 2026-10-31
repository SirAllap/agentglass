/*
 * Each tab says what its agent is doing, with a mark ahead of the name.
 *
 * Before this the only thing a tab could say was "finished" — its name turned
 * green — while working, waiting-for-you and error were known to the app and
 * never reached the strip. Source-level: the panel mounts xterm and a socket,
 * and none of that stands up in a test runner.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url).pathname, "utf8");
const panel = src("TerminalPanel.tsx");
const tab = src("terminal/WindowTab.tsx");
const strip = src("terminal/TermStrip.tsx");
const mark = readFileSync(new URL("../src/components/terminal/StatusMark.tsx", import.meta.url).pathname, "utf8");

describe("the tab's mark", () => {
  test("one mark, from the window's status, before the name, and none for idle", () => {
    // What counts as a mark is lib/windowMark.ts (tested there); the strip only feeds it.
    expect(strip).toContain("mark={tabMark(w)}");
    expect(strip).toContain("dead: w.dead, exitCode: w.exit, restored: w.restored, wasRunning: w.was");
    expect(tab).toContain("{mark.mark && <WindowMarkIcon mark={mark.mark} label={mark.title} />}");
    // Before the name, so every name stays where it was whatever the state.
    const at = tab.indexOf("<WindowMarkIcon");
    expect(tab.indexOf('{w.name || "shell"}', at)).toBeGreaterThan(at);
  });

  test("the green name is gone — one signal for one fact", () => {
    for (const s of [panel, tab, strip]) {
      expect(s).not.toContain("w.agentDone");
      expect(s).not.toContain('color: "var(--success, #98c379)", fontWeight: 600');
    }
  });

  test("the state is in words too: the tab's label, and no native title over the peek card", () => {
    expect(tab).not.toMatch(/\btitle=\{`\$\{w\.name/);
    expect(tab).toContain("aria-label={mark.label}");
    expect(src("terminal/WindowMarkIcon.tsx")).toContain("aria-label={label}");
  });

  test("every state has its own outline, not only its own colour", () => {
    for (const s of ["working", "waiting", "error", "done", "idle"]) {
      expect(mark).toContain(`status === "${s}" && <`);
    }
  });

  test("only working moves, and it uses the breathe reduced-motion already stops", () => {
    expect(mark).toContain('status === "working" ? { animation: "agx-phone-pulse');
    const css = readFileSync(new URL("../src/index.css", import.meta.url).pathname, "utf8");
    expect(css).toContain('[style*="agx-phone-pulse"] { animation: none !important; }');
  });
});
