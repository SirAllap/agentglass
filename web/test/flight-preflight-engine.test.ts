/*
 * What the Preflight card says about the engine it really runs on.
 *
 * The card used to name Sonnet while Orchestration said OpenCode, and the run
 * went to `claude -p`. The label and the fallback sentence come from the same
 * function the server runs (shared/preflightEngine.ts), so the card cannot
 * promise an engine the run will not use; and the cost line says the engine did
 * not report one instead of reading as $0.00.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { preflightFallbackNote, preflightLabel, preflightTarget } from "../../shared/preflightEngine.ts";
import { costText, ranOn, type Certificate } from "../src/lib/flightPlan.ts";

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const cert = (patch: Partial<Certificate>): Certificate => ({
  id: "pc_orbit", createdAt: 1791655314000, model: "sonnet", costUsd: 0,
  files: [], mockups: [], skipped: [], sawConversation: false, isolation: "x", findings: [], ...patch,
});

describe("the card's one line", () => {
  test("Claude, OpenCode, and the sentence when the Reviewer is on an engine a Preflight cannot run", () => {
    expect(preflightLabel(preflightTarget({ provider: "claude", model: "sonnet" }))).toBe("Claude · sonnet");
    expect(preflightLabel(preflightTarget({ provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" }))).toBe("OpenCode · deepseek-v4.1-flash");
    expect(preflightFallbackNote(preflightTarget({ provider: "qwen", model: "qwen-plus" }))).toBe("Preflight runs on Claude sonnet: qwen is not supported here yet");
  });
});

describe("what the certificate says ran", () => {
  test("the engine and model that really ran, and the model alone on an older certificate", () => {
    expect(ranOn(cert({ engine: "opencode", model: "deepseek-v4.1-flash" }))).toBe("OpenCode · deepseek-v4.1-flash");
    expect(ranOn(cert({ engine: "claude", model: "sonnet" }))).toBe("Claude · sonnet");
    expect(ranOn(cert({ model: "sonnet" }))).toBe("sonnet");
  });

  test("a cost the engine did not report is said, never shown as $0.00", () => {
    expect(costText(cert({ costUsd: 0, costKnown: false }))).toBe("cost not reported");
    expect(costText(cert({ costUsd: 0.0123 }))).toBe("$0.01");
  });
});

describe("the Preflight card", () => {
  const tab = src("components/flightPlan/SettingsTab.tsx");
  const row = (() => {
    const at = tab.indexOf('title="Model · cap per run"');
    expect(at).toBeGreaterThan(-1);
    const end = tab.indexOf("</PilotRow>", at);
    return tab.slice(at, end);
  })();

  test("shows the engine and model from the shared function, not a bare model", () => {
    expect(tab).toContain("const targetLine = target ? preflightLabel(target) : s.model;");
    expect(row).toContain("{targetLine}");
    expect(row).not.toContain("{s.model}");
  });

  test("the card's engine follows the selected project, from the server that runs it", () => {
    expect(tab).toContain("api.flightPreflightTarget(picked)");
    expect(tab).toContain("}, [picked]);");
    expect(tab).toContain("target={target}");
    expect(tab).not.toContain("api.workerRoles()");
  });

  test("keeps 'Change in Orchestration' only while Orchestration decides what a Preflight runs on", () => {
    expect(tab).toContain("const fallback = target ? preflightFallbackNote(target) : null;");
    expect(row).toContain("hint={fallback ??");
    expect(row).toContain("{!fallback && <button");
    expect(src("../../shared/preflightEngine.ts")).toContain("is not supported here yet");
  });
});
