/*
 * The consent net, driven the way a person drives it: seeded random clicks and Saves over the
 * view's own state machine, with the two sequences the round-5 review reduced by hand named
 * below. No component, no second model of the view.
 *
 * (A) after any Save no door is live unless it was live in the layer the save was measured on,
 *     or that same plan named it for consent;
 * (B) every row shows the position the save then wrote;
 * (R) a position pressed on a row is the position that row shows.
 */
import { describe, expect, test } from "bun:test";
import {
  DOOR_IDS, DOOR_MODES, PRESETS, isLive, resolvePolaris,
  type DoorId, type PresetId, type SettingsAnswer, type StoredPolaris,
} from "../../shared/polaris.ts";
import {
  draftState, patchDoor, pickPreset, rebaseDraft, safestPosition, saveCommit, savePlan, toggleEnabled, useGlobalDoors,
  type DraftState, type SavePlan,
} from "../src/lib/polarisDraft.ts";
import { GROUPS, type GroupId } from "../src/lib/polarisCopy.ts";

const answerOf = (global: StoredPolaris | null, project: StoredPolaris | null = null): SettingsAnswer => {
  const r = resolvePolaris(global, project);
  return { ok: true, ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer, below: global ?? undefined };
};

const GLOBAL_LAYERS: Record<string, StoredPolaris | null> = {
  none: null,
  guided: { version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) },
  full: { version: 1, preset: "fullAutopilot", doors: structuredClone(PRESETS.fullAutopilot.doors) },
  watch: { version: 1, preset: "watchOnly", doors: structuredClone(PRESETS.watchOnly.doors) },
  customLive: { version: 1, preset: "custom", doors: { relaunch: { mode: "live", cap: 3 }, startSession: { mode: "click", tries: 2 }, diagnose: { mode: "auto" }, cards: { mode: "on", size: 3 } } },
};
const PROJECT_LAYERS: Record<string, StoredPolaris | null> = {
  none: null,
  guided: { version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) },
  full: { version: 1, preset: "fullAutopilot", doors: structuredClone(PRESETS.fullAutopilot.doors) },
  partial: { version: 1, preset: "custom", doors: { relaunch: { mode: "dry", cap: 2 }, follow: { mode: "on" }, dock: { mode: "on", label: "docked", excluded: [7] } } },
};
const GLOBAL_KEYS = Object.keys(GLOBAL_LAYERS);
const PROJECT_KEYS = Object.keys(PROJECT_LAYERS);
const PRESET_IDS = Object.keys(PRESETS) as PresetId[];
const GROUPS_LIST = GROUPS.map((g) => g.id as GroupId);
const AUTO = GROUPS.find((g) => g.id === "Automatic")!.doors;

interface Fail { kind: string; why: string }
export interface Walk { failures: Fail[]; runs: number }

const seedOf = (n: number) => {
  let seed = n;
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
};

/** The render plan: what the rows draw, from the state the view carries. */
const rowsOf = (s: DraftState) => savePlan(s, "project");

