/*
 * What the Polaris card and the Pull requests section decide, with no window: which words a
 * door shows, which layer a change writes, what each class of item offers as its one button.
 * The components only draw these answers, so the rules are asserted here against real shared
 * settings (resolvePolaris), not against a hand-made object.
 */
import { describe, expect, test } from "bun:test";
import { DOOR_IDS, DOOR_MODES, PRESETS, resolvePolaris, withPreset, withEnabled, safeDoor, type BaseRed, type PolarisItem, type SettingsAnswer, type StoredPolaris } from "../../shared/polaris.ts";
import { DOOR_COPY, GROUPS } from "../src/lib/polarisCopy.ts";
import {
  assistPrompt, assistState, changeDoor, chipLabel, baseBanners, baseOfItem, beaconOf, classCounts, courseText, fixNotice, syncResult, syncWarning, doorView, draftSaveable, formatBadge, formatNotice, groupViews, limitViews, stampFormat, undoStamp, inheritAll, itemView, liveQuestion, markOf, newDoors, presetQuestion, resetDoors,
  scopeOf, sendState, showsParams, sortItems, storedOf, waitingOnYou, withoutNumber,
} from "../src/lib/polarisView.ts";

const answer = (global: StoredPolaris | null, project: StoredPolaris | null = null): SettingsAnswer => {
  const r = resolvePolaris(global, project);
  return { ok: true, ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, presetLayer: r.presetLayer };
};
const guided = withEnabled(null, true);
const item = (o: Partial<PolarisItem> & { cls: PolarisItem["cls"] }): PolarisItem => ({
  number: 322, title: "Add retry to the webhook sender", url: "https://github.com/acme/orbit/pull/322", author: "ana", head: "feat/retry",
  ignored: false, draft: null, proposed: [], dropped: [], reason: null, sentence: "Cleared to land.", headSha: "1".repeat(40), canSync: false, syncDraft: null, ...o,
});
const run = { runId: 9, attempt: 1, pending: false, job: { id: 11, conclusion: "failure", stepConclusions: [] } };

describe("the doors in their groups", () => {
  test("each of the 17 doors is in exactly one group", () => {
    const all = GROUPS.flatMap((g) => g.doors);
    expect([...all].sort()).toEqual([...DOOR_IDS].sort());
    expect(new Set(all).size).toBe(17);
  });
  test("groups come in the order the card draws them", () => {
    expect(GROUPS.map((g) => g.id)).toEqual(["Watching", "Landing", "Signals", "Automatic", "Limits"]);
  });
  test("every door has a sentence, an example and what stays yours, and a label for each of its modes", () => {
    for (const d of DOOR_IDS) {
      const c = DOOR_COPY[d];
      expect([c.name, c.what, c.example, c.keep].every((t) => t.length > 10), d).toBe(true);
      for (const m of DOOR_MODES[d]) expect(c.modes[m], `${d}.${m}`).toBeTruthy();
      // Sentence case: the first letter of a label is a capital, never an all-lowercase UI text.
      for (const l of Object.values(c.modes)) expect(l[0], l).toBe(l[0]!.toUpperCase());
    }
  });
  test("the copy names no product of a tracker or a chat", () => {
    const text = JSON.stringify(DOOR_COPY);
    expect(/clickup|jira|slack/i.test(text)).toBe(false);
  });
});

