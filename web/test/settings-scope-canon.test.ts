/*
 * One way to show scope on every Agents page: a page of machine values gets the
 * header line "Settings for · This machine" and no Applies to control; every
 * other Agents page draws the Applies to control and no header line. A locked
 * row says why in a full sentence. The Flow card's "of N" names the project
 * whose own Workers at once it is. The hooks row is a status chip.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCKED_TEXT, MACHINE_NOTE, MACHINE_PAGES, rowTag } from "../src/components/settings/scope/scopeModel.ts";
import { flightOwner } from "../src/lib/flowLive.ts";

const SRC = join(import.meta.dir, "..", "src", "components");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** Every page in the Agents group, by nav id, and the file that draws its body. */
const AGENTS: Record<string, string> = {
  perm: "settings/pages/PermissionsPage.tsx",
  engines: "settings/pages/EnginesUsagePage.tsx",
  hooks: "settings/pages/WatchingPage.tsx",
  orchestration: "orchestration/OrchestrationPane.tsx",
  polaris: "settings/pages/PolarisPage.tsx",
  polarisPrs: "settings/pages/PolarisPrsPage.tsx",
  workers: "settings/pages/WorkersPage.tsx",
  fplan: "flightPlan/FlightPlanSettings.tsx",
};

describe("scope canon on the Agents pages", () => {
  test("the Agents nav lists exactly these pages", () => {
    const modal = read("SettingsModal.tsx");
    const ids = [...modal.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+", group: "Agents"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(Object.keys(AGENTS).sort());
  });
  for (const [id, file] of Object.entries(AGENTS)) {
    test(`${id}: one scope display, never both`, () => {
      const hasControl = /<ScopeControl\b/.test(read(file));
      expect(hasControl).toBe(!MACHINE_PAGES.has(id));
    });
  }
  test("the header line is drawn from MACHINE_PAGES, not a page id written in place", () => {
    const modal = read("SettingsModal.tsx");
    expect(modal).toContain("scope={MACHINE_PAGES.has(navTab.id) ?");
    expect(modal).not.toContain('scope={navTab.id === "hooks"');
  });
});

describe("a locked row says why in a full sentence", () => {
  const machine = { id: "m", general: 1, machine: true };
  test("under Only <project>: locked, with how to change it", () => {
    expect(rowTag(machine, "project", String)).toEqual({ kind: "locked", text: LOCKED_TEXT });
    expect(LOCKED_TEXT).toMatch(/^[A-Z].*\.$/);
  });
  test("under All projects: it says it is not per project", () => {
    expect(rowTag(machine, "all", String)).toEqual({ kind: "locked", text: MACHINE_NOTE });
  });
  test("no source still prints the old fragment", () => {
    for (const f of ["orchestration/DoorValueRow.tsx", "settings/pages/WorkersPage.tsx", "settings/scope/scopeModel.ts", "settings/shell/SettingRow.tsx"]) {
      expect(read(f)).not.toContain('"All projects only"');
    }
  });
  test("DoorValueRow does not say the lock twice (reason and tag)", () => {
    expect(read("orchestration/DoorValueRow.tsx")).toContain('!(tag.kind === "locked" && lockReason)');
  });
});

describe("Workers in flight reads the project's own ceiling and says so", () => {
  test("a project with its own value that differs names itself", () => {
    expect(flightOwner("/code/orbit", "project", 5, 10)).toBe("orbit");
  });
  test("same value, All projects, or no general read: plain", () => {
    expect(flightOwner("/code/orbit", "project", 10, 10)).toBeNull();
    expect(flightOwner("", "global", 5, 10)).toBeNull();
    expect(flightOwner("/code/orbit", "global", 10, 10)).toBeNull();
    expect(flightOwner("/code/orbit", "project", 5, undefined)).toBeNull();
  });
  test("the card is fed the same policy limit the worker start enforces", () => {
    const pane = read("orchestration/OrchestrationPane.tsx");
    expect(pane).toContain("useRoleCounts(flow ?? NO_FLOW, root, policy.limits)");
    expect(pane).toContain("own: flightOwner(root, p.scope, policy.limits.maxWorkers, p.general?.policy.limits.maxWorkers)");
    expect(read("orchestration/OrchestratorHero.tsx")).toContain("set for ${flight.own}");
  });
});

describe("Watching: the hooks row is a status chip", () => {
  test("a StatusBadge, like the header chip, not bare text", () => {
    const page = read("settings/pages/WatchingPage.tsx");
    expect(page).toContain('<StatusBadge tone="ok">Wired</StatusBadge>');
    expect(page).not.toContain('style={{ color: "var(--text2)" }}>On</span>');
  });
});