/** One walk of 14 clicks, each of which may Save. `saveOf` is the one seam the mutation tests rewrite. */
function walk(globalKey: string, projectKey: string, trial: number, rnd: () => number, saveOf: (s: DraftState, a: SettingsAnswer) => { plan: SavePlan; layer: StoredPolaris }): Fail[] {
  const fails: Fail[] = [];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let g = globalKey;
  let answer = answerOf(GLOBAL_LAYERS[g]!, PROJECT_LAYERS[projectKey] ?? null);
  let s = draftState(answer);
  const trace = [`${g}/${projectKey} #${trial}`];
  const rows = () => DOOR_IDS.map((d) => `${d}:${rowsOf(s).effective.doors[d].mode}`).join(" ");

  for (let step = 0; step < 14; step++) {
    const op = pick(["preset", "useGlobal", "safest", "mode", "param", "toggle", "refresh"]);
    const group = pick(GROUPS_LIST);
    const doors = GROUPS.find((x) => x.id === group)!.doors as readonly DoorId[];
    if (op === "preset") {
      const id = pick(PRESET_IDS);
      s = pickPreset(s, "project", id);
      trace.push(`press preset ${id}`);
    } else if (op === "useGlobal") {
      s = useGlobalDoors(s, "project", doors);
      trace.push(`Use global on ${doors[0]}`);
    } else if (op === "safest") {
      s = safestPosition(s, "project", doors);
      trace.push(`safest on ${doors[0]}`);
    } else if (op === "toggle") {
      s = toggleEnabled(s);
      trace.push("press the power switch");
    } else if (op === "refresh") {
      // Another window moves the global layer while this draft is open: the view keeps the
      // draft and re-measures it on the answer the save will write into.
      g = pick(GLOBAL_KEYS);
      answer = answerOf(GLOBAL_LAYERS[g]!, PROJECT_LAYERS[projectKey] ?? null);
      s = rebaseDraft(s, answer, "project");
      trace.push(`refresh under the draft: global is now ${g}`);
    } else {
      const door = pick(DOOR_IDS);
      if (op === "mode") {
        const m = pick(DOOR_MODES[door] as readonly string[]);
        const before = rowsOf(s).effective.doors[door].mode;
        s = patchDoor(s, "project", door, { mode: m });
        const shown = rowsOf(s).effective.doors[door].mode;
        trace.push(`press ${door} ${m} (row showed ${before})`);
        if (shown !== m) fails.push({ kind: "R-click-swallowed", why: `${door}: pressed ${m}, row shows ${shown} (was ${before}): ${trace.join(" | ")}` });
      } else {
        const k = pick(["cap", "tries", "size", "steps", "minutes", "label"]) as string;
        if (!(k in s.draft.doors[door])) continue;
        const v = k === "label" ? "queued" : k === "minutes" ? 12 : 1;
        const before = rowsOf(s).effective.doors[door][k];
        s = patchDoor(s, "project", door, { [k]: v });
        trace.push(`press ${door}.${k} -> ${v} (row showed ${String(before)})`);
        const shown = rowsOf(s).effective.doors[door][k];
        if (String(shown) !== String(v) && String(before) !== String(v)) fails.push({ kind: "R-param-swallowed", why: `${door}.${k}: set ${v}, row shows ${String(shown)}: ${trace.join(" | ")}` });
      }
    }
    if (fails.length) return fails;
    if (rnd() < 0.25) {
      const plan = rowsOf(s);
      const { plan: written, layer } = saveOf(s, answer);
      const after = resolvePolaris(GLOBAL_LAYERS[g]!, layer);
      for (const d of DOOR_IDS.filter((x) => isLive(x, after.settings.doors[x].mode))) {
        const named = isLive(d, answer.doors[d].mode) || written.consent.includes(d);
        if (!named) fails.push({ kind: "A-unconfirmed-live", why: `${d} live after the save, not live before (${answer.doors[d].mode}), not named by [${written.consent.join(",")}]: ${trace.join(" | ")}` });
      }
      for (const d of DOOR_IDS) {
        if (after.settings.doors[d].mode !== plan.effective.doors[d].mode) {
          fails.push({ kind: "B-rows-not-what-was-saved", why: `${d}: rows ${plan.effective.doors[d].mode}, saved ${after.settings.doors[d].mode}: ${trace.join(" | ")}` });
        }
      }
      trace.push(`SAVE consent=[${written.consent.join(",")}] rows=${rows()}`);
      answer = answerOf(GLOBAL_LAYERS[g]!, layer);
      s = draftState(answer);
    }
  }
  return fails;
}

/** Every combination of the global and project layers, 40 walks of 14 clicks each: 800 runs. */
function oracle(saveOf: (s: DraftState, a: SettingsAnswer) => { plan: SavePlan; layer: StoredPolaris } = (s, a) => saveCommit(s, a, "project")): Walk {
  const failures: Fail[] = [];
  let runs = 0;
  for (const g of GLOBAL_KEYS) {
    for (const p of PROJECT_KEYS) {
      for (let t = 0; t < 40; t++) {
        runs++;
        const rnd = seedOf((GLOBAL_KEYS.indexOf(g) + 1) * 1000 + PROJECT_KEYS.indexOf(p) * 40 + t);
        failures.push(...walk(g, p, t, rnd, saveOf));
      }
    }
  }
  return { failures, runs };
}

describe("the consent net keeps over 800 random sequences", () => {
  const { failures, runs } = oracle();

  test("800 runs is the full grid: 5 global layers x 4 project layers x 40 walks", () => {
    expect(runs).toBe(800);
  });
  test("no door is live after a Save unless that save named it or it was already live", () => {
    expect(failures.filter((f) => f.kind === "A-unconfirmed-live").map((f) => f.why)).toEqual([]);
  });
  test("every row shows the position the save wrote", () => {
    expect(failures.filter((f) => f.kind === "B-rows-not-what-was-saved").map((f) => f.why)).toEqual([]);
  });
  test("a position pressed is the position its row shows", () => {
    expect(failures.filter((f) => f.kind.startsWith("R-")).map((f) => f.why)).toEqual([]);
  });
});

