/*
 * What the Polaris view must keep editable, and how it behaves while a person
 * edits: every stored setting has an editor, every mode is reachable, the hours
 * stepper only lands on values the server accepts, the rail says what each
 * number counts, and a reload keeps a draft that was not saved.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOOR_IDS, DOOR_MODES, DOOR_PARAMS, PRESETS, isLive, resolvePolaris, type DoorId, type DoorValue, type PolarisPresetName, type PresetId, type SettingsAnswer, type StoredPolaris } from "../../shared/polaris.ts";
import { draftedDoors, draftState, patchDoor, pickPreset, saveCommit, savePlan, useGlobalDoors } from "../src/lib/polarisDraft.ts";
import { DOOR_COPY, GROUPS } from "../src/lib/polarisCopy.ts";
import {
  LIMITS, doorActive, doorEdits, editorFor, layerToSave, limitStep, liveQuestion, markOf, onNewSettings, ownedDoors, ownCount,
  patchChanges, railWords, showsParams, twoWay, withoutDoor, type Scope,
} from "../src/lib/polarisView.ts";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const view = src("components/polaris/PolarisView.tsx");
const draftSrc = src("lib/polarisDraft.ts");
const params = src("components/polaris/DoorParams.tsx");
const css = src("components/polaris/polarisView.css");

const answerOf = (global: StoredPolaris | null, project: StoredPolaris | null = null): SettingsAnswer => {
  const r = resolvePolaris(global, project);
  return { ok: true, ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer, below: global ?? undefined };
};

describe("every setting the old card edited has an editor here", () => {
  const carried = (door: DoorId, key: string) => editorFor(door, key) !== null || LIMITS.some((l) => l.door === door && l.param === key);
  test("every stored key is editable: an inline editor, or the limit stepper", () => {
    const missing = DOOR_IDS.flatMap((door) => Object.keys(DOOR_PARAMS[door]).filter((key) => !carried(door, key)).map((key) => `${door}.${key}`));
    expect(missing).toEqual([]);
  });
  test("the hours a course waits live in the Limits stepper, not under a door row", () => {
    // course is off/hours: a switch with no parameters under it, so an inline hours editor was never drawn.
    expect(editorFor("course", "hours")).toBeNull();
    expect(LIMITS.some((l) => l.door === "course" && l.param === "hours")).toBe(true);
  });
  test("a key added to a door without an editor fails this", () => {
    expect(editorFor("lookAgain", "aKeyNobodyDrew")).toBeNull();
  });
  test("the view mounts the parameters of a door that uses them", () => {
    expect(view).toContain("showsParams(door, doors[door].mode)");
    expect(view).toContain("<DoorParams door={door}");
    expect(showsParams("labels", "on")).toBe(true);
    expect(showsParams("lookAgain", "on")).toBe(true);
    expect(showsParams("dock", "off")).toBe(true);
    expect(showsParams("labels", "off")).toBe(false);
  });
  test("the three editors the card had are drawn: text, list, rules, minutes and count", () => {
    for (const kind of ["text", "list", "rules", "minutes", "count"]) expect(params).toContain(`case "${kind}"`);
    expect(params).toContain("Label that docks a pull request");
    expect(params).toContain("Excluded pull requests");
    expect(params).toContain("Label rules");
    expect(params).toContain("Minutes between passes");
  });
});

describe("every position of every door is reachable from its row", () => {
  test("a door with more than two positions says each one in words", () => {
    const multi = DOOR_IDS.filter((d) => DOOR_MODES[d].length > 2);
    expect(multi).toEqual(["cleared", "diagnose", "relaunch"]);
    expect(DOOR_COPY.cleared.modes.bell).toBe("Badge and bell");
    expect(DOOR_COPY.diagnose.modes.auto).toBe("Automatically");
    expect(DOOR_COPY.relaunch.modes.live).toBe("Live");
    expect(view).toContain("DOOR_MODES[door].map((m) => ({ id: m, label: copy.modes[m] ?? m }))");
  });
  test("a two-position door that does not start at off shows its words, not an on/off switch", () => {
    // approvals is people/any: a switch named "Count only people's approvals" would read as off while it counts people.
    expect(DOOR_MODES.approvals[0]).toBe("people");
    expect(twoWay("approvals")).toBe(false);
    expect(twoWay("follow")).toBe(true);
    expect(DOOR_COPY.approvals.modes.any).toBe("Bots count");
    expect(doorActive("approvals", { mode: "people" })).toBe(true);
    expect(doorActive("follow", { mode: "off" })).toBe(false);
    expect(doorActive("follow", { mode: "on" })).toBe(true);
  });
  test("a three-position door is drawn with words, so its live position stays reachable", () => {
    expect(DOOR_MODES.relaunch).toEqual(["off", "dry", "live"]);
    expect(twoWay("relaunch")).toBe(false);
    expect(view).toContain("{twoWay(door) ? (");
  });
  test("the live position asks before it acts and is marked on its row", () => {
    expect(markOf("relaunch", { mode: "live", cap: 3 })).toBe("Live");
    expect(markOf("relaunch", { mode: "dry", cap: 3 })).toBe("Dry run");
    expect(liveQuestion("relaunch", { mode: "dry", cap: 3 }, { mode: "live", cap: 3 })).not.toBeNull();
  });
});

describe("the hours stepper only lands on values the server accepts", () => {
  test("up from 4: 12, 24, 48, and never 25", () => {
    const seen: number[] = [];
    let v = 4;
    for (let i = 0; i < 4; i++) { seen.push(v); v = limitStep("hours", v, 1); }
    expect(seen).toEqual([4, 12, 24, 48]);
    expect(seen.every((h) => DOOR_PARAMS.course.hours.ok(h))).toBe(true);
    expect(limitStep("hours", 24, 1)).toBe(48);
  });
  test("down from 48: 24, 12, 4 and it stops there", () => {
    const seen: number[] = [];
    let v = 48;
    for (let i = 0; i < 4; i++) { seen.push(v); v = limitStep("hours", v, -1); }
    expect(seen).toEqual([48, 24, 12, 4]);
    expect(v).toBe(4);
  });
  test("a number stops at the end of its own range", () => {
    expect(limitStep("size", 5, 1)).toBe(5);
    expect(limitStep("cap", 1, -1)).toBe(1);
    expect(limitStep("tries", 2, 1)).toBe(3);
  });
});

describe("the pinned rail says what each number counts", () => {
  test("every limit has its own words, and start tries is not a course", () => {
    expect(LIMITS.map((l) => railWords(l, 3))).toEqual([
      "3 cards at once", "3 attempts a run", "3 start tries", "3 h before a course",
    ]);
    expect(railWords(LIMITS[2]!, 3)).not.toContain("course");
    expect(view).toContain("{railWords(l, Number(doors[l.door][l.param]))}");
  });
});

describe("a reload never eats a draft", () => {
  const answer = { doors: {} } as unknown as SettingsAnswer;
  test("a dirty draft is kept and the person is told why", () => {
    expect(onNewSettings({ hasBase: true, dirty: true }, answer)).toBe("keep");
    expect(view).toContain("STALE");
  });
  test("a clean draft follows the stored setting", () => {
    expect(onNewSettings({ hasBase: true, dirty: false }, answer)).toBe("rebase");
  });
  test("no answer clears the page", () => {
    expect(onNewSettings({ hasBase: true, dirty: true }, null)).toBe("clear");
  });
});

describe("the drawing carries no offset of its own", () => {
  test("no header or scope-bar height is subtracted here, so nothing can drift when they change", () => {
    const block = css.slice(css.indexOf(".agx-pol-pinned"), css.indexOf("}", css.indexOf(".agx-pol-pinned")));
    expect(block).not.toContain("--agx-ph-h");
    expect(block).not.toContain("--orch-stick");
    expect(block).not.toMatch(/\btop:/);
  });
});

describe("the layer one Save writes: resets, then preset, then door edits", () => {
  const AUTO = GROUPS.find((g) => g.id === "Automatic")!.doors;
  const dockOff: DoorValue = { mode: "off", label: "docked", excluded: [] };
  const globalFull: StoredPolaris = { version: 1, preset: "fullAutopilot", doors: structuredClone(PRESETS.fullAutopilot.doors) };
  const globalGuided: StoredPolaris = { version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) };
  const projectRelaunchLive: StoredPolaris = { version: 1, doors: { relaunch: { mode: "live", cap: 3 } } };

  interface Row {
    name: string;
    global: StoredPolaris;
    project?: StoredPolaris | null;
    scope?: Scope;
    resets?: DoorId[];
    preset?: PresetId | null;
    edits?: Partial<Record<DoorId, DoorValue>>;
    /** The preset name the layer stores. */
    name_: PolarisPresetName | undefined;
    count: number;
    has?: Partial<Record<DoorId, DoorValue>>;
    lacks?: DoorId[];
    /** The mode that is in force after the save, door by door. */
    mode?: Partial<Record<DoorId, string>>;
  }

  const rows: Row[] = [
    // Use global on Automatic, then a preset: the preset supersedes the reset on every door it sets.
    { name: "Use global then Guided", global: globalFull, project: projectRelaunchLive, resets: ["relaunch"], preset: "guided", name_: "guided", count: 17, has: { relaunch: { mode: "dry", cap: 3 } }, mode: { relaunch: "dry" } },
    { name: "Use global then Watch only", global: globalFull, project: projectRelaunchLive, resets: ["relaunch"], preset: "watchOnly", name_: "watchOnly", count: 17, has: { relaunch: { mode: "off", cap: 3 } }, mode: { relaunch: "off" } },
    { name: "Use global then Full autopilot", global: globalGuided, project: projectRelaunchLive, resets: ["relaunch"], preset: "fullAutopilot", name_: "fullAutopilot", count: 17, has: { relaunch: { mode: "live", cap: 3 } }, mode: { relaunch: "live" } },
    // Use global with no preset: the door is dropped and the global position is in force, on purpose.
    { name: "Use global, no preset", global: globalFull, project: projectRelaunchLive, resets: ["relaunch"], name_: "custom", count: 0, lacks: ["relaunch"], mode: { relaunch: "live" } },
    // An edit after Use global is kept, not deleted with the reset.
    { name: "Use global then edit the same door", global: globalFull, project: { version: 1, doors: { follow: { mode: "off" } } }, resets: ["follow"], edits: { follow: { mode: "on" } }, name_: "custom", count: 1, has: { follow: { mode: "on" } }, mode: { follow: "on" } },
    // A reset with nothing after it still drops the door (the round-2 fix, kept).
    { name: "Use global with no edit", global: globalGuided, project: { version: 1, doors: { lookAgain: { mode: "on", minutes: 30, steps: 2 } } }, resets: ["lookAgain"], name_: "custom", count: 0, lacks: ["lookAgain"], mode: { lookAgain: "on" } },
    // A door-only save writes that door and nothing else, and never the name it inherits.
    { name: "one door moved in a project", global: globalGuided, project: null, edits: { dock: dockOff }, name_: "custom", count: 1, has: { dock: dockOff }, mode: { dock: "off" } },
    { name: "one door moved on the global layer", global: globalGuided, scope: "global", edits: { dock: dockOff }, name_: "custom", count: 17, has: { dock: dockOff } },
    // Nothing moved: the layer keeps the name it already stores.
    { name: "nothing moved", global: globalGuided, scope: "global", name_: "guided", count: 17, has: { dock: structuredClone(PRESETS.guided.doors.dock) } },
    // A preset with an edit on top is no longer that preset.
    { name: "preset then one door moved", global: globalGuided, project: null, preset: "watchOnly", edits: { lookAgain: { mode: "on", minutes: 30, steps: 2 } }, name_: "custom", count: 17, has: { relaunch: { mode: "off", cap: 3 }, lookAgain: { mode: "on", minutes: 30, steps: 2 } } },
    // All three at once: a reset, a preset, and an edit on a door the preset also sets.
    { name: "reset, preset and edit together", global: globalFull, project: projectRelaunchLive, resets: [...AUTO], preset: "guided", edits: { relaunch: { mode: "dry", cap: 1 } }, name_: "custom", count: 17, has: { relaunch: { mode: "dry", cap: 1 }, startSession: { mode: "off", tries: 3 } }, mode: { relaunch: "dry", startSession: "off" } },
  ];

  test("every combination of reset, preset, edit and global layer saves the layer it says", () => {
    for (const row of rows) {
      const a = answerOf(row.global, row.project ?? null);
      const saved = layerToSave(a, row.scope ?? "project", row.resets ?? [], row.preset ?? null, row.edits ?? {});
      const after = resolvePolaris(row.global, saved);
      const at = (door: DoorId) => `${row.name}: ${door}`;
      expect([row.name, saved.preset]).toEqual([row.name, row.name_]);
      expect([row.name, Object.keys(saved.doors ?? {}).length]).toEqual([row.name, row.count]);
      for (const [door, value] of Object.entries(row.has ?? {})) expect([at(door as DoorId), saved.doors?.[door as DoorId]]).toEqual([at(door as DoorId), value]);
      for (const door of row.lacks ?? []) expect([at(door), saved.doors?.[door]]).toEqual([at(door), undefined]);
      for (const [door, mode] of Object.entries(row.mode ?? {})) expect([at(door as DoorId), after.settings.doors[door as DoorId].mode]).toEqual([at(door as DoorId), mode]);
    }
  });

  test("a live position is unreachable unless the person chose it: a preset after Use global never falls back to a live global", () => {
    for (const preset of ["watchOnly", "guided"] as const) {
      for (const resets of [[], ["relaunch"], [...AUTO]] as DoorId[][]) {
        const saved = layerToSave(answerOf(globalFull, projectRelaunchLive), "project", resets, preset, {});
        const after = resolvePolaris(globalFull, saved);
        expect([preset, resets.join(","), after.layers.relaunch, after.settings.doors.relaunch.mode]).toEqual([preset, resets.join(","), "project", preset === "watchOnly" ? "off" : "dry"]);
        expect(liveQuestion("relaunch", PRESETS[preset].doors.relaunch, after.settings.doors.relaunch)).toBeNull();
      }
    }
  });

  test("the one live choice the person can make is the preset that carries it, and it is asked about", () => {
    const saved = layerToSave(answerOf(globalGuided, projectRelaunchLive), "project", ["relaunch"], "fullAutopilot", {});
    expect(resolvePolaris(globalGuided, saved).settings.doors.relaunch.mode).toBe("live");
    expect(liveQuestion("relaunch", { mode: "dry", cap: 3 }, PRESETS.fullAutopilot.doors.relaunch)).not.toBeNull();
  });

  test("a door-only save in a project does not pin the inherited preset name", () => {
    const a = answerOf(globalGuided, null);
    expect(a.preset).toBe("guided");
    const saved = layerToSave(a, "project", [], null, { dock: dockOff });
    expect(saved.preset).toBe("custom");
    const after = resolvePolaris(globalGuided, saved);
    expect([after.presetLayer, after.settings.preset]).toEqual(["project", "custom"]);
  });

  test("the view saves through that one function, with the doors this person moved", () => {
    expect(view).toContain("const { plan: p, layer } = saveCommit(state, answer, scope);");
    expect(view).toContain("save({ settings: layer })");
    expect(draftSrc).toContain("doorEdits(s.draft.doors, s.base.doors, s.resets)");
    expect(view).not.toContain("for (const door of resets) delete doors[door]");
  });

  test("doorEdits names the doors that differ and leaves the rest alone", () => {
    const base = structuredClone(PRESETS.guided.doors);
    const draft = structuredClone(base);
    draft.lookAgain = { ...draft.lookAgain, steps: 4 };
    expect(Object.keys(doorEdits(draft, base))).toEqual(["lookAgain"]);
    expect(doorEdits(draft, draft)).toEqual({});
  });
});

