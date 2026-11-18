/*
 * Settings ▸ Browser ▸ "Flow roles": one row per role id, grouped under its
 * project, the current path first. The card's own rendering is
 * browser-who-may-drive-card.test.ts; this is the pure function it calls.
 */
import { describe, expect, test } from "bun:test";
import { groupFlowRoleRows, type FlowRoleCardRow } from "../../shared/browserWorkers.ts";

describe("groupFlowRoleRows", () => {
  test("one row per role id, label is the role's own name, project said once", () => {
    const rows: FlowRoleCardRow[] = [
      { root: "/p/orbit", project: "orbit", id: "builder", title: "Builder", base: "builder", onPath: true },
      // The project's own copy of the template's "builder" row: same id, same
      // root, a different title. Only the first survives as a row.
      { root: "/p/orbit", project: "orbit", id: "builder", title: "Builder · Orbit", base: "builder", onPath: true },
      { root: "/p/orbit", project: "orbit", id: "scout-extra", title: "Scout extra", base: "builder", onPath: false },
    ];
    const sections = groupFlowRoleRows(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.project).toBe("orbit");
    expect(sections[0]!.onPath).toHaveLength(1);
    expect(sections[0]!.onPath[0]!.id).toBe("builder");
    expect(sections[0]!.onPath[0]!.title).toBe("Builder");
    expect(sections[0]!.offPath).toHaveLength(1);
    expect(sections[0]!.offPath[0]!.title).toBe("Scout extra");
  });

  test("two projects, two headings, each keeping its own row for a shared role id", () => {
    const rows: FlowRoleCardRow[] = [
      { root: "/p/orbit", project: "orbit", id: "ops", title: "Ops", base: "builder", onPath: true },
      { root: "/p/acme", project: "acme", id: "ops", title: "Ops", base: "builder", onPath: false },
    ];
    const sections = groupFlowRoleRows(rows);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.project).toBe("orbit");
    expect(sections[0]!.onPath.map((r) => r.id)).toEqual(["ops"]);
    expect(sections[1]!.project).toBe("acme");
    expect(sections[1]!.offPath.map((r) => r.id)).toEqual(["ops"]);
  });

  test("fails on the old label (role name with the project appended twice)", () => {
    const rows: FlowRoleCardRow[] = [
      { root: "/p/orbit", project: "orbit", id: "builder", title: "Builder · Orbit", base: "builder", onPath: true },
    ];
    const label = groupFlowRoleRows(rows)[0]!.onPath[0]!.title;
    expect(label).not.toBe("Builder · Orbit · orbit");
    expect(label).toBe("Builder · Orbit");
  });
});