describe("scope: which layer the page edits and where a door comes from", () => {
  test("a project edits its own layer, Global and All projects edit the global one", () => {
    expect(scopeOf("/home/me/code/orbit")).toBe("project");
    expect(scopeOf("")).toBe("global");
  });
  test("in a project, a door set only globally says it inherits global and is inherited", () => {
    const a = answer(guided, null);
    const v = doorView(a, "project", "relaunch");
    expect(v.inherits).toBe(true);
    expect(v.source).toBe("Inherits global");
  });
  test("a door the project set itself is its own, with no inherit words", () => {
    const proj = withPreset(null, "watchOnly");
    const v = doorView(answer(guided, proj), "project", "follow");
    expect(v.inherits).toBe(false);
    expect(v.source).toBeNull();
  });
  test("a door nobody set says it starts in its safe position, in both scopes", () => {
    const a = answer(null, null);
    expect(doorView(a, "global", "relaunch").source).toMatch(/safe position/);
    expect(doorView(a, "project", "relaunch").source).toMatch(/safe position/);
  });
  test("in the global scope a global door has nothing to say", () => {
    expect(doorView(answer(guided), "global", "relaunch").source).toBeNull();
  });
  test("storedOf is only what the edited layer keeps, never what it inherits", () => {
    const proj: StoredPolaris = { doors: { follow: { ...safeDoor("follow"), mode: "on" } } };
    const a = answer(guided, proj);
    expect(Object.keys(storedOf(a, "project").doors ?? {})).toEqual(["follow"]);
    expect(Object.keys(storedOf(a, "global").doors ?? {})).toHaveLength(16); // follow is read from the project
    expect(storedOf(a, "project").enabled).toBeUndefined();
  });
});

describe("a change writes one layer and reads Custom", () => {
  test("changing a door in a project stores that door in the project and nothing else", () => {
    const a = answer(guided);
    const c = changeDoor(a, "project", "relaunch", { mode: "off" });
    expect("settings" in c).toBe(true);
    const s = (c as { settings: StoredPolaris }).settings;
    expect(Object.keys(s.doors!)).toEqual(["relaunch"]);
    expect(s.doors!.relaunch).toMatchObject({ mode: "off", cap: 3 });
    expect(s.preset).toBe("custom");
  });
  test("in the global layer the other 16 doors are kept", () => {
    const s = (changeDoor(answer(guided), "global", "beacon", { mode: "off" }) as { settings: StoredPolaris }).settings;
    expect(Object.keys(s.doors!)).toHaveLength(17);
    expect(s.doors!.follow).toEqual(PRESETS.guided.doors.follow);
  });
  test("a setting of a door changes alone: cap moves, the mode stays", () => {
    const s = (changeDoor(answer(guided), "global", "relaunch", { cap: 1 }) as { settings: StoredPolaris }).settings;
    expect(s.doors!.relaunch).toMatchObject({ mode: "dry", cap: 1 });
  });
  test("resetting a group in a project drops those doors so they inherit", () => {
    const proj = withPreset(null, "fullAutopilot");
    const s = (resetDoors(answer(guided, proj), "project", ["relaunch", "rerunButton"]) as { settings: StoredPolaris }).settings;
    expect(s.doors!.relaunch).toBeUndefined();
    expect(s.doors!.follow).toBeDefined();
  });
  test("resetting every door of a project layer leaves no doors and no preset", () => {
    const proj = withPreset(null, "guided");
    const s = (resetDoors(answer(guided, proj), "project", [...DOOR_IDS]) as { settings: StoredPolaris }).settings;
    expect(s.doors).toBeUndefined();
    expect(s.preset).toBeUndefined();
  });
  test("resetting a group in the global layer puts its doors back to Guided", () => {
    const full = withPreset(null, "fullAutopilot");
    const s = (resetDoors(answer(full), "global", ["relaunch"]) as { settings: StoredPolaris }).settings;
    expect(s.doors!.relaunch).toEqual(PRESETS.guided.doors.relaunch);
    expect(s.doors!.cards).toEqual(PRESETS.fullAutopilot.doors.cards);
  });
  test("use global for all drops the project's layer altogether", () => {
    expect(inheritAll()).toEqual({ settings: null });
  });
});