describe("an edit cancels its own reset, and only a real edit does", () => {
  test("a patch that changes nothing is no edit", () => {
    expect(patchChanges({ mode: "on", minutes: 15, steps: 1 }, { minutes: 15 })).toBe(false);
    expect(patchChanges({ mode: "on", minutes: 15, steps: 1 }, { minutes: 30 })).toBe(true);
    expect(patchChanges({ mode: "off", excluded: [3] }, { excluded: [3] })).toBe(false);
    expect(patchChanges({ mode: "off" }, { mode: "on" })).toBe(true);
  });
  test("the reset of one door goes and the others stay", () => {
    const resets = new Set<DoorId>(["follow", "dock"]);
    expect([...withoutDoor(resets, "follow")]).toEqual(["dock"]);
    expect([...resets]).toEqual(["follow", "dock"]);
  });
  test("dirty is not lost by a click on the value a door already has", () => {
    // Use global leaves the door marked changed; a click that patches its current value must leave that mark and Save enabled.
    expect(patchChanges({ mode: "off" }, { mode: "off" })).toBe(false);
    expect(draftSrc).toContain("if (!patchChanges(shown[door], patch)) return s;");
    expect(draftSrc).toContain("const resets = withoutDoor(s.resets, door);");
  });
});

describe("Use the general setting counts the block it names", () => {
  const doorsOf = (id: "Watching" | "Automatic") => GROUPS.find((g) => g.id === id)!.doors;
  test("only a block with doors of its own offers the reset", () => {
    const a = answerOf({ version: 1, doors: { follow: { mode: "on" } } }, { version: 1, doors: { relaunch: { mode: "live", cap: 3 } } });
    expect(ownCount(a, "project", doorsOf("Watching"))).toBe(0);
    expect(ownCount(a, "project", doorsOf("Automatic"))).toBe(1);
    expect(ownCount(a, "global", doorsOf("Automatic"))).toBe(0);
  });
  test("it resets and counts only the doors this layer owns, not the whole block", () => {
    const a = answerOf(
      { version: 1, doors: { relaunch: { mode: "dry", cap: 3 }, rerunButton: { mode: "button" }, beacon: { mode: "draft" }, match: { mode: "use" }, course: { mode: "hours" }, cleanup: { mode: "propose" } } },
      { version: 1, doors: { startSession: { mode: "click", tries: 2 } } },
    );
    expect(doorsOf("Automatic").length).toBe(7);
    expect(ownedDoors(a, "project", doorsOf("Automatic"))).toEqual(["startSession"]);
    expect(ownCount(a, "project", doorsOf("Automatic"))).toBe(1);
    expect(draftSrc).toContain("const owned = ownedDoors(s.base, scope, doors);");
  });
  test("the menu row is gated on the block the menu belongs to, not the open one", () => {
    expect(view).toContain('disabled={scope !== "project" || ownCountOf(menu.tab) === 0}');
    expect(view).not.toContain("ownCountOf(tab) === 0}>Use the general setting");
  });
});

