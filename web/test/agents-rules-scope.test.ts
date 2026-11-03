// A single project's Agents view drew the other projects' rules cards too, with their
// learned rules and Allow/Ask/Never buttons. One project shows its own card; All shows each.
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/agents/AgentRulesSection.tsx", import.meta.url)).text();

describe("Agents rules scope", () => {
  test("a single project draws only its own card", () => {
    expect(src).toContain("(all ? [...projects] : [root])");
    expect(src).not.toContain("projects.filter((p) => p !== root)");
    expect(src).not.toContain("another project");
  });
  test("All projects draws every project", () => {
    expect(src).toContain("[...projects]");
  });
});
