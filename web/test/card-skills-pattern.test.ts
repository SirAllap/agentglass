/*
 * Which skills take a card, when the workspace names its own. The default is
 * the shipped pattern and must give the shipped answers (card-skills.test.ts);
 * this file pins what a saved pattern changes and what it leaves alone.
 */
import { describe, expect, it } from "bun:test";
import { cardSkills, namedForIt, DEFAULT_CARD_SKILL_PATTERN } from "../../shared/cardSkills.ts";
import type { SkillInfo } from "../../shared/types.ts";

const mk = (name: string, description = ""): SkillInfo => ({
  name, description, kind: "skill", argument_hint: null, source: "user",
  copies: 1, path: `/skills/${name}`, added: 0, runs: 0,
} as unknown as SkillInfo);

const all = [mk("acme-card-fix"), mk("clickup-card-fix"), mk("deploy", "Ship it. Takes an acme-card id."), mk("write-tests")];

describe("a custom card-skill pattern", () => {
  it("the shipped pattern, given or not, is the shipped answer", () => {
    const base = cardSkills(all).map((s) => s.name);
    expect(base).toEqual(["clickup-card-fix"]);
    expect(cardSkills(all, "").map((s) => s.name)).toEqual(base);
    expect(cardSkills(all, DEFAULT_CARD_SKILL_PATTERN).map((s) => s.name)).toEqual(base);
    expect(cardSkills(all, "  ").map((s) => s.name)).toEqual(base);
  });

  it("finds a skill by the habit the workspace names, in its name or its description", () => {
    expect(cardSkills(all, "acme-card").map((s) => s.name)).toEqual(["acme-card-fix", "deploy"]);
  });

  it("is case-insensitive like the shipped one", () => {
    expect(cardSkills(all, "ACME-CARD").length).toBe(2);
  });

  it("named-for-it follows the pattern: the name matching it, not merely the description", () => {
    const [a, , d] = [all[0]!, all[1]!, all[2]!];
    expect(namedForIt(a, "acme-card")).toBe(true);
    expect(namedForIt(d, "acme-card")).toBe(false);
    expect(cardSkills(all, "acme-card").map((s) => s.name)).toEqual(["acme-card-fix", "deploy"]);
  });

  it("the shipped named-for-it still needs the hyphen", () => {
    expect(namedForIt(mk("clickup-card-fix"))).toBe(true);
    expect(namedForIt(mk("clickupper"))).toBe(false);
  });

  it("a pattern that does not compile is the shipped one, not an empty menu", () => {
    expect(cardSkills(all, "([").map((s) => s.name)).toEqual(["clickup-card-fix"]);
  });
});
