/*
 * The empty "assigned to me" board says why it may be empty. ClickUp's assignee
 * filter leaves subtasks out, so for a team that works in them an empty board
 * is the setting, and the sentence offers it. Drawn only while it is true.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClickUpPrefs } from "../../shared/providers.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
let SubtasksNote: React.ComponentType<{ onChanged: () => void }>;
let saved: (p: ClickUpPrefs) => void;
const PANEL = "../src/components/TasksPanel.tsx";
const STORE = "../src/lib/clickupPrefs.ts";
beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  SubtasksNote = (await import(PANEL)).SubtasksNote;
  saved = (await import(STORE)).clickupPrefsSaved;
});

const prefs = (includeSubtasks: boolean): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none" },
  review: { enabled: false, statusNames: [], assignReviewer: false },
  merge: { enabled: false, statusNames: [] },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: ["assigned", "status", "mention", "comment"] },
});
const draw = () => renderToStaticMarkup(React.createElement(SubtasksNote, { onChanged: () => {} }));

describe("SubtasksNote", () => {
  test("off: says subtasks are not included and offers them", () => {
    saved(prefs(false));
    const html = draw();
    expect(html).toContain("Subtasks are not included.");
    expect(html).toContain("Include them");
  });
  test("on: says nothing", () => {
    saved(prefs(true));
    expect(draw()).toBe("");
  });
});
