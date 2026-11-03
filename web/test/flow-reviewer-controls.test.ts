/*
 * The reviewing block's settings live in the Flow editor's side panel. There is
 * no renderer here, so the rules are asserted on the source and on the pure
 * pieces the component exports.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextSecond, reviewerLabels } from "../src/components/orchestration/flow/ReviewerControls.tsx";
import { CHECKS } from "../src/components/orchestration/flow/flowCopy.ts";
import { REVIEW_WHO } from "../../shared/reviewSettings.ts";

const SRC = join(import.meta.dir, "..", "src", "components", "orchestration", "flow");
const isComment = (l: string) => ["//", "*", "/*"].some((m) => l.trim().startsWith(m));
const code = (f: string) => readFileSync(join(SRC, f), "utf8").split("\n").filter((l) => !isComment(l)).join("\n");
const CTL = code("ReviewerControls.tsx");
const SIDE = code("WorkerEditor.tsx");
const CSS = readFileSync(join(SRC, "flowEditor.css"), "utf8");

describe("ReviewerControls", () => {
  test("binds the three server settings through the door", () => {
    for (const id of ["who", "rounds", "second"]) expect(CTL + code("FlowEditor.tsx")).toContain(`REVIEW_SETTING_IDS.${id}`);
    expect(CTL).toContain("api.settingAtSet(id, value, p.root)");
    expect(CTL).toContain("api.settingAt(id, p.root)");
  });
  test("the state moves only once the server kept the value", () => {
    const at = CTL.indexOf("if (!r.ok)");
    expect(at).toBeGreaterThan(-1);
    expect(CTL.indexOf("kept();", at)).toBeGreaterThan(at);
  });
  test("the labels use the flow's name for the block, never 'Reviewer'", () => {
    const l = reviewerLabels("Gatekeeper");
    expect(l.rounds).toBe("Most rounds before Gatekeeper stops");
    expect(l.second).toBe("Second Gatekeeper on another model");
    expect(Object.values(reviewerLabels("Inspector")).join(" ")).not.toContain("Reviewer");
    expect(CTL).not.toContain("Reviewer</");
  });
  test("the answers are the server's, in its order", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([...REVIEW_WHO]);
  });
  test("the second one starts on an engine the first is not on, or not at all", () => {
    const ready = (ids: string[]) => ids.map((id) => ({ id, roles: { worker: { ok: true }, orchestrator: { ok: true } } })) as never;
    expect(nextSecond({ engine: "claude" }, ready(["claude", "codex"]))?.engine).toBe("codex");
    expect(nextSecond({ engine: "claude" }, ready(["claude"]))).toBeNull();
  });
  test("the second reviewer's switch is disabled while there is no other engine", () => {
    expect(CTL).toContain("disabled={busy || (!second && !secondDefault)}");
  });
  test("the cap stays inside the setting's 1..6", () => {
    expect(CTL).toContain("rounds <= REVIEW_ROUNDS_MIN");
    expect(CTL).toContain("rounds >= REVIEW_ROUNDS_MAX");
  });
});

describe("the one worker editor", () => {
  test("draws ReviewerControls only on the reviewing block, and the plain stepper for the others", () => {
    expect(SIDE).toContain("showsReviewer(role)");
    expect(SIDE).toContain("<ReviewerControls");
    expect(SIDE).toContain("!reviewer && (");
    expect(SIDE).toContain("FLOW_ROUNDS_MAX");
  });
  test("the new rows fit the 292px panel: they stack and never force a sideways scroll", () => {
    const rules = CSS.split("\n").filter((l) => l.startsWith(".fe-revctl") || l.startsWith(".fe-who") || l.startsWith(".fe-revsecond")).join("\n");
    expect(rules).not.toContain("nowrap");
    expect(rules).not.toContain("min-width: 3");
    expect(CSS).toContain(".fe-revctl * { min-width: 0; }");
  });
});
