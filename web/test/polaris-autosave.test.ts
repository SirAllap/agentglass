/*
 * Instant save, driven by a fake `save`: a failed or half-failed save puts the rows back on what is
 * stored and never blocks the next edit, a change made while a save is in flight is kept, and Esc on
 * the question is the same as Cancel.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePolaris, type SettingsAnswer, type SettingsChange, type StoredPolaris } from "../../shared/polaris.ts";
import { draftState, patchDoor, savePlan, toggleEnabled } from "../src/lib/polarisDraft.ts";
import { runSave, settle, type SaveFn } from "../src/lib/polarisAutosave.ts";

const answerOf = (project: StoredPolaris | null): SettingsAnswer => {
  const r = resolvePolaris(null, project);
  return { ok: true, ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer };
};
const view = readFileSync(join(import.meta.dir, "..", "src/components/polaris/PolarisView.tsx"), "utf8");
const start = answerOf({ version: 1 } as StoredPolaris);
const stored = answerOf({ version: 1, doors: { dock: { mode: "on" } } } as StoredPolaris);
const flipped = patchDoor(draftState(start), "project", "dock", { mode: "on" });

describe("a failed save", () => {
  test("reverts the rows to the stored value, says so, and the next edit saves", async () => {
    const offline: SaveFn = async () => ({ error: "Could not reach the server.", answer: null });
    const run = await runSave(flipped, start, "project", [], offline);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.error).toContain("back to what is stored");
    const back = settle(run, flipped, flipped, "project")!;
    expect(savePlan(back, "project").dirty).toBe(false);
    // the next edit is a normal save: nothing is stuck
    const next = patchDoor(back, "project", "dock", { mode: "on" });
    const calls: SettingsChange[] = [];
    const ok: SaveFn = async (c) => { calls.push(c); return { error: null, answer: stored }; };
    expect((await runSave(next, start, "project", [], ok)).kind).toBe("saved");
    expect(calls.length).toBe(1);
  });
  test("a partial failure (settings saved, enabled refused) rebases to what was stored", async () => {
    const s = toggleEnabled(flipped);
    let n = 0;
    const half: SaveFn = async () => (++n === 1 ? { error: null, answer: stored } : { error: "refused", answer: null });
    const run = await runSave(s, start, "project", [], half);
    expect(run.kind).toBe("failed");
    if (run.kind !== "failed") return;
    expect(run.answer).toBe(stored);
    const back = settle(run, s, s, "project")!;
    expect(back.base).toBe(stored);
    expect(back.draft.enabled).toBe(stored.enabled);
    expect(savePlan(back, "project").dirty).toBe(false);
  });
  test("the view never gates autosave on the note", () => {
    expect(view).toContain("if (busy || confirm) return;");
  });
});

describe("an edit made while a save is in flight", () => {
  test("is kept on the new answer and still dirty, so it is saved next", async () => {
    const ok: SaveFn = async () => ({ error: null, answer: stored });
    const run = await runSave(flipped, start, "project", [], ok);
    const second = patchDoor(flipped, "project", "cards", { mode: "on" });
    const next = settle(run, flipped, second, "project")!;
    expect(next.base).toBe(stored);
    const plan = savePlan(next, "project");
    expect(plan.dirty).toBe(true);
    expect(Object.keys(plan.edits)).toEqual(["cards"]);
  });
  test("with no second edit the draft simply follows the stored answer", async () => {
    const run = await runSave(flipped, start, "project", [], async () => ({ error: null, answer: stored }));
    expect(savePlan(settle(run, flipped, flipped, "project")!, "project").dirty).toBe(false);
  });
});

describe("a loosening edit", () => {
  test("asks and writes nothing until it is allowed", async () => {
    const live = patchDoor(draftState(start), "project", "relaunch", { mode: "live" });
    let wrote = 0;
    const run = await runSave(live, start, "project", [], async () => { wrote++; return { error: null, answer: stored }; });
    expect(run.kind).toBe("ask");
    expect(wrote).toBe(0);
  });
  test("Esc runs the same revert as Cancel", () => {
    expect(view).toContain('if (e.key === "Escape" && confirm) { cancelAsk.current(); return; }');
    expect(view).toContain("onClick={cancelAsk.current}>Cancel");
    expect(view).toContain("cancelAsk.current = () => { setConfirm(null); setState(draftState(answer)); };");
  });
});
