/*
 * The switch on each Sources-sheet row (mock 11) is the desk's own
 * `tasks.source.<id>` setting, reached through the settings door.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceSettingId, sourcesOn, switchReads } from "../src/model/sourceSwitch.ts";
import { openTaskSource } from "../src/model/tasksLanding.ts";
import { ISSUES_SOURCE, JIRA_SOURCE } from "../src/model/taskProviders.ts";

describe("which desk setting a row's switch writes", () => {
  test("each phone source maps to the desk's id", () => {
    expect(sourceSettingId(ISSUES_SOURCE)).toBe("tasks.source.github");
    expect(sourceSettingId(JIRA_SOURCE)).toBe("tasks.source.jira");
    expect(sourceSettingId({ id: "tracker", title: "ClickUp", provider: "clickup" })).toBe("tasks.source.clickup");
    expect(sourceSettingId({ id: "tracker", title: "Taskwarrior", provider: "taskwarrior" })).toBe("tasks.source.local");
  });
  test("a tracker the desk has no switch for draws none", () => {
    expect(sourceSettingId({ id: "tracker", title: "the tracker" })).toBeNull();
  });
});

describe("the sheet", () => {
  const src = readFileSync(new URL("../app/(tabs)/tasks.tsx", import.meta.url), "utf8");
  test("every row carries a Switch and a press writes through the door", () => {
    expect(src).toContain("<Switch on={on} />");
    expect(src).toContain("setSourceOn(host, id, !was)");
    expect(src).toContain("onPress={() => flip(s)}");
  });
});

describe("the selector offers only sources that are on", () => {
  const all = [ISSUES_SOURCE, JIRA_SOURCE];
  test("a switched-off source is hidden, unknown counts as on", () => {
    expect(sourcesOn(all, {})).toEqual(["issues", "jira"]);
    expect(sourcesOn(all, { "tasks.source.github": false })).toEqual(["jira"]);
  });
  test("the selected source switched off falls to the first one still on, or none", () => {
    const off = { "tasks.source.github": false };
    expect(openTaskSource({ available: sourcesOn(all, off), current: "issues", last: null, explicit: null })).toBe("jira");
    const none = { "tasks.source.github": false, "tasks.source.jira": false };
    expect(openTaskSource({ available: sourcesOn(all, none), current: "issues", last: null, explicit: null })).toBeNull();
  });
});

describe("a read does not undo a flip", () => {
  test("a read that started before a flip of the same key is dropped", () => {
    const r = switchReads();
    const land = r.begin("tasks.source.jira");
    r.flipped("tasks.source.jira");
    expect(land(true)).toBeNull();
  });
  test("a flip of another key does not drop it, and a later read lands", () => {
    const r = switchReads();
    const land = r.begin("tasks.source.jira");
    r.flipped("tasks.source.local");
    expect(land(false)).toBe(false);
    r.flipped("tasks.source.jira");
    expect(r.begin("tasks.source.jira")(true)).toBe(true);
  });
  test("a failed write put back counts as a flip, so an older read stays dropped", () => {
    const r = switchReads();
    const land = r.begin("k");
    r.flipped("k"); r.flipped("k");
    expect(land(true)).toBeNull();
  });
  test("a null read stays null; another computer drops reads in flight", () => {
    const r = switchReads();
    expect(r.begin("k")(null)).toBeNull();
    const land = r.begin("k");
    r.reset();
    expect(land(true)).toBeNull();
  });
  test("the origin change clears the switches and their error", () => {
    const src = readFileSync(new URL("../app/(tabs)/tasks.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/\[host\?\.origin\]/);
    expect(src).toMatch(/setSourceOnState\(\{\}\); setSwitchErr\(null\); reads\.reset\(\);\n  \}, \[host\?\.origin\]\)/);
  });
});
