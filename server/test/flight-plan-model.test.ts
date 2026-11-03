import { test, expect } from "bun:test";
import { builderPick, overrideVerdict, sensitiveHit } from "../../shared/builderModel.ts";

const role = { provider: "claude", model: "sonnet" };
const plan = (size: "S" | "M" | "L" | null, planMd: string) => ({ size, planMd });

test("the plan's size picks the strong model; an M plan with nothing sensitive keeps the builder role's", () => {
  expect(builderPick(plan("L", "# Small change\n"), role, "opus")).toEqual({
    model: "opus", why: "Opus: this is an L plan, so it launches on the model set for sensitive work.",
  });
  expect(builderPick(plan("M", "# Rename a heading\n"), role, "opus")).toEqual({
    model: "sonnet", why: "Sonnet: this plan is M and touches nothing sensitive, so it launches on the builder role's model.",
  });
});

test("a plan that touches a dependency, a secret or a migration launches on the strong model", () => {
  for (const md of ["## Risks\nAdd a dependency to the new package.", "## Risks\nIt reads the secret twice.", "## Risks\nOne migration touches the queue."]) {
    expect(sensitiveHit(md)).not.toBeNull();
    expect(builderPick(plan("M", md), role, "opus").model).toBe("opus");
  }
});

test("a Risk section that says it does not touch data or concurrency is not a hit", () => {
  for (const md of ["## Risks\nNo data changes: only copy.", "## Risks\nThis touches no data at all.", "## Risks\nNothing runs concurrently."]) {
    expect(sensitiveHit(md)).toBeNull();
    expect(builderPick(plan("M", md), role, "opus").model).toBe("sonnet");
  }
});

test("a strong model the project does not offer the launch leaves the builder role's model, and says so", () => {
  const p = builderPick(plan("L", "# Anything\n"), role, "gpt-5");
  expect(p.model).toBe("sonnet");
  expect(p.why).toBe("Sonnet: this is an L plan, so it launches on the builder role's model.");
});

test("a stronger model than the plan's pick is the person's, and a weaker one is not", () => {
  const pick = { model: "sonnet" as const, why: "Sonnet: this plan is M and touches nothing sensitive, so it launches on the builder role's model." };
  expect(overrideVerdict(pick, "opus", false)).toBe("a stronger model than the plan's choice is the person's: Opus costs more than Sonnet");
  expect(overrideVerdict(pick, "opus", true)).toBeNull();
  expect(overrideVerdict(pick, "haiku", false)).toBeNull();
  expect(overrideVerdict(pick, "gpt-5", true)).toBe("model: a launch takes haiku, sonnet, opus");
});
