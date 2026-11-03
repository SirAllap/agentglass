/*
 * The Agents view could only flip the rules that were already there, and the
 * CLI was the only way to write one. "Add a rule" on a card opens a form that
 * posts to the same door, scoped to that card: the project's root, or `"*"` on
 * the base card. "Full access for this repo" is the project cards' one click:
 * four allow rules, and the same four taken out again.
 *
 * There is no renderer in this project, so the control is asserted against the
 * section's source, with its comment lines stripped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_PROJECT, type AgentRule } from "../../shared/agentRules.ts";
import { FULL_ACCESS_RULES, actionKeyOf, fullAccessOn, fullAccessRemovals, fullAccessRequests, newRuleRequest } from "../src/lib/agentRulesView.ts";

const ORBIT = "/home/dev/code/acme/orbit";
const SECTION = readFileSync(join(import.meta.dir, "..", "src", "components", "agents", "AgentRulesSection.tsx"), "utf8")
  .split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

/** One function's own source, from `function name(` to the next top-level one. */
function body(name: string): string {
  const start = SECTION.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = SECTION.indexOf("\nfunction ", start + 1);
  return SECTION.slice(start, next < 0 ? undefined : next);
}

const rule = (match: string, setting: AgentRule["setting"], pending = false): AgentRule => ({
  id: `ar_${match}`, project: ORBIT, action: "x", match, setting, source: "you", by: "you", at: 1,
  ...(pending ? { pending: true } : {}),
});

describe("a rule written by hand", () => {
  test("a card's form writes to that card's project, and naming it keeps the name", () => {
    /* The request the door takes: no field it does not know, and no empty action. */
    expect(newRuleRequest(ORBIT, "Bash(npm publish:*)", "", "never"))
      .toEqual({ root: ORBIT, match: "Bash(npm publish:*)", setting: "never" });
    expect(newRuleRequest(BASE_PROJECT, " Edit docs/** ", "Ship code", "allow"))
      .toEqual({ root: "*", match: "Edit docs/**", setting: "allow", action: "ship.code" });
    expect(actionKeyOf("   ")).toBe("");
    expect(actionKeyOf("2fa check")).toBe("");

    /* The control exists on both cards, and the segmented control always has one setting lit. */
    expect(SECTION).toContain("Add a rule");
    expect(SECTION).toContain('<AddRule root={BASE_PROJECT} where="in every project"');
    expect(SECTION).toContain("<AddRule root={root} where={`in ${label}`}");
    expect(SECTION).toContain("add(newRuleRequest(root, pattern, name, setting))");
    expect(SECTION).toContain("<Tri value={setting}");
    expect(SECTION).toContain("const add = (r: RuleRequest) => run(NEW_RULE, () => api.agentRuleSet(r));");
  });
});

describe("full access for one repo", () => {
  test("writes the four allow rules and takes exactly those four out again", () => {
    /* The force push is one of them: it otherwise asks whatever allows `git push`. */
    expect(FULL_ACCESS_RULES).toEqual(["Bash", "Edit", "Write", "Bash(git push --force-with-lease:*)"]);
    expect(fullAccessRequests(ORBIT))
      .toEqual(FULL_ACCESS_RULES.map((match) => ({ root: ORBIT, match, setting: "allow" })));
    expect(fullAccessRemovals(ORBIT))
      .toEqual(FULL_ACCESS_RULES.map((match) => ({ root: ORBIT, match, remove: true })));
  });

  test("is on only when all four are allow and in force", () => {
    const all = FULL_ACCESS_RULES.map((match) => rule(match, "allow"));
    expect(fullAccessOn(all)).toBe(true);
    expect(fullAccessOn(all.filter((r) => r.match !== "Write"))).toBe(false);
    expect(fullAccessOn(all.map((r) => (r.match === "Bash" ? { ...r, setting: "ask" } : r)))).toBe(false);
    /* A write waiting on a click is not "on" yet: the flow shows it as pending and this stays off. */
    expect(fullAccessOn(all.map((r) => (r.match === "Bash" ? { ...r, pending: true } : r)))).toBe(false);
    expect(fullAccessOn([])).toBe(false);
  });

  test("the option is on every project card, never on the base card", () => {
    expect(SECTION).toContain("Full access for this repo");
    expect(SECTION).toContain("Back to default");
    expect(SECTION).toContain("data-tip={tipAttr(on");
    expect(SECTION).toContain("Narrower rules still win");

    /* The project card passes the learned rules and the batch write; one action, one reload. */
    expect(body("ProjectCard"))
      .toContain("full={{ on: fullAccessOn(view.learned), write: (on) => fullAccess(root, on) }}");
    expect(body("AddRule")).toContain("<FullAccess on={full.on}");
    expect(SECTION).toContain("...requests.map((r) => () => api.agentRuleSet(r))");

    /* The base card is global, the projects not listed below included: it has the form and no full access. */
    const base = body("BaseCard");
    expect(base).toContain("<AddRule root={BASE_PROJECT}");
    expect(base).not.toContain("full=");
    expect(base).not.toContain("FullAccess");
    expect(base).not.toContain("Full access");
  });

  test("the removal asks once, inline, and names exactly the four rules", () => {
    const full = body("FullAccess");
    expect(full).toContain("Remove those four rules from this project?");
    expect(full).toContain("<Button size=\"compact\" tone=\"danger\" disabled={busy} onClick={remove}>Remove</Button>");
    expect(full).toContain("onClick={() => setAsk(false)}>Keep</Button>");
    expect(full).not.toContain("<dialog");
  });
});
