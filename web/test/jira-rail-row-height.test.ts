import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/jira/JiraAreas.tsx", import.meta.url)).text();

/** The slice of one const arrow function, up to its own closing "} as const);". */
const rowFn = src.slice(src.indexOf("const row = ("), src.indexOf("} as const);", src.indexOf("const row = (")));

describe("a rail row of the Jira areas", () => {
  test("grows with its title: minHeight, never a fixed height", () => {
    expect(rowFn).toContain("minHeight: HIT");
    expect(rowFn).not.toMatch(/(^|[\s,{])height:\s*HIT/);
  });
  test("the title may wrap to two lines", () => {
    expect(src).toContain("WebkitLineClamp: 2");
  });
});
