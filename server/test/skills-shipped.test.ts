import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const dirs = readdirSync(new URL("skills/", root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const install = readFileSync(new URL("electron/install-local.sh", root), "utf8");
// A skill the installer does not copy is a file no agent will ever read.
const installed = install.match(/for _s in ([^;]+); do/)?.[1].trim().split(/\s+/) ?? [];

describe("the skills the app ships", () => {
  test("there are some to hold to the installer", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(4);
  });
  test("install-local.sh copies every one, and only those", () => {
    expect([...installed].sort()).toEqual([...dirs].sort());
  });
  test("each opens with a name equal to its folder and a description", () => {
    for (const d of dirs) {
      const head = readFileSync(new URL(`skills/${d}/SKILL.md`, root), "utf8").split("\n---")[0];
      expect(head, d).toMatch(new RegExp(`^---\\nname: ${d}\\n`));
      expect(head, d).toMatch(/\ndescription: \S/);
    }
  });
  test("the orchestrator skill sends M/L work to flight-plan", () => {
    expect(readFileSync(new URL("skills/orchestrator/SKILL.md", root), "utf8")).toContain("`flight-plan` skill");
  });
});
