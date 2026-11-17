/*
 * Moving a step and adding your own: the places a drop may go, the refusals
 * with their reasons, the keyboard's next place, and the "Add a step" draft.
 */
import { describe, expect, test } from "bun:test";
import { validateFlow, type Flow } from "../../shared/flow.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import { movePath, placeOnPath, setRequired } from "../src/lib/flowEdit.ts";
import { addStep, checkDraft, checkPath, dropSlots, floatBox, freshDraft, gateId, keyTarget, lockedWhy, moveTo, removeStep, removeWhy, resumeDraft, slotFromMids } from "../src/lib/flowMove.ts";

// planner, builder, inspector, verifier, landing (the gate, a person answers it)
const shipped = (): Flow => ({ ...templateFlow(), blocks: [] });

describe("drop slots", () => {
  test("the gate is the last person-step", () => {
    expect(gateId(shipped())).toBe("landing");
    expect(gateId({ ...shipped(), path: ["planner", "builder"] })).toBeNull();
  });

  test("no place after the gate, every other place allowed, with the reason", () => {
    const s = dropSlots(shipped(), "planner");
    expect(s.map((x) => x.ok)).toEqual([true, true, true, true, false]);
    expect(s.at(-1)?.why).toContain("Gate is always last");
  });

  test("without a gate the end is open", () => {
    const f = { ...shipped(), path: ["planner", "builder", "inspector"] };
    expect(dropSlots(f, "planner").every((x) => x.ok)).toBe(true);
  });

  test("the gate itself has no slot", () => {
    expect(dropSlots(shipped(), "landing")).toEqual([]);
    expect(lockedWhy(shipped(), "landing")).toContain("Always last");
    expect(lockedWhy(shipped(), "qa-only")).toContain("not on the path");
  });
});

describe("moveTo", () => {
  test("moves a step to an allowed place", () => {
    const r = moveTo(shipped(), "verifier", 1);
    expect(r.ok && r.flow.path).toEqual(["planner", "verifier", "builder", "inspector", "landing"]);
  });

  test("refuses a drop after the gate and says why", () => {
    const r = moveTo(shipped(), "builder", 4);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Gate is always last") });
  });

  test("refuses to move the gate", () => {
    expect(moveTo(shipped(), "landing", 0).ok).toBe(false);
  });

  test("a place that does not exist is refused", () => {
    expect(moveTo(shipped(), "planner", 99).ok).toBe(false);
  });

  test("a required step moves", () => {
    const f = setRequired(shipped(), "builder", true);
    const r = moveTo(f, "builder", 0);
    expect(r.ok && r.flow.path[0]).toBe("builder");
    expect(r.ok && r.flow.roster.find((x) => x.id === "builder")?.required).toBe(true);
  });

  test("the result is a flow the data accepts", () => {
    const r = moveTo(shipped(), "inspector", 0);
    expect(r.ok && validateFlow(JSON.parse(JSON.stringify(r.flow))).ok).toBe(true);
  });
});

describe("floating card", () => {
  const row = { left: 20, top: 300, width: 600, height: 50 };
  const list = { top: 100, bottom: 700 };
  test("follows the pointer at the grab point, in the row's own column", () => {
    expect(floatBox(row, 400, 10, list)).toEqual({ left: 20, top: 390, width: 600, height: 50 });
  });
  test("stays inside the list", () => {
    expect(floatBox(row, 0, 10, list).top).toBe(100);
    expect(floatBox(row, 900, 10, list).top).toBe(650);
    expect(floatBox(row, 900, 10, { top: 100, bottom: 120 }).top).toBe(100);
  });
});

describe("a person step in the middle", () => {
  // The server's flow check puts no rule on where a person-step sits; only the last one is the gate.
  const f = (): Flow => {
    const base = shipped();
    const mid = { ...base.roster.find((r) => r.id === "landing")!, id: "sign-off", name: "Sign off" };
    return { ...base, roster: [...base.roster, mid], path: ["planner", "sign-off", "builder", "inspector", "verifier", "landing"] };
  };
  test("moves freely, is not the gate, and a step may be dropped past it", () => {
    expect(gateId(f())).toBe("landing");
    expect(lockedWhy(f(), "sign-off")).toBeNull();
    const r = moveTo(f(), "builder", 1);
    expect(r.ok && r.flow.path.slice(0, 3)).toEqual(["planner", "builder", "sign-off"]);
    expect(dropSlots(f(), "sign-off").map((x) => x.ok)).toEqual([true, true, true, true, true, false]);
    expect(validateFlow(JSON.parse(JSON.stringify(f()))).ok).toBe(true);
  });
});

describe("the Gate rule for Board and Canvas", () => {
  test("a path with the Gate mid-path is refused; the shipped one is fine", () => {
    expect(checkPath(shipped()).ok).toBe(true);
    const r = checkPath(movePath(shipped(), "landing", 1));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("last step");
    expect(checkPath(placeOnPath(shipped(), "qa-only", 5)).ok).toBe(false);
  });
});

describe("the Gate rule on a flow that was already broken", () => {
  const old = (): Flow => ({ ...shipped(), path: ["planner", "landing", "builder", "inspector", "verifier"] });
  test("a move that leaves the Gate no further from the end is allowed; one that worsens it is not", () => {
    expect(checkPath(movePath(old(), "verifier", 0), old()).ok).toBe(true);
    expect(checkPath(movePath(old(), "builder", 2), old()).ok).toBe(true);
    expect(checkPath(movePath(old(), "landing", 0), old()).ok).toBe(false);
    expect(checkPath(movePath(old(), "landing", 4), old()).ok).toBe(true);
  });
});

