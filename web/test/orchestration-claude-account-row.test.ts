/*
 * The Orchestration page has a row for the Claude account a project's
 * agents use: a folder path with a Clear button, and short help text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PANE = readFileSync(join(import.meta.dir, "..", "src/components/orchestration/OrchestrationPane.tsx"), "utf8");

describe("Claude account row", () => {
  test("sits in the Sandbox card, reads and writes the setting, and can be cleared", () => {
    expect(PANE).toContain("<ClaudeAccountRow root={root} />");
    const fn = PANE.slice(PANE.indexOf("function ClaudeAccountRow"));
    expect(fn).toContain('"workers.claudeConfigDir"');
    expect(fn).toContain(">Clear</Button>");
    expect(fn).toContain('save("")');
  });

  test("help copy is at most 14 words", () => {
    const hint = /function ClaudeAccountRow[\s\S]*?hint="([^"]+)"/.exec(PANE)![1];
    expect(hint.split(/\s+/).length).toBeLessThanOrEqual(14);
  });
});