describe("the small guards the cold review asked for", () => {
  test("the block menu is drawn with the house menu rows", () => {
    expect(view).toContain("<MenuRow onClick=");
    expect(view).not.toContain('role="menuitem"');
  });
  test("a live or dry position is marked on its own row", () => {
    expect(view).toContain("const mark = markOf(door, value)");
    expect(view).toContain("agx-pol-mark-word");
  });
  test("a limit row names its door and dims while the door is off", () => {
    expect(view).toContain('Belongs to “{DOOR_COPY[door].name}”');
    expect(css).toContain(".agx-pol-limit-row[data-off]");
  });
  test("a failed reload is shown even while an answer is on screen", () => {
    expect(view).toContain('{error && !note && <div className="agx-pol-error"');
  });
  test("a key typed into a field is not a block shortcut", () => {
    expect(view).toContain("input, textarea, select, [contenteditable='true']");
  });
  test("Use the general setting is refused when the block it names has nothing of its own", () => {
    expect(view).toContain('disabled={scope !== "project" || ownCountOf(menu.tab) === 0}');
    expect(view).toContain("const ownCountOf = (t: TabId) => draftedDoors(state, scope, groupOf(t)?.doors ?? []).length");
  });
  test("the example card belongs to its block and closes when another block opens", () => {
    expect(view).toMatch(/useEffect\(\(\) => \{ setInfo\(null\); \}, \[tab\]\);/);
  });
  test("the block menu says what it really does: a safest position, not off", () => {
    expect(view).toContain("Take this block's safest position");
    expect(view).not.toContain("Turn this block off");
    expect([DOOR_MODES.approvals[0], DOOR_MODES.redsNamed[0], DOOR_MODES.match[0]]).toEqual(["people", "block", "ask"]);
  });
  test("the rail prints the words the helper gives it, not its own copy", () => {
    expect(view).toContain("{railWords(l, Number(doors[l.door][l.param]))}");
    expect(view).not.toContain("{l.rail}</span>");
  });
  test("a preset choice counts as one change, not one per door", () => {
    expect(draftSrc).toContain("unsaved: (chosen !== null ? 1 : moved.length) + (enabledMoved ? 1 : 0)");
  });
});