describe("going live asks first, the way back never does", () => {
  const d = (door: Parameters<typeof safeDoor>[0], o: Record<string, unknown>) => ({ ...safeDoor(door), ...o });
  test("relaunch from dry run to live asks, and says it will not merge", () => {
    const q = liveQuestion("relaunch", d("relaunch", { mode: "dry" }), d("relaunch", { mode: "live" }));
    expect(q).toMatch(/not merge/);
  });
  test("relaunch from live back to dry asks nothing", () => {
    expect(liveQuestion("relaunch", d("relaunch", { mode: "live" }), d("relaunch", { mode: "dry" }))).toBeNull();
  });
  test("a cap lowered inside live asks nothing", () => {
    expect(liveQuestion("relaunch", d("relaunch", { mode: "live", cap: 3 }), d("relaunch", { mode: "live", cap: 1 }))).toBeNull();
  });
  test("a cap raised inside live asks again", () => {
    expect(liveQuestion("relaunch", d("relaunch", { mode: "live", cap: 1 }), d("relaunch", { mode: "live", cap: 3 }))).not.toBeNull();
  });
  test("a door that has no live position never asks", () => {
    expect(liveQuestion("follow", d("follow", { mode: "off" }), d("follow", { mode: "on" }))).toBeNull();
  });
  test("Full autopilot asks and names the doors it puts live; Guided asks nothing", () => {
    expect(presetQuestion(answer(guided), "fullAutopilot")).toMatch(/relaunch/i);
    expect(presetQuestion(answer(guided), "guided")).toBeNull();
    expect(presetQuestion(answer(guided), "watchOnly")).toBeNull();
  });
  test("dry run and live are marked on the door", () => {
    expect(markOf("relaunch", d("relaunch", { mode: "dry" }))).toBe("Dry run");
    expect(markOf("relaunch", d("relaunch", { mode: "live" }))).toBe("Live");
    expect(markOf("cards", d("cards", { mode: "on" }))).toBe("Live");
    expect(markOf("relaunch", d("relaunch", { mode: "off" }))).toBeNull();
    expect(markOf("follow", d("follow", { mode: "on" }))).toBeNull();
  });
});

describe("the New badge", () => {
  test("a door nobody set, beside doors that are set, is new", () => {
    const a = answer({ doors: { follow: safeDoor("follow") } });
    expect(newDoors(a)).toHaveLength(16);
    expect(doorView(a, "global", "dock").isNew).toBe(true);
    expect(doorView(a, "global", "follow").isNew).toBe(false);
  });
  test("with nothing stored anywhere no door is new", () => {
    expect(newDoors(answer(null))).toEqual([]);
  });
  test("a group counts its new doors", () => {
    const a = answer({ doors: { follow: safeDoor("follow") } });
    expect(groupViews(a, "global").find((g) => g.id === "Watching")!.newCount).toBe(2);
  });
  test("a reset reads Use global in a project and Reset to Guided in the global layer", () => {
    expect(groupViews(answer(guided), "project")[0]!.resetLabel).toBe("Use global");
    expect(groupViews(answer(guided), "global")[0]!.resetLabel).toBe("Reset to Guided");
  });
});

describe("settings under a door", () => {
  test("the dock always shows its label; labels and look again only while on; the counts are in Limits", () => {
    expect(showsParams("dock", "off")).toBe(true);
    expect(showsParams("relaunch", "dry")).toBe(false);
    expect(showsParams("labels", "off")).toBe(false);
    expect(showsParams("labels", "on")).toBe(true);
    expect(showsParams("lookAgain", "off")).toBe(false);
    expect(showsParams("lookAgain", "on")).toBe(true);
    expect(showsParams("follow", "on")).toBe(false);
  });
  test("the chip on the Coordinator card names the preset, and is absent while Polaris is off", () => {
    expect(chipLabel(answer(guided))).toBe("Polaris, Guided");
    expect(chipLabel(answer(withPreset(null, "fullAutopilot")))).toBeNull();
    expect(chipLabel(answer({ ...withPreset(null, "fullAutopilot"), enabled: true }))).toBe("Polaris, Full autopilot");
    expect(chipLabel(null)).toBeNull();
  });
});

