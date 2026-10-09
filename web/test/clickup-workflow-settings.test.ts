/*
 * The Workflow block under the ClickUp row, drawn.
 *
 * Under `bun test` there is no DOM, so this is the first paint with the
 * settings handed in. What is pinned: the hand-off starts off on a fresh
 * workspace, the two rows below the switch are present (dim, not gone) in
 * either state so turning it on moves nothing, and the saved values are what
 * the rows show.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClickUpPrefs } from "../../shared/providers.ts";
import { globalStubs } from "./stubGlobal.ts";

/* The settings dialog's import chain reads localStorage at load, and there is
   none under bun: stub it, then import. */
const stubGlobal = globalStubs();
let ClickUpWorkflow: React.ComponentType<{ initial: ClickUpPrefs }>;
/* A path in a variable, so the test project's typecheck does not pull the whole
   dialog (and its Vite-only imports) into a tsconfig that has no Vite types. */
const DIALOG = "../src/components/SettingsModal.tsx";
beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ClickUpWorkflow = (await import(DIALOG)).ClickUpWorkflow;
});

const prefs = (handoff: Partial<ClickUpPrefs["handoff"]>): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none", ...handoff },
  review: { statusNames: [], assignReviewer: false },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks: false },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: ["assigned", "status", "mention", "comment"] },
});
const draw = (p: ClickUpPrefs) => renderToStaticMarkup(React.createElement(ClickUpWorkflow, { initial: p }));

describe("ClickUpWorkflow", () => {
  test("off: the switch is off and the other rows are there, disabled", () => {
    const html = draw(prefs({}));
    expect(html).toContain("Workflow");
    expect(html).toContain("Hand off to QA");
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("QA status names");
    expect(html).toContain("Take off the card");
    expect(html).toContain("disabled");
  });
  test("on: the switch is on and the saved names and policy are shown", () => {
    const html = draw(prefs({ enabled: true, statusNames: ["Testing", "QA"], unassign: "me" }));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="Testing, QA"');
    expect(html).toContain("Only me");
  });
  test("the same rows exist in both states, so nothing moves when it is switched", () => {
    const rows = (h: string) => [...h.matchAll(/QA status names|Take off the card|Hand off to QA/g)].map((m) => m[0]);
    expect(rows(draw(prefs({})))).toEqual(rows(draw(prefs({ enabled: true }))));
  });
  test("review and note rows are present, off on a fresh workspace, and show saved names", () => {
    const fresh = draw(prefs({}));
    for (const t of ["Review status names", "Put people on the card from the review menu", "Note on card"]) expect(fresh).toContain(t);
    expect(fresh.match(/aria-checked="false"/g)?.length).toBe(4);
    const set = draw({ ...prefs({}), review: { statusNames: ["PR up", "Code Review"], assignReviewer: true }, flows: { noteOnCard: true } });
    expect(set).toContain('value="PR up, Code Review"');
    expect(set.match(/aria-checked="true"/g)?.length).toBe(2);
  });
  test("saves one key at a time, through the prefs route", async () => {
    const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname).text();
    const at = src.indexOf("export function ClickUpWorkflow(");
    const body = src.slice(at, src.indexOf("\nfunction ProviderCard(", at));
    expect(body.match(/api\.clickupSetPrefs\(patch\)/g)?.length).toBe(1);
    for (const k of ["save({ enabled:", "save({ statusNames:", "save({ unassign:", "send({ review: { statusNames:", "send({ review: { assignReviewer:", "send({ flows: { noteOnCard:"]) expect(body).toContain(k);
  });
});

describe("ClickUpWorkflow: names on your boards", () => {
  const base = () => prefs({});
  test("the six rows are there on a fresh workspace, empty, with the shipped guess as the placeholder", () => {
    const html = draw(base());
    for (const t of ["PR link field", "Colour column field", "Card skills pattern", "Sprint list pattern", "Read-only fields pattern", "Subtasks on Assigned to me"]) {
      expect(html).toContain(t);
    }
    expect(html).toContain('placeholder="^sprint\\b"');
    expect(html).toContain('placeholder="do not edit"');
  });
  test("saved names are what the boxes show; a pattern equal to the shipped one shows as empty", () => {
    const p = { ...base(), prLinkField: "Review link", swatchField: "Pod", sprintListPattern: "^iteration\\b", readOnlyFieldPattern: "do not edit" };
    const html = draw(p);
    expect(html).toContain('value="Review link"');
    expect(html).toContain('value="Pod"');
    expect(html).toContain('value="^iteration\\b"');
    expect(html).not.toContain('value="do not edit"');
  });
  test("the subtasks switch shows the saved state", () => {
    const on = draw({ ...base(), assigned: { includeSubtasks: true } });
    expect(on.match(/aria-checked="true"/g)?.length).toBe(1);
  });
});

const dialogSource = await Bun.file(new URL(DIALOG, import.meta.url)).text();

describe("disconnecting ClickUp", () => {
  test("drops the copies the pull request sidebar holds, or it draws a card for a minute after", () => {
    const src = dialogSource;
    const at = src.indexOf("api.providerDisconnect(spec.id, { forgetBoards })");
    expect(at, "the confirmed disconnect moved").toBeGreaterThan(-1);
    const gone = src.slice(at, src.indexOf("onChanged()", at));
    expect(gone).toContain("__forgetClickupSetup(); __forgetClickupPrefs(); forgetCards();");
  });
});