describe("the rest of the third cold review", () => {
  const dockOff: DoorValue = { mode: "off", label: "docked", excluded: [] };
  const doc = readFileSync(join(import.meta.dir, "..", "..", "docs", "POLARIS.md"), "utf8");

  test("a save measured after a broadcast keeps the other window's change under this person's edits", () => {
    const base = answerOf({ version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) }, { version: 1, doors: { dock: dockOff } });
    // The other window turned labels off while this draft was open; the draft only moved follow.
    const fresh = answerOf({ version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) }, { version: 1, doors: { dock: dockOff, labels: { mode: "off" } } });
    const draft = structuredClone(base.doors);
    draft.dock = dockOff;
    const saved = layerToSave(fresh, "project", [], null, doorEdits(draft, base.doors));
    expect(saved.doors?.labels).toEqual({ mode: "off", rules: [] });
    expect(saved.doors?.dock).toEqual(dockOff);
    expect(view).toContain("let cur = answer;");
  });

  test("a label field follows the stored value instead of writing back what it never saw", () => {
    expect(params).toContain('useEffect(() => { setLabel(String(value ?? "")); }, [value]);');
  });

  test("the tabs and Save sit in the pinned chrome, not in the panel that scrolls", () => {
    expect(view).toMatch(/\n {8}<div className="agx-pol-tabbar">/);
    expect(view).toMatch(/\n {6}<div className="agx-pol-panel"/);
  });

  test("the docs do not promise a format banner the view does not draw", () => {
    expect(doc).not.toContain("the card says so");
    expect(doc).toContain("a layer keeps the format");
  });

  test("the view's type follows the Interface font size setting, and it says what scrolls the doors", () => {
    expect(css).not.toMatch(/font-size: \d+(\.\d+)?px/);
    expect((css.match(/var\(--agx-fs, 1\)/g) ?? []).length).toBeGreaterThan(30);
    // The one statement of the drawing's position lives in the frame's test.
    expect(css).toContain("page scrolls as a whole");
  });

  test("the preset cards are one tab stop and answer the arrow keys", () => {
    expect(view).toContain("tabIndex={presetFocus === id ? 0 : -1}");
    expect(view).toContain("presetRefs.current[id]?.focus();");
    expect(view).toContain("const presetFocus = PRESET_IDS.includes(draft.preset as PresetId)");
  });

  test("the tabs name themselves and the panel is labelled by its tab", () => {
    expect(view).toContain("id={`pol-tab-${t.id}`}");
    expect(view).toContain("aria-labelledby={`pol-tab-${tab}`}");
  });

  test("a switch answers on the house hit size, not on its 20 px track", () => {
    expect(css).toMatch(/\.agx-pol-row \.agx-switch-hit \{[^}]*min-height: 26px/);
  });

  test("a limit whose door is off is grey, not marked as an unsaved change", () => {
    expect(view).toContain('className="agx-pol-off-chip"');
    expect(view).not.toContain('className="agx-pol-changed">door is off');
    expect(css).toContain(".agx-pol-off-chip");
  });

  test("a list says its empty line as a list item", () => {
    expect(params).toContain('<span role="listitem">No pull request excluded by number.</span>');
  });
});

