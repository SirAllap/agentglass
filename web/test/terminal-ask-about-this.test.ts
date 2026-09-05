/*
 * "Ask about this": a selection in a pane becomes a question to the agent
 * that lives there — or, when nothing there is an agent, a fresh chat on the
 * bench — without copy, paste and explaining where it came from.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { askAboutText, subscribeSelection, currentSelection } from "../src/components/TerminalPanel.tsx";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("the message", () => {
  test("is the note, then the selection quoted line by line — material, not instructions", () => {
    expect(askAboutText("Traceback (most recent call last):\n  File x.py\nKeyError: 'id'\n\n", "why does this fail?"))
      .toBe("why does this fail?\n\n> Traceback (most recent call last):\n>   File x.py\n> KeyError: 'id'\n");
  });
  test("an empty note still says what this is, and a whole scrollback is cut at 120 lines", () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const t = askAboutText(long, "   ");
    expect(t.startsWith("About this:\n\n> line 0\n")).toBe(true);
    expect(t.split("\n").filter((l) => l.startsWith("> ")).length).toBe(120);
  });
});

describe("the wiring", () => {
  test("xterm's selection feeds the store the bar reads", () => {
    const src = read("components/TerminalPanel.tsx");
    expect(src).toContain("noteSelection(sel.trim() ? sel : \"\");");
    expect(src).toContain("useSyncExternalStore(subscribeSelection, currentSelection, () => \"\")");
    expect(typeof subscribeSelection).toBe("function");
    expect(currentSelection()).toBe("");
  });
  test("the bar offers it only with a selection, and the paste goes to the pane only when the board knows an agent there", () => {
    const src = read("components/TerminalPanel.tsx");
    expect(src).toContain("ask={selection && onAsk ? { lines: selection.split(\"\\n\").length, onAsk } : null}");
    expect(src).toContain("const agentHere = !!paneId && (lanternRows() ?? []).some((r) => r.paneId === paneId && r.role !== \"lantern\");");
    expect(src).toContain("if (!agentHere) { void askOnBench(s.root, text, \"ask\"); return; }");
    // Bracketed, then Enter — one paste into an input box, not a line of keys.
    expect(src).toContain("d: `\\x1b[200~${text}\\x1b[201~`");
    const bar = read("components/terminal/PaneBar.tsx");
    expect(bar).toContain("Ask about this");
    expect(bar).toContain("{p.ask && (");
  });
});
