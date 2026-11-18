/* Jira card detail: labels are sentence case (no uppercase eyebrows) and the sub-task crumb truncates its title. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/components/jira/${p}`, import.meta.url), "utf8");

test("family block labels are not uppercased", () => {
  const css = src("detail/FamilyBlock.tsx");
  for (const cls of [".agx-fam-fold", ".agx-fam-way"]) {
    const rule = css.split("\n").find((l) => l.startsWith(cls + "{")) ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toContain("text-transform");
  }
  expect(css).toContain('"Blocked by"');
  expect(css).toContain("<span>Family</span>");
});

test("step dialog field keys are not uppercased", () => {
  const line = src("JiraStepDialog.tsx").split("\n").find((l) => l.startsWith("export const FIELD_KEY")) ?? "";
  expect(line).not.toContain("uppercase");
});

test("sub-task crumb truncates the title and keeps type and key fixed", () => {
  const s = src("detail/DetailHeader.tsx");
  const crumb = s.slice(s.indexOf("function ParentCrumb"), s.indexOf("export function DetailHeader"));
  expect(crumb).toContain("max-w-full");
  expect(crumb).toContain('className="min-w-0 truncate"');
  expect(crumb).toContain('className="tabular-nums shrink-0"');
  expect(crumb).toContain('className="shrink-0 inline-flex"><TypeMark');
  expect(crumb).toContain("data-tip=");
  expect(crumb).not.toContain("title=");
});
