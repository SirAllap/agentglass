/**
 * Opening a window for somebody must not move them out of their own.
 *
 * A tmux session here is per checkout, so a window opened for a DIFFERENT
 * worktree lands in another session and never shows on the tab strip —
 * reported as "that tab doesn't show up in the terminal".
 *
 * The obvious fix was to switch the client onto it. That was WORSE, and it
 * shipped for a few minutes: `switch-client` takes the whole terminal to the
 * other session, so four windows of somebody's own work left the strip at once
 * — "I've completely lost my tmux, the one that had my work sessions in it".
 * Nothing was lost, and being shown that mid-task is still not something an
 * app may do.
 *
 * This file exists so the appealing version of that fix cannot come back.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/terminal.ts", import.meta.url), "utf8");

/** The `issue` branch, to the end of its block. */
function issueBranch(): string {
  const at = SRC.indexOf('if (msg.cmd === "issue") {');
  expect(at, "the issue handler moved").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = SRC.indexOf("{", at); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error("unbalanced");
}

describe("opening a window for somebody", () => {
  test("it does NOT switch their client to another session", () => {
    const b = issueBranch();
    expect(b, "switch-client takes the whole terminal with it").not.toContain("focusPaneAnywhere");
    expect(b).not.toContain("switch-client");
  });

  test("and the note still names where it went", () => {
    /* Until the strip can show windows from other sessions, the note is the
       only thing telling somebody where their window is. Removing the switch
       must not also remove that. */
    const pr = readFileSync(new URL("../../web/src/components/PrPanel.tsx", import.meta.url), "utf8");
    expect(pr).toContain("Claude is on it in a tmux window");
  });

  test("the reasoning is written down where the next person will read it", () => {
    /* The switch is the obvious fix and it will be reached for again. */
    expect(SRC).toContain("DO NOT MOVE THE PERSON'S TERMINAL");
  });
});
