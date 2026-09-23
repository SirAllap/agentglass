/*
 * Rules that decide a gated call without a person — #109.
 *
 * The gate held every call it was sent until somebody answered, which only
 * catches what happens while somebody is watching. These pin the decision a
 * rule makes, in isolation from the route: what is allowed without a hold, what
 * is denied outright, what is still held, and which rule speaks for a call when
 * a project and the whole machine both have one.
 *
 * The budget is injected as a status, so the arithmetic of spend is not what is
 * being tested here — budget.ts has its own suite for that. What is tested is
 * what a rule does once a budget covering the call is already over.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetStatus, GateRule } from "../../shared/types.ts";
import { gateRuleVerdict } from "../src/gaterules.ts";
import { readGateRules } from "../src/config.ts";

const rule = (r: Partial<GateRule>): GateRule =>
  ({ root: "", allow: [], deny: [], otherwise: "hold", overBudget: "hold", ...r });

const OVER: BudgetStatus = {
  budget: { root: "", model: "", limit: 20, period: "day" },
  fromDay: "2026-01-05", toDay: "2026-01-05", spent: 23.5, pct: 1.175, level: "over",
};

// Directories that exist nowhere, so inScope answers from the prefix test and
// never reaches for git to find a worktree family.
const ORBIT = "/nonexistent/code/orbit";
const IN_ORBIT = `${ORBIT}/web`;
const ELSEWHERE = "/nonexistent/code/other";

describe("no rule, no change", () => {
  test("with no rules at all the gate holds exactly as it always has", () => {
    expect(gateRuleVerdict("Bash", IN_ORBIT, [], null).kind).toBe("none");
    expect(gateRuleVerdict("Bash", IN_ORBIT, [], OVER).kind).toBe("none");
  });

  test("a rule scoped to a project says nothing about a call made elsewhere", () => {
    const rules = [rule({ root: ORBIT, deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", ELSEWHERE, rules, null).kind).toBe("none");
  });

  test("a call from a directory nobody could place is not covered by a project rule", () => {
    // Guessing which project an agent is in is how the wrong fleet gets
    // stopped — the same edge overBudgetFor refuses.
    const rules = [rule({ root: ORBIT, deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", "", rules, null).kind).toBe("none");
  });

  test("but a rule with no root covers it, because it covers everything", () => {
    const rules = [rule({ deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", "", rules, null).kind).toBe("deny");
  });
});

describe("allow and deny lists", () => {
  const rules = [rule({ allow: ["Read", "Grep", "mcp__orbit__*"], deny: ["WebFetch"] })];

  test("a tool on the allow list is let through without a hold", () => {
    expect(gateRuleVerdict("Read", IN_ORBIT, rules, null).kind).toBe("allow");
  });

  test("a tool on the deny list is denied, and the model is told a rule did it", () => {
    const v = gateRuleVerdict("WebFetch", IN_ORBIT, rules, null);
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    // The reader is a model deciding what to do next. It must not be told a
    // person looked, and it must not be left to retry the identical call.
    expect(v.reason).toContain("WebFetch");
    expect(v.reason).toContain("not by a person");
    expect(v.reason).toContain("Do not retry");
  });

  test("a trailing star matches every tool with that prefix, and nothing else", () => {
    expect(gateRuleVerdict("mcp__orbit__search", IN_ORBIT, rules, null).kind).toBe("allow");
    expect(gateRuleVerdict("mcp__orbitx", IN_ORBIT, rules, null).kind).toBe("hold");
    // Without a star a name is exact: "Read" does not let "ReadMcpResource" through.
    expect(gateRuleVerdict("ReadMcpResource", IN_ORBIT, rules, null).kind).toBe("hold");
  });

  test("a tool on neither list is held for a person by default", () => {
    expect(gateRuleVerdict("Bash", IN_ORBIT, rules, null).kind).toBe("hold");
  });

  test("deny wins when a tool is on both lists", () => {
    const both = [rule({ allow: ["Bash"], deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, both, null).kind).toBe("deny");
  });

  test("`otherwise: deny` turns the allow list into the only tools that run", () => {
    const strict = [rule({ allow: ["Read"], otherwise: "deny" })];
    const v = gateRuleVerdict("Bash", IN_ORBIT, strict, null);
    expect(v.kind).toBe("deny");
    if (v.kind === "deny") expect(v.reason).toContain("not on the allow list");
    expect(gateRuleVerdict("Read", IN_ORBIT, strict, null).kind).toBe("allow");
  });

  test("`otherwise: allow` holds nothing but what the deny list names", () => {
    const loose = [rule({ deny: ["WebFetch"], otherwise: "allow" })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, loose, null).kind).toBe("allow");
    expect(gateRuleVerdict("WebFetch", IN_ORBIT, loose, null).kind).toBe("deny");
  });
});

describe("harness meta-tools", () => {
  // ToolSearch is a harness-internal schema fetch: nobody's rule ever lists
  // it, so a strict allow-list rule stalled a normal session on its first
  // deferred-tool call, waiting on a hold for a tool the person never chose
  // to gate. Exempted before the deny/budget/allow/otherwise chain runs at
  // all — it is not a fourth outcome the rule picked, it is not this rule's
  // business.
  test("never held, even under a rule whose otherwise is hold", () => {
    const strict = [rule({ otherwise: "hold" })];
    expect(gateRuleVerdict("ToolSearch", IN_ORBIT, strict, null).kind).toBe("allow");
  });

  test("a rule that explicitly names it on the deny list still wins — an explicit deny always beats the exemption", () => {
    const named = [rule({ deny: ["ToolSearch"], otherwise: "deny" })];
    expect(gateRuleVerdict("ToolSearch", IN_ORBIT, named, null).kind).toBe("deny");
  });

  test("but a rule that merely defaults to deny (otherwise), without naming it, still exempts it", () => {
    const strict = [rule({ otherwise: "deny" })];
    expect(gateRuleVerdict("ToolSearch", IN_ORBIT, strict, null).kind).toBe("allow");
  });

  test("an ordinary tool is unaffected — this is not a second allow list", () => {
    const strict = [rule({ otherwise: "hold" })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, strict, null).kind).toBe("hold");
  });
});

describe("over budget", () => {
  test("an allowed tool is held once a budget covering the call is over", () => {
    // The runaway loop is made of calls somebody had waved through. A limit
    // that only annotated the calls that were already held would never see it.
    const rules = [rule({ allow: ["Bash"] })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, rules, OVER).kind).toBe("hold");
  });

  test("`overBudget: deny` denies it outright and says which limit", () => {
    const rules = [rule({ allow: ["Bash"], overBudget: "deny" })];
    const v = gateRuleVerdict("Bash", IN_ORBIT, rules, OVER);
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.reason).toContain("$23.50 of $20.00");
    expect(v.reason).toContain("not by a person");
  });

  test("a budget that is not over changes nothing", () => {
    const rules = [rule({ allow: ["Bash"], overBudget: "deny" })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, rules, null).kind).toBe("allow");
  });

  test("the deny list still reads as the deny list when a budget is over too", () => {
    const rules = [rule({ deny: ["WebFetch"], overBudget: "deny" })];
    const v = gateRuleVerdict("WebFetch", IN_ORBIT, rules, OVER);
    expect(v.kind === "deny" && v.reason.includes("deny list")).toBe(true);
  });
});

describe("which rule speaks", () => {
  test("a project's rule overrides the machine's inside that project, and only there", () => {
    // The common failure is one workflow going rogue while the rest of the
    // fleet is fine, so a project can be stricter than everything else.
    const rules = [rule({ allow: ["Bash"] }), rule({ root: ORBIT, deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", IN_ORBIT, rules, null).kind).toBe("deny");
    expect(gateRuleVerdict("Bash", ELSEWHERE, rules, null).kind).toBe("allow");
  });

  test("the deeper of two project rules wins, whatever order the file lists them in", () => {
    const rules = [rule({ root: `${ORBIT}/web`, allow: ["Bash"] }), rule({ root: ORBIT, deny: ["Bash"] })];
    expect(gateRuleVerdict("Bash", `${ORBIT}/web/src`, rules, null).kind).toBe("allow");
    expect(gateRuleVerdict("Bash", `${ORBIT}/api`, rules, null).kind).toBe("deny");
  });
});

describe("reading the rules from config.json", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });
  const withConfig = (gateRules: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "agx-gaterules-"));
    mkdirSync(join(d, "agentglass"), { recursive: true });
    writeFileSync(join(d, "agentglass", "config.json"), JSON.stringify({ gateRules }));
    process.env.XDG_CONFIG_HOME = d;
  };

  test("a well-formed rule reads back with its defaults filled in", () => {
    withConfig([{ root: "~/code/orbit", deny: ["WebFetch"] }]);
    const [r] = readGateRules();
    expect(r.root.startsWith("~")).toBe(false);
    expect(r.root.endsWith("/code/orbit")).toBe(true);
    expect(r).toMatchObject({ allow: [], deny: ["WebFetch"], otherwise: "hold", overBudget: "hold" });
  });

  test("a rule that cannot be read holds everything at its root, never coerced into something plausible", () => {
    withConfig([
      { deny: "WebFetch" },            // a string, not a list
      { allow: ["Read", 3] },          // a list with a non-name in it
      { otherwise: "denny" },          // a typo of an action
      { overBudget: "allow" },         // over budget can hold or deny, not allow
      null,
      { allow: ["Read"] },             // the one that reads as written
    ]);
    const rules = readGateRules();
    expect(rules.length).toBe(5);
    for (const r of rules.slice(0, 4)) {
      expect(r).toEqual({ root: "", allow: [], deny: [], otherwise: "hold", overBudget: "hold" });
    }
    expect(rules[4].allow).toEqual(["Read"]);
  });

  test("a typo in a strict project rule does not hand the project to a lax machine rule", () => {
    // Dropping the broken rule would leave the machine's `otherwise: allow`
    // speaking for a project that was written to deny Bash.
    withConfig([
      { otherwise: "allow" },
      { root: ORBIT, allow: ["Read", ""], otherwise: "deny" },
    ]);
    const rules = readGateRules();
    expect(gateRuleVerdict("Bash", IN_ORBIT, rules, null).kind).toBe("hold");
    expect(gateRuleVerdict("Bash", ELSEWHERE, rules, null).kind).toBe("allow");
  });

  test("a root is normalised, and one that is not absolute is not a place", () => {
    withConfig([{ root: `${ORBIT}/`, deny: ["Bash"] }, { root: "code/orbit", deny: ["Bash"] }]);
    const rules = readGateRules();
    expect(rules.map((r) => r.root)).toEqual([ORBIT]);
    expect(gateRuleVerdict("Bash", ORBIT, rules, null).kind).toBe("deny");
  });

  test("no gateRules at all is no rules, and a non-list is no rules", () => {
    withConfig(undefined);
    expect(readGateRules()).toEqual([]);
    withConfig({ allow: ["Read"] });
    expect(readGateRules()).toEqual([]);
  });
});
