import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

test("a worker's start is rooted in the calling project, not the one the person has open", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const i = src.indexOf("await AgentOps.startAgent({\n          root: ");
  expect(i).toBeGreaterThan(0);
  expect(src.slice(i, i + 140)).toContain("root: policyRoot,");
  expect(src.slice(i, i + 140)).not.toContain("workspaceRoot()");
});