describe("what each class of item shows", () => {
  const doors = answer(guided).doors;
  test("Cleared to land opens GitHub: the person merges there, and no command is copied", () => {
    const v = itemView(item({ cls: "Cleared to land" }), doors);
    expect(v.act).toMatchObject({ label: "Open on GitHub", what: { kind: "open", url: "https://github.com/acme/orbit/pull/322" } });
    expect(JSON.stringify(v)).not.toMatch(/gh pr|copy/i);
    expect(v.waitsOn).toBe("you");
  });
  test("Needs you opens the pull request, or reviews a drafted beacon", () => {
    expect(itemView(item({ cls: "Needs you" }), doors).act).toMatchObject({ label: "Open PR", what: { kind: "open" } });
    const d = itemView(item({ cls: "Needs you", draft: "Please rebase on main." }), doors);
    expect(d.act).toMatchObject({ label: "Review beacon", what: { kind: "beacon" } });
    expect(d.note).toMatch(/beacon/);
  });
  test("Drifting in a dry run shows the greyed Would relaunch", () => {
    const v = itemView(item({ cls: "Drifting", dropped: [run] }), doors);
    expect(v.act).toMatchObject({ label: "Would relaunch", ghost: true });
  });
  test("Drifting with relaunch live has no button and says Polaris does it", () => {
    const live = answer(withPreset(null, "fullAutopilot")).doors;
    const v = itemView(item({ cls: "Drifting", dropped: [run] }), live);
    expect(v.act).toBeNull();
    expect(v.note).toMatch(/by itself/);
  });
  test("Drifting with relaunch off, or with no dropped job, opens the pull request", () => {
    const off = answer(withPreset(null, "watchOnly")).doors;
    expect(itemView(item({ cls: "Drifting", dropped: [run] }), off).act?.label).toBe("Open PR");
    expect(itemView(item({ cls: "Drifting" }), doors).act?.label).toBe("Open PR");
  });
  test("In orbit and Uncharted have nothing to click", () => {
    expect(itemView(item({ cls: "In orbit" }), doors).act).toBeNull();
    expect(itemView(item({ cls: "Uncharted" }), doors).act).toBeNull();
    expect(itemView(item({ cls: "Uncharted" }), doors).waitsOn).toBe("GitHub");
  });
  test("Docked offers Undock only for a number excluded by hand", () => {
    const withDock = answer({ ...guided, doors: { ...guided.doors, dock: { ...safeDoor("dock"), mode: "on", excluded: [301] } } }).doors;
    expect(itemView(item({ cls: "Docked", number: 301 }), withDock).act?.label).toBe("Undock");
    expect(itemView(item({ cls: "Docked", number: 302 }), withDock).act).toBeNull();
    expect(withoutNumber(withDock.dock, 301).excluded).toEqual([]);
  });
  test("Landed offers a cleanup proposal only when that door proposes", () => {
    expect(itemView(item({ cls: "Landed" }), doors).act?.label).toBe("Propose cleanup");
    expect(itemView(item({ cls: "Landed" }), answer(withPreset(null, "watchOnly")).doors).act).toBeNull();
  });
  test("every class is read, so a class added later is a type error here", () => {
    const classes = ["Cleared to land", "Needs you", "Drifting", "In orbit", "Docked", "Landed", "Uncharted"] as const;
    for (const cls of classes) expect(itemView(item({ cls }), doors).cls).toBe(cls);
  });
});

describe("the order and the rows that wait on you", () => {
  const doors = answer(guided).doors;
  const list = [item({ cls: "Docked", number: 1 }), item({ cls: "Cleared to land", number: 2 }), item({ cls: "Needs you", number: 4 }), item({ cls: "In orbit", number: 5 }), item({ cls: "Needs you", number: 3 }), item({ cls: "Drifting", number: 6 }), item({ cls: "Uncharted", number: 7 }), item({ cls: "Landed", number: 8 })];
  test("the item that needs you most sorts first, and ties go by number", () => {
    expect(sortItems(list).map((i) => i.number)).toEqual([3, 4, 6, 2, 7, 5, 1, 8]);
  });
  test("Waiting on you lists Needs you and Cleared to land, and Cleared to land goes quiet when its door is off", () => {
    expect(waitingOnYou(list, doors).map((i) => i.number)).toEqual([3, 4, 2]);
    const off = answer({ ...guided, doors: { ...guided.doors, cleared: { ...safeDoor("cleared"), mode: "off" } } }).doors;
    expect(waitingOnYou(list, off).map((i) => i.number)).toEqual([3, 4]);
  });
  test("the one-line summary counts classes in reading order", () => {
    expect(classCounts(list).map((c) => `${c.n} ${c.cls}`)).toEqual(["2 Needs you", "1 Drifting", "1 Cleared to land", "1 Uncharted", "1 In orbit", "1 Docked", "1 Landed"]);
  });
});