describe("the net is not vacuous: each invariant fires when its guard is removed", () => {
  test("with the consent list emptied, unconfirmed live doors are found", () => {
    const { failures } = oracle((s, a) => { const c = saveCommit(s, a, "project"); return { plan: { ...c.plan, consent: [] }, layer: c.layer }; });
    expect(failures.filter((f) => f.kind === "A-unconfirmed-live").length).toBeGreaterThan(0);
  });
  test("with the rows drawn from the layer the draft was built on, they disagree with the save", () => {
    // The un-rebased stale draft: rows come from the old base, the save writes into the fresh one.
    const project: StoredPolaris = { version: 1, preset: "custom", doors: { relaunch: { mode: "dry", cap: 3 } } };
    const guided = { version: 1, preset: "guided" as const, doors: structuredClone(PRESETS.guided.doors) };
    const full = { version: 1, preset: "fullAutopilot" as const, doors: structuredClone(PRESETS.fullAutopilot.doors) };
    const stale = useGlobalDoors(draftState(answerOf(guided, project)), "project", AUTO);
    const rows = savePlan(stale, "project").effective.doors;
    const saved = resolvePolaris(full, saveCommit(stale, answerOf(full, project), "project").layer).settings.doors;
    expect(DOOR_IDS.filter((d) => rows[d].mode !== saved[d].mode).map((d) => [d, rows[d].mode, saved[d].mode]))
      .toContainEqual(["relaunch", "dry", "live"]);
  });
});

describe("the two sequences the review reduced by hand", () => {
  const project: StoredPolaris = { version: 1, preset: "custom", doors: { relaunch: { mode: "dry", cap: 3 } } };
  const full = { version: 1, preset: "fullAutopilot" as const, doors: structuredClone(PRESETS.fullAutopilot.doors) };
  const guided = { version: 1, preset: "guided" as const, doors: structuredClone(PRESETS.guided.doors) };

  test("Use global, then the block's safest position, then Off: Off is what is saved, not the live position", () => {
    let s = draftState(answerOf(full, project));
    s = useGlobalDoors(s, "project", AUTO);
    s = safestPosition(s, "project", AUTO);
    const afterSafest = savePlan(s, "project").effective.doors.relaunch.mode;
    s = patchDoor(s, "project", "relaunch", { mode: "off" });
    const { plan, layer } = saveCommit(s, answerOf(full, project), "project");
    const after = resolvePolaris(full, layer).settings.doors;
    expect([afterSafest, plan.effective.doors.relaunch.mode, after.relaunch.mode]).toEqual(["off", "off", "off"]);
    expect(DOOR_IDS.filter((d) => plan.effective.doors[d].mode !== after[d].mode)).toEqual([]);
    expect(plan.consent).toEqual([]);
  });

  test("Use global pressed after a preset is the later word: the reset is not drowned by the preset", () => {
    let s = pickPreset(draftState(answerOf(full, null)), "project", "watchOnly");
    s = useGlobalDoors(s, "project", AUTO);
    const plan = savePlan(s, "project");
    const after = resolvePolaris(full, plan.effective.pending).settings.doors;
    expect(plan.chosen).toBeNull();
    expect([plan.effective.doors.relaunch.mode, after.relaunch.mode]).toEqual(["live", "live"]);
  });

  test("Save is measured on the answer it writes into, not the one the draft was built from", () => {
    // The window before the view re-measures: the draft still carries the old base, the answer has moved.
    const stale = useGlobalDoors(draftState(answerOf(guided, project)), "project", AUTO);
    const fresh = answerOf(full, project);
    const { plan, layer } = saveCommit(stale, fresh, "project");
    expect(plan.consent).toContain("relaunch");
    expect(resolvePolaris(full, layer).settings.doors.relaunch.mode).toBe("live");
    // Reading the draft's own base would have asked nothing for the same write.
    expect(savePlan(stale, "project").consent).toEqual([]);
  });

  test("a draft kept across a refresh is measured on the fresh answer, and Save asks before the door acts", () => {
    const before = answerOf(guided, project);
    let s = useGlobalDoors(draftState(before), "project", AUTO);
    // The global layer moves from Guided to Full autopilot while the draft is open.
    const fresh = answerOf(full, project);
    s = rebaseDraft(s, fresh, "project");
    const { plan, layer } = saveCommit(s, fresh, "project");
    const after = resolvePolaris(full, layer).settings.doors;
    expect(plan.effective.doors.relaunch.mode).toBe("live");
    expect(plan.consent).toContain("relaunch");
    // The question and the write come from this one plan: what the confirmation named is what
    // the save wrote, and every row equals the layer.
    expect(DOOR_IDS.filter((d) => plan.effective.doors[d].mode !== after[d].mode)).toEqual([]);
    expect(savePlan(s, "project").consent).toEqual(plan.consent);
  });
});
