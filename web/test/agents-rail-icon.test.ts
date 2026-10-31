/*
 * The Agents entry on the rail wears its own icon (an alien head), not the
 * lantern: the lantern read as "Lantern", the old name of the screen that
 * merged into Agents. Lantern's own settings page keeps the lantern. A rule
 * about source is asserted against source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const views = read("../src/components/workspace/views.ts");
const icons = read("../src/components/workspace/icons.tsx");
const settings = read("../src/components/SettingsModal.tsx");

describe("Agents rail icon", () => {
  test("the rail entry uses AgentsIcon, not the lantern", () => {
    const line = views.split("\n").find((l) => l.includes('id: "agents"')) ?? "";
    expect(line).toContain("icon: AgentsIcon");
    expect(line).not.toContain("LanternIcon");
  });
  test("AgentsIcon is in the house stroke: 24 grid, currentColor, no hardcoded colour", () => {
    const at = icons.indexOf("export function AgentsIcon(");
    expect(at).toBeGreaterThan(-1);
    const body = icons.slice(at, icons.indexOf("\n}\n", at));
    expect(body).toContain("{...svg}");
    expect(body).toContain("width={size} height={size}");
    expect(body).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
  });
  test("Lantern's settings page keeps the lantern", () => {
    expect(settings).toContain("<LanternIcon");
  });
});