describe("the beacon Send", () => {
  test("with the match on, Send works without a pick; with ask it waits for one", () => {
    expect(sendState("use", "").can).toBe(true);
    expect(sendState("ask", "").can).toBe(false);
    expect(sendState("ask", "%5").can).toBe(true);
    expect(sendState("use", "%5").hint).toMatch(/picked/);
  });
});

describe("Assisted setup", () => {
  const roles = (provider: string, installed: boolean) => ({ ok: true, roles: { builder: { provider } }, providers: [{ id: "claude", title: "Claude Code", installed }] });
  test("the engine set for the builder role is used", () => {
    expect(assistState(roles("claude", true))).toEqual({ ok: true, engine: "claude", title: "Claude Code" });
  });
  test("no engine, an engine not installed, or no answer disables it with a reason", () => {
    expect(assistState({ ok: true, roles: {} }).ok).toBe(false);
    expect(assistState(roles("claude", false))).toEqual({ ok: false, why: "Claude Code is not installed here." });
    expect(assistState(null).ok).toBe(false);
  });
  test("the prompt reads with settings get and writes with settings set, for the project, and never edits files", () => {
    const p = assistPrompt("/home/me/code/orbit");
    expect(p).toContain("agentglass-ui settings get polaris.");
    expect(p).toContain("agentglass-ui settings set polaris.door.<door>");
    expect(p).toContain("--root /home/me/code/orbit");
    for (const d of DOOR_IDS) expect(p).toContain(`polaris.door.${d}`);
    expect(p).toMatch(/Never merge/);
  });
  test("with no project the prompt carries no --root", () => {
    expect(assistPrompt("")).not.toContain("--root");
  });
});

describe("item clicks beside the course", () => {
  const doors = answer(guided).doors;
  const names = (i: PolarisItem, d = doors) => itemView(i, d).more.map((b) => b.label);
  test("Drifting offers to propose a course while that door is on, then says it is proposed", () => {
    expect(names(item({ cls: "Drifting" }))).toEqual(["Propose a course", "Dock", "Leave it"]);
    const v = itemView(item({ cls: "Drifting", proposed: ["course"] }), doors);
    expect(v.more.map((b) => b.label)).toEqual(["Dock", "Leave it"]);
    expect(v.note).toMatch(/course is proposed/);
    expect(itemView(item({ cls: "Drifting" }), doors).more[0]!.what).toEqual({ kind: "course", text: courseText(item({ cls: "Drifting" })) });
    const off = answer({ ...guided, doors: { ...guided.doors, course: { ...safeDoor("course") } } }).doors;
    expect(names(item({ cls: "Drifting" }), off)).toEqual(["Dock", "Leave it"]);
  });
  test("Dock needs the dock door on and an item that is not already docked, landed or excluded", () => {
    expect(names(item({ cls: "Needs you" }))).toEqual(["Dock", "Leave it"]);
    expect(names(item({ cls: "In orbit" }))).toEqual(["Dock"]);
    expect(names(item({ cls: "Docked" }))).toEqual([]);
    expect(names(item({ cls: "Landed" }))).toEqual([]);
    const off = answer(withPreset(null, "watchOnly")).doors;
    const noDock = answer({ ...guided, doors: { ...guided.doors, dock: { ...safeDoor("dock") } } }).doors;
    expect(names(item({ cls: "In orbit" }), noDock)).toEqual([]);
    expect(off.dock.mode).toBe("on");
    const excluded = answer({ ...guided, doors: { ...guided.doors, dock: { ...safeDoor("dock"), mode: "on", excluded: [322] } } }).doors;
    expect(names(item({ cls: "In orbit" }), excluded)).toEqual([]);
  });
  test("an ignored item has no course, no clicks and says it is left alone; it leaves Waiting on you", () => {
    const v = itemView(item({ cls: "Needs you", ignored: true }), doors);
    expect(v.act).toBeNull();
    expect(v.more).toEqual([]);
    expect(v.note).toMatch(/Left alone/);
    expect(waitingOnYou([item({ cls: "Needs you", ignored: true }), item({ cls: "Needs you", number: 2 })], doors).map((i) => i.number)).toEqual([2]);
  });
  test("a cleanup already proposed is shown done, greyed", () => {
    expect(itemView(item({ cls: "Landed", proposed: ["cleanup"] }), doors).act).toMatchObject({ label: "Cleanup proposed", ghost: true });
  });
});