describe("a save is decided from the positions it leaves, not from the click that led there", () => {
  const AUTO = GROUPS.find((g) => g.id === "Automatic")!.doors;
  const globalFull: StoredPolaris = { version: 1, preset: "fullAutopilot", doors: structuredClone(PRESETS.fullAutopilot.doors) };
  const projectGuided: StoredPolaris = { version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) };
  const AUTO_LIVE: DoorId[] = ["relaunch", "startSession"];

  test("Use global, then the preset already in force: that preset is what is saved, not the live global under it", () => {
    let s = draftState(answerOf(globalFull, projectGuided));
    s = useGlobalDoors(s, "project", AUTO);
    expect(s.draft.preset).toBe("guided");
    s = pickPreset(s, "project", "guided");
    const plan = savePlan(s, "project");
    expect(plan.chosen).toBe("guided");
    expect(resolvePolaris(globalFull, plan.effective.pending).settings.doors.relaunch.mode).toBe("dry");
    expect(plan.live).toEqual([]);
    expect(plan.consent).toEqual([]);
    expect(plan.dirty).toBe(true);
  });

  test("Use global alone: the rows show the inherited live position and Save asks for each door first", () => {
    const a = answerOf(globalFull, projectGuided);
    const plan = savePlan(useGlobalDoors(draftState(a), "project", AUTO), "project");
    expect(a.doors.relaunch.mode).toBe("dry");
    // The row shows what the save leaves, not the value the project is dropping.
    expect(plan.effective.doors.relaunch.mode).toBe("live");
    expect(plan.effective.pending.doors?.relaunch).toBeUndefined();
    expect(plan.chosen).toBeNull();
    expect(plan.live).toEqual(AUTO_LIVE);
    expect(plan.consent).toEqual(AUTO_LIVE);
  });

  test("the same, with a preset pressed after Use global: nothing live is left to ask about", () => {
    let s = draftState(answerOf(globalFull, projectGuided));
    s = useGlobalDoors(s, "project", AUTO);
    s = pickPreset(s, "project", "watchOnly");
    const plan = savePlan(s, "project");
    expect(plan.effective.live.filter((d) => AUTO.includes(d))).toEqual([]);
    expect(plan.consent).toEqual([]);
  });

  test("a number edited on an inherited live door asks before this layer keeps it live", () => {
    const a = answerOf(globalFull, null);
    const plan = savePlan(patchDoor(draftState(a), "project", "relaunch", { cap: 2 }), "project");
    expect(plan.edits.relaunch).toMatchObject({ mode: "live", cap: 2 });
    expect(plan.effective.layers.relaunch).toBe("project");
    expect(plan.consent).toEqual(["relaunch"]);
  });

  test("a door-only edit writes that door and nothing it inherits", () => {
    const plan = savePlan(patchDoor(draftState(answerOf(projectGuided, null)), "project", "dock", { mode: "off" }), "project");
    expect(Object.keys(plan.effective.pending.doors ?? {})).toEqual(["dock"]);
    expect(plan.effective.pending.preset).toBe("custom");
    expect(plan.chosen).toBeNull();
  });

  test("pressing the preset already in force is a choice even when nothing else moved", () => {
    const plan = savePlan(pickPreset(draftState(answerOf(globalFull, projectGuided)), "project", "guided"), "project");
    expect(plan.dirty).toBe(true);
    expect(plan.unsaved).toBe(1);
    expect(plan.chosen).toBe("guided");
  });

  test("picking a door's live position is named by the plan the confirmation reads", () => {
    const a = answerOf(globalFull, projectGuided);
    const plan = savePlan(patchDoor(draftState(a), "project", "startSession", { mode: "click" }), "project");
    expect(plan.consent).toEqual(["startSession"]);
    expect(plan.live).toContain("startSession");
  });

  test("the view refuses the first Save and asks with a confirmation that names the door", () => {
    expect(view).toContain("if (p.consent.length > 0) { setConfirm(p.consent); return; }");
    expect(view).toContain("onClick={askSave}>Save changes");
    expect(view).toContain('role="alertdialog"');
    expect(view).toContain("consentSentence(d, plan.effective)");
    expect(view).toContain("plan.dirty && plan.live.length > 0");
  });

  test("every live door is marked from the position it would have, not from the draft value", () => {
    expect(view).toContain("value={doors[door]}");
    expect(view).toContain("const doors = plan.effective.doors;");
    expect(view).toContain("source={rowSource(scope, plan.effective.layers[door])}");
  });

  test("only one region announces a failed save", () => {
    expect(view).toContain("{error && !note && <div className=\"agx-pol-error\" role=\"alert\">");
    expect(view).not.toContain("{note && <div className=\"agx-pol-error\" role=\"alert\">");
    expect(view).toContain("role={note ? \"alert\" : \"status\"}");
  });
});

