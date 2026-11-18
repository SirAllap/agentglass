/*
 * The deny list a launch carries in one project, as a pure question: the
 * global `launch.deny` read through that project's rules, plus the project's
 * own nevers, and nothing a CLI would refuse that the rules let through.
 */
import { describe, expect, test } from "bun:test";
import { launchDenyFor, type AgentRule, type RuleSetting } from "../../shared/agentRules.ts";

const ORBIT = "/work/acme/orbit";
const LEDGER = "/work/acme/ledger";
const GLOBAL = ["Bash(gh pr merge:*)", "Bash(gh release:*)"];
let n = 0;
const rule = (match: string, setting: RuleSetting, project = "*", extra: Partial<AgentRule> = {}): AgentRule =>
  ({ id: `ar_${n++}`, project, action: `a${n}`, match, setting, source: "you", by: "you", at: 1, ...extra });
const base = GLOBAL.map((m) => rule(m, "never"));

describe("launchDenyFor", () => {
  test("no project: the global list, as it always was", () => {
    expect(launchDenyFor(base, "", [...GLOBAL, GLOBAL[0]!])).toEqual(GLOBAL);
  });

  test("a project with no rules of its own carries the global list", () => {
    expect(launchDenyFor(base, ORBIT, GLOBAL)).toEqual(GLOBAL);
  });

  test("a global entry no stored rule reads stays", () => {
    expect(launchDenyFor([], ORBIT, ["Bash(npm publish:*)"])).toEqual(["Bash(npm publish:*)"]);
  });

  test("a project's own never joins its launches, and only its own", () => {
    const rules = [...base, rule("Bash(git push:*)", "never", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, GLOBAL)).toEqual([...GLOBAL, "Bash(git push:*)"]);
    expect(launchDenyFor(rules, LEDGER, GLOBAL)).toEqual(GLOBAL);
  });

  test("a project allow never drops a global deny", () => {
    // invented rule pair: global never `gh pr merge:*`, project allows one merge
    const rules = [...base, rule("Bash(gh pr merge 12)", "allow", ORBIT), rule("Bash(gh pr merge:*)", "allow", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, GLOBAL)).toEqual(GLOBAL);
  });

  test("a project ask never drops a global deny", () => {
    const rules = [...base, rule("Bash(gh release:*)", "ask", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, GLOBAL)).toEqual(GLOBAL);
  });

  test("a narrower project allow keeps the whole broad global deny", () => {
    const rules = [...base, rule("Bash(gh release view:*)", "allow", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, GLOBAL)).toEqual(GLOBAL);
  });

  test("a global entry the rule shape does not parse stays", () => {
    expect(launchDenyFor(base, ORBIT, [...GLOBAL, "not a pattern"])).toEqual([...GLOBAL, "not a pattern"]);
  });

  test("a looser change still waiting for the person changes nothing yet", () => {
    const rules = [...base, rule("Bash(gh pr merge:*)", "allow", ORBIT, { pending: true })];
    expect(launchDenyFor(rules, ORBIT, GLOBAL)).toEqual(GLOBAL);
  });

  test("a broad never a narrower allow opens part of stays with the hook", () => {
    const rules = [rule("Bash(gh:*)", "never", ORBIT), rule("Bash(gh pr view:*)", "allow", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, [])).toEqual([]);
    // without the opening it goes in whole
    expect(launchDenyFor([rule("Bash(gh:*)", "never", ORBIT)], ORBIT, [])).toEqual(["Bash(gh:*)"]);
  });

  test("a project never under a broader project allow still goes in", () => {
    const rules = [rule("Bash(git:*)", "allow", ORBIT), rule("Bash(git push:*)", "never", ORBIT)];
    expect(launchDenyFor(rules, ORBIT, [])).toEqual(["Bash(git push:*)"]);
  });

  test("a seat's own rule and the permission mode are not a launch's", () => {
    const rules = [
      rule("Bash(make deploy:*)", "never", ORBIT, { role: "seat" }),
      rule("launch.mode", "never", ORBIT, { action: "launch.mode" }),
    ];
    expect(launchDenyFor(rules, ORBIT, [])).toEqual([]);
  });

  test("a rule with several spellings carries each one", () => {
    const rules = [rule("Bash(npm publish:*)", "never", ORBIT, { matches: ["Bash(npm publish:*)", "Bash(pnpm publish:*)"] })];
    expect(launchDenyFor(rules, ORBIT, [])).toEqual(["Bash(npm publish:*)", "Bash(pnpm publish:*)"]);
  });
});