describe("the beacon draft edit", () => {
  test("Save needs some text that differs from the draft", () => {
    expect(draftSaveable("Rebase on main.", "Rebase on main.")).toBe(false);
    expect(draftSaveable("Rebase on main.", "  Rebase on main.  ")).toBe(false);
    expect(draftSaveable("Rebase on main.", "   ")).toBe(false);
    expect(draftSaveable("Rebase on main.", "Rebase on main, then push.")).toBe(true);
    expect(draftSaveable(null, "A first line.")).toBe(true);
  });
});

describe("the Limits group", () => {
  test("it has the four counts and the look-again door, each saying which door it belongs to", () => {
    const g = groupViews(answer(guided), "global").find((x) => x.id === "Limits")!;
    expect(g.doors.map((d) => d.door)).toEqual(["lookAgain"]);
    expect(g.limits.map((l) => [l.name, l.value, l.on])).toEqual([
      ["Orbit limit", 2, false], ["Attempts per run", 3, true], ["Start tries", 3, false], ["Drifting before a course", 24, true],
    ]);
    expect(groupViews(answer(guided), "global").filter((x) => x.id !== "Limits").every((x) => x.limits.length === 0)).toBe(true);
  });
  test("a limit moves the door's own setting and nothing else", () => {
    const a = answer(guided);
    const c = changeDoor(a, "global", "relaunch", { cap: 1 }) as { settings: { doors: { relaunch: Record<string, unknown> } } };
    expect(c.settings.doors.relaunch).toMatchObject({ mode: "dry", cap: 1 });
    expect(limitViews(a, "global")[1]!.doorName).toMatch(/Relaunch/);
  });
});

describe("the settings format notice", () => {
  const stored = { ...guided, version: 1 };
  const a = answer(stored);
  test("nothing to say in the current format", () => {
    expect(formatNotice(a, "global")).toBeNull();
    expect(formatBadge(a)).toBe("Format 1");
  });
  test("a layer saved before a door was added is told which door, off until turned on", () => {
    const n = formatNotice(a, "global", 2, { cleanup: 2 })!;
    expect(n.doors).toEqual(["cleanup"]);
    expect(n.badge).toBe("Format 1 to 2");
    expect(n.sentence).toMatch(/one new door.*Propose cleanup after a merge.*off for you.*other doors did not change/);
    expect(n.example).toBe(DOOR_COPY.cleanup.example);
    expect(formatBadge(a, 2)).toBe("Format 1 to 2");
  });
  test("a format with no new door, or a layer the person never saved, says nothing", () => {
    expect(formatNotice(a, "global", 2, {})).toBeNull();
    expect(formatNotice(answer(null), "global", 2, { cleanup: 2 })).toBeNull();
    expect(formatNotice(a, "project", 2, { cleanup: 2 })).toBeNull();
  });
  test("Dismiss saves the layer in the new format with the doors as they were; Undo puts the old layer back", () => {
    const stamp = stampFormat(a, "global", 2) as { settings: StoredPolaris };
    expect(stamp.settings.version).toBe(2);
    expect(stamp.settings.doors).toEqual(storedOf(a, "global").doors);
    expect(undoStamp(storedOf(a, "global"))).toEqual({ settings: storedOf(a, "global") });
    expect((undoStamp(storedOf(a, "global")) as { settings: StoredPolaris }).settings.version).toBe(1);
  });
});