describe("the fifth cold review's small fixes", () => {
  const AUTO = GROUPS.find((g) => g.id === "Automatic")!.doors;
  test("Use global is offered once a preset fills a block this layer does not own", () => {
    const a = answerOf({ version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) }, null);
    expect(ownCount(a, "project", AUTO)).toBe(0);
    const s = pickPreset(draftState(a), "project", "fullAutopilot");
    // The preset lands doors on this block that differ from the global layer, so the button
    // that takes them back is offered; the doors the preset leaves as they were need no reset.
    expect(draftedDoors(s, "project", AUTO).length).toBeGreaterThan(0);
    expect(draftedDoors(s, "project", AUTO)).toContain("relaunch");
    expect(view).toContain("draftedDoors(state, scope, groupOf(t)?.doors ?? []).length");
    expect(view).not.toContain("ownCount(base, scope");
  });
  test("the savebar counts the doors a save would write, not the one preset label", () => {
    const a = answerOf(null, null);
    const presetOnly = savePlan(pickPreset(draftState(a), "project", "watchOnly"), "project");
    expect(presetOnly.unsaved).toBe(1);
    const moved = savePlan(patchDoor(pickPreset(draftState(a), "project", "watchOnly"), "project", "relaunch", { mode: "dry" }), "project");
    expect(moved.unsaved).toBe(moved.moved.length);
    expect(moved.unsaved).toBeGreaterThan(1);
  });
  test("the preset cards and the power switch refuse a click while a save is in flight", () => {
    expect(view).toContain('role="switch" aria-checked={draft.enabled} aria-label="Polaris" disabled={busy}');
    expect(view).toContain('aria-checked={draft.preset === id} disabled={busy}');
  });
  test("the switch hit size is scoped to this view, so the other switches do not move", () => {
    const index = readFileSync(join(import.meta.dir, "..", "src", "index.css"), "utf8");
    expect(index).toMatch(/\.agx-switch-hit \{ cursor: pointer; \}/);
    expect(css).toMatch(/\.agx-pol-row \.agx-switch-hit \{[^}]*min-height: 26px/);
    expect(css).toMatch(/\.agx-pol-power \{[^}]*min-height: 26px/);
  });
  test("Save decides from one plan: the confirmation and the layer come out of it together", () => {
    expect(view).toContain("const { plan: p, layer } = saveCommit(state, answer, scope);");
    expect(view).toContain("if (p.consent.some((d) => !allowed.includes(d))) { setConfirm(p.consent); return; }");
    expect(view).toContain("onClick={() => void commit(confirm)}");
    expect(draftSrc).toContain("const plan = savePlan({ ...s, base: answer }, scope);");
  });
});

