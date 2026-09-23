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

const panel = readFileSync(new URL("../src/components/TerminalPanel.tsx", import.meta.url).pathname, "utf8");
const mark = readFileSync(new URL("../src/components/terminal/StatusMark.tsx", import.meta.url).pathname, "utf8");

describe("the tab's mark", () => {
  test("drawn from the window's status, before the name, and not for idle", () => {
    expect(panel).toContain('{w.status && w.status !== "idle" && <StatusMark status={w.status} />}');
    const at = panel.indexOf("<StatusMark status={w.status} />");
    // Before the name, so every name stays where it was whatever the state.
    expect(panel.indexOf('{w.name || "shell"}', at)).toBeGreaterThan(at);
  });

  test("the green name is gone — one signal for one fact", () => {
    expect(panel).not.toContain("w.agentDone");
    expect(panel).not.toContain('color: "var(--success, #98c379)", fontWeight: 600');
  });

  test("the state is in words too: the tooltip and the mark's label", () => {
    expect(panel).toContain("agent ${STATUS_WORDS[w.status]}");
    expect(mark).toContain("aria-label={title ?? STATUS_WORDS[status]}");
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