describe("the step draft is spent when the worker editor ends", () => {
  test("onClose and onSave clear stepDraft", () => {
    const src = require("node:fs").readFileSync(new URL("../src/components/orchestration/flow/FlowEditor.tsx", import.meta.url), "utf8") as string;
    expect(src).toMatch(/onClose=\{\(\) => \{.*setStepDraft\(null\)/);
    expect(src).toMatch(/onSave=\{\(next, id\) => \{[^\n]*setStepDraft\(null\)/);
  });
});

describe("review fixes", () => {
  test("a required Gate is told it is last, not that it can move", () => {
    const f = setRequired(shipped(), "landing", true);
    expect(removeWhy(f, "landing")).toContain("Always last");
    expect(removeWhy(setRequired(shipped(), "builder", true), "builder")).toContain("can move");
  });
  test("a name shaped like a key is refused on the name field", () => {
    const d = { name: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", roleId: "inspector", required: false, after: null };
    expect(checkDraft(shipped(), d).name).toContain("key");
    expect(checkDraft(shipped(), { ...d, name: "Check the change" }).ok).toBe(true);
  });
  test("the slot is read from the rows as they were at the start of the drag", () => {
    const mids = [100, 160, 220];
    expect(slotFromMids(mids, 90)).toBe(0);
    expect(slotFromMids(mids, 130)).toBe(1);
    expect(slotFromMids(mids, 500)).toBe(3);
    expect(slotFromMids([], 10)).toBe(0);
  });
});

describe("keyboard", () => {
  test("arrow steps by one allowed place and stops at the ends and before the gate", () => {
    const f = shipped();
    expect(keyTarget(f, "planner", -1)).toBeNull();
    expect(keyTarget(f, "planner", 1)).toBe(1);
    expect(keyTarget(f, "verifier", 1)).toBeNull();
    expect(keyTarget(f, "landing", -1)).toBeNull();
    expect(keyTarget(f, "qa-only", 1)).toBeNull();
  });
});

describe("delete", () => {
  test("a required step cannot be deleted; an optional one can", () => {
    const f = setRequired(shipped(), "builder", true);
    expect(removeWhy(f, "builder")).toContain("Required");
    expect(removeStep(f, "builder").ok).toBe(false);
    const r = removeStep(f, "inspector");
    expect(r.ok && r.flow.path).toEqual(["planner", "builder", "verifier", "landing"]);
  });

  test("the gate and the last step cannot be deleted", () => {
    expect(removeWhy(shipped(), "landing")).toContain("Always last");
    expect(removeWhy({ ...shipped(), path: ["planner"] }, "planner")).toContain("last step");
  });
});

describe("add a step", () => {
  const draft = { name: "Check the change", roleId: "inspector", required: true, after: "builder" as string | null };

  test("a draft says what is wrong, per field", () => {
    const f = shipped();
    expect(checkDraft(f, draft).ok).toBe(true);
    expect(checkDraft(f, { ...draft, name: "  " }).name).toContain("name");
    expect(checkDraft(f, { ...draft, name: "x".repeat(61) }).name).toContain("60 characters");
    expect(checkDraft(f, { ...draft, name: "x".repeat(60) }).ok).toBe(true);
    expect(checkDraft(f, { ...draft, name: "bad <name>" }).name).toBeDefined();
    expect(checkDraft(f, { ...draft, roleId: "nobody" }).role).toBeDefined();
    expect(checkDraft(f, { ...draft, after: "landing" }).after).toContain("Gate");
    expect(checkDraft(f, { ...draft, after: "qa-only" }).after).toContain("on the path");
  });

  test("a full team refuses with the reason", () => {
    const f = shipped();
    while (f.roster.length < 24) f.roster.push({ ...f.roster[0]!, id: `r${f.roster.length}` });
    expect(checkDraft(f, draft).full).toContain("full");
    expect(addStep(f, draft).ok).toBe(false);
  });

  test("the step lands after the one picked, brings the role's rules, and the flow stays valid", () => {
    const r = addStep(shipped(), draft);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flow.path).toEqual(["planner", "builder", "check-the-change", "inspector", "verifier", "landing"]);
    const role = r.flow.roster.find((x) => x.id === "check-the-change")!;
    expect(role.name).toBe("Check the change");
    expect(role.required).toBe(true);
    expect(role.policyRole).toBe("reviewer");
    expect(role.readsOnly).toBe(true);
    expect(validateFlow(JSON.parse(JSON.stringify(r.flow))).ok).toBe(true);
  });

  test("null puts it first; the same name twice gets its own id", () => {
    const a = addStep(shipped(), { ...draft, after: null });
    expect(a.ok && a.flow.path[0]).toBe("check-the-change");
    const b = a.ok ? addStep(a.flow, draft) : a;
    expect(b.ok && b.flow.path).toContain("check-the-change-2");
  });

  test("a draft survives a trip to make a new role", () => {
    const f = shipped();
    const typed = { name: "Check the change", roleId: "inspector", required: true, after: "builder" as string | null };
    const back = resumeDraft(f, typed, "qa-only");
    expect(back).toEqual({ ...typed, roleId: "qa-only" });
    expect(resumeDraft(f, typed, null)).toEqual(typed);
    expect(resumeDraft(f, typed, "nobody")).toEqual(typed);
    expect(resumeDraft(f, { ...typed, after: "gone" }).after).toBe(freshDraft(f).after);
    expect(resumeDraft(f, { ...typed, after: "landing" }).after).toBe("verifier");
    expect(resumeDraft(f, { ...typed, after: null }).after).toBeNull();
  });

  test("a step added off the gate's end keeps the gate last", () => {
    const f = placeOnPath(shipped(), "qa-only", 4);
    expect(f.path.at(-1)).toBe("landing");
  });
});