describe("a preset saved is stored as that preset", () => {
  const guided = (): StoredPolaris => ({ version: 1, preset: "guided", doors: structuredClone(PRESETS.guided.doors) });
  const saved = (global: StoredPolaris | null, project: StoredPolaris | null, scope: Scope, id: PresetId) => {
    const a = answerOf(global, project);
    const { plan, layer } = saveCommit(pickPreset(draftState(a), scope, id), a, scope);
    return { plan, layer };
  };

  test("preset-then-Save stores the preset name", () => {
    for (const id of ["watchOnly", "fullAutopilot", "guided"] as PresetId[]) {
      for (const scope of ["project", "global"] as Scope[]) {
        for (const base of [null, guided()]) {
          const { plan, layer } = saved(scope === "project" ? (base ?? guided()) : base, null, scope, id);
          expect(layer.preset).toBe(id);
          // The preset's own doors are not this save's edits, so no row is marked as moved.
          expect(plan.moved).toEqual([]);
          expect(plan.unsaved).toBe(1);
        }
      }
    }
  });

  test("preset-then-door-edit-then-Save stores custom", () => {
    const a = answerOf(guided(), null);
    const s = patchDoor(pickPreset(draftState(a), "project", "watchOnly"), "project", "dock", { mode: "off" });
    const { layer } = saveCommit(s, a, "project");
    expect(layer.preset).toBe("custom");
    // The door the person moved is written; the preset's own doors are not this save's edits.
    expect(layer.doors?.dock).toEqual({ mode: "off", label: "docked", excluded: [] });
    // …and the preset is still in the layer: its other doors are written with it.
    expect(layer.doors?.course).toEqual(PRESETS.watchOnly.doors.course);
  });

  test("door-edit-only stores custom", () => {
    const a = answerOf(guided(), null);
    expect(saveCommit(patchDoor(draftState(a), "project", "dock", { mode: "off" }), a, "project").layer.preset).toBe("custom");
  });

  test("a click on the value a row already shows is not an edit", () => {
    // WatchOnly leaves dock on, which is what its row shows: the click is not a change and must not
    // take back the preset choice or leave Save enabled.
    const a = answerOf(guided(), null);
    const s = pickPreset(draftState(a), "project", "watchOnly");
    expect(patchDoor(s, "project", "dock", { mode: "on" })).toBe(s);
  });

  test("re-pick the same preset stores that preset", () => {
    // The preset is in force from the global layer: picking it again on the project must store it here.
    const project: StoredPolaris = { version: 1, doors: { follow: { mode: "on" } } };
    const a = answerOf(guided(), project);
    expect(a.preset).toBe("guided");
    expect(a.presetLayer).toBe("global");
    const { plan, layer } = saved(guided(), project, "project", "guided");
    expect(layer.preset).toBe("guided");
    expect(plan.dirty).toBe(true);
  });
});