describe("a red the base branch has too", () => {
  const doors = answer(guided).doors;
  const red: BaseRed = { base: "main", checks: ["django-tests"], sinceSha: "abc1234ffff", tipSha: "abc1234ffff", fixed: false, inheritors: [318, 322, 325, 330], canSync: [] };
  const fixed: BaseRed = { ...red, tipSha: "def5678aaaa", fixed: true, canSync: [318, 322, 325, 330], url: "https://github.com/acme/orbit/actions/runs/9" };
  const inh = (o: Partial<PolarisItem> = {}) => item({ cls: "Needs you", reason: "inherited", sentence: "Red on the base branch too: django-tests.", inherited: { checks: ["django-tests"], baseSha: "abc1234ffff" }, ...o });

  test("no banner unless a base is red: an empty answer draws nothing", () => {
    expect(baseBanners(undefined)).toEqual([]);
    expect(baseBanners([])).toEqual([]);
  });
  test("red: the base, the check, since which commit, and how many inherit it; nothing to sync", () => {
    expect(baseBanners([red])).toEqual([{ base: "main", tone: "red", title: "main is red on django-tests since abc1234.", detail: "4 pull requests inherit it.", syncAll: null }]);
    expect(baseBanners([{ ...red, inheritors: [318] }])[0]!.detail).toBe("1 pull request inherits it.");
  });
  test("fixed: Sync all names how many, and the link goes to the base run", () => {
    expect(baseBanners([fixed])[0]).toMatchObject({ tone: "fixed", title: "main is fixed at def5678.", detail: "4 of 4 pull requests can sync.", url: fixed.url, syncAll: { label: "Sync all (4)", numbers: [318, 322, 325, 330] } });
  });
  test("fixed, but some still have checks running: only the ready ones are synced", () => {
    const b = baseBanners([{ ...fixed, canSync: [318, 322, 325] }])[0]!;
    expect(b.detail).toBe("3 of 4 pull requests can sync; 1 still has checks running.");
    expect(b.syncAll).toMatchObject({ label: "Sync all (3)", numbers: [318, 322, 325] });
    expect(baseBanners([{ ...fixed, canSync: [] }])[0]!.syncAll).toBeNull();
  });
  test("the toast shows once per fixing commit and never while the base is red or nothing can sync", () => {
    expect(fixNotice([red])).toBeNull();
    expect(fixNotice([{ ...fixed, canSync: [] }])).toBeNull();
    expect(fixNotice([fixed])).toEqual({ key: "main@def5678aaaa", text: "main fixed at def5678. 4 pull requests can sync." });
    expect(fixNotice([{ ...fixed, tipSha: "0123456bbbb" }])!.key).not.toBe(fixNotice([fixed])!.key);
  });
  test("a row shows the inherited chip and Open PR until it can sync, then Sync", () => {
    expect(itemView(inh(), doors)).toMatchObject({ inherited: true, cls: "Needs you", act: { label: "Open PR" } });
    expect(itemView(inh({ canSync: true }), doors).act).toMatchObject({ label: "Sync", what: { kind: "sync" } });
    expect(itemView(item({ cls: "Needs you", reason: "failing" }), doors).inherited).toBe(false);
  });
  test("a sync names the base commit of the base the item inherits from", () => {
    expect(baseOfItem([red, { ...fixed, base: "release", inheritors: [7] }], 7)!.base).toBe("release");
    expect(baseOfItem([fixed], 99)).toBeUndefined();
  });
  test("local commits not pushed warn on the button; a clean copy or none says nothing", () => {
    expect(syncWarning({ ahead: 2 })).toBe("Local commits not pushed. A sync will make your next push need a pull first.");
    expect(syncWarning({ ahead: 0 })).toBeNull();
    expect(syncWarning(null)).toBeNull();
  });
  test("what a sync click says: the server's sentence, a dry run, or syncing", () => {
    expect(syncResult({ ok: false, error: "conflict with base" })).toBe("conflict with base");
    expect(syncResult({ ok: true, outcome: "skipped-in-dry-run" })).toMatch(/^Dry run: nothing was pushed/);
    expect(syncResult({ ok: true, outcome: "done" })).toMatch(/^Syncing/);
    expect(syncResult(null)).toBe("That did not go through");
  });
  test("a sync note for a session that was left alone shows as a beacon under the reason synced", () => {
    expect(beaconOf(item({ cls: "In orbit", reason: "waiting", syncDraft: "Pull before you push." }))).toEqual({ draft: "Pull before you push.", reason: "synced" });
    expect(beaconOf(item({ cls: "Needs you", reason: "conflict", draft: "Rebase.", syncDraft: "Pull." }))).toEqual({ draft: "Rebase.", reason: "conflict" });
    expect(waitingOnYou([item({ cls: "In orbit", syncDraft: "Pull." })], doors)).toHaveLength(1);
  });
});
