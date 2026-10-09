/*
 * A comment and a custom field, as blocks of a step.
 *
 * Pinned: that a template is only posted when every placeholder in it could be filled (nothing says
 * "{author}" on somebody's board), that a field is found by name on THIS card's list and written the way
 * ClickUp wants it (an option by its id on this list, a date as a number), that a read-only field or a
 * kind this cannot write is skipped with a reason and never sent, that asking replaces the template and
 * the setting's value, and that a press costs the card's one write plus one request per field and per
 * comment, in that order, stopping at the first that fails.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListField, StepBlock } from "../../shared/providers.ts";
import { PLACEHOLDERS, fillTemplate, hasExtras, planOf } from "../../shared/stepBlocks.ts";
import { extrasOf, fieldIsWritable, prContext, resolveComment, resolveField, runExtras } from "../src/lib/stepExtras.ts";
import { blocksSentence } from "../src/lib/stepBlocksView.ts";
import { AskedExtras } from "../src/components/AskedExtras.tsx";

const squad: ListField = { id: "f-squad", name: "Squad", type: "drop_down", readOnly: false, options: [{ id: "o-plat", name: "Platform" }, { id: "o-grow", name: "Growth" }] };
const FIELDS: ListField[] = [
  squad,
  { id: "f-labels", name: "Areas", type: "labels", readOnly: false, options: [{ id: "l-api", name: "API" }, { id: "l-ui", name: "UI" }] },
  { id: "f-pts", name: "Estimate", type: "number", readOnly: false },
  { id: "f-due", name: "Review by", type: "date", readOnly: false },
  { id: "f-note", name: "Release note", type: "short_text", readOnly: false },
  { id: "f-budget", name: "Budget (DO NOT EDIT)", type: "number", readOnly: true },
  { id: "f-who", name: "Reviewer", type: "users", readOnly: false },
];
const CTX = prContext({ pr: { number: 318, title: "Retry the webhook", url: "https://example.test/pr/318" }, author: { login: "srivera", name: "Sam Rivera" }, status: "ready for qa", me: "Ada Test" });

describe("the template", () => {
  test("every placeholder is filled from what the place knows", () => {
    expect(PLACEHOLDERS).toEqual(["pr", "pr_url", "author", "status", "me"]);
    expect(fillTemplate("{pr} by {author} is {status}: {pr_url} — {me}", CTX)).toEqual({ text: "#318 Retry the webhook by Sam Rivera is ready for qa: https://example.test/pr/318 — Ada Test", missing: [] });
  });
  test("one that cannot be filled stays as written and is named; an unknown one is left alone", () => {
    expect(fillTemplate("{author} {status} {nope}", { status: "done" })).toEqual({ text: "{author} done {nope}", missing: ["author"] });
  });
  test("a fixed comment with a gap is not posted, and says why; a whole one is", () => {
    expect(resolveComment("{pr} {author}", prContext({ pr: { number: 1, title: "t" } }))).toEqual({ skip: "the comment names {author}, which is not known here" });
    expect(resolveComment("   ", CTX)).toEqual({ skip: "the comment is empty" });
    expect(resolveComment("Merged {pr}", CTX)).toEqual({ item: { kind: "comment", text: "Merged #318 Retry the webhook" } });
  });
});

describe("a field, found on this card's list", () => {
  test("a drop-down: the option's name becomes this list's option id", () => {
    expect(resolveField(FIELDS, { field: " squad ", value: "growth" })).toEqual({ item: { kind: "field", fieldId: "f-squad", fieldKind: "drop_down", name: "Squad", shown: "growth", value: "o-grow" } });
  });
  test("labels: several names, one id each; a number; a date as milliseconds; text as it is", () => {
    expect((resolveField(FIELDS, { field: "Areas", value: "API, ui" }) as { item: { value: string } }).item.value).toBe("l-api,l-ui");
    expect((resolveField(FIELDS, { field: "Estimate", value: "3.5" }) as { item: { value: string } }).item.value).toBe("3.5");
    expect((resolveField(FIELDS, { field: "Review by", value: "2026-10-31" }) as { item: { value: string } }).item.value).toBe(String(Date.parse("2026-10-31T00:00:00")));
    expect((resolveField(FIELDS, { field: "Release note", value: "  fixes the retry " }) as { item: { value: string } }).item.value).toBe("fixes the retry");
  });
  test("what cannot be written is skipped with the reason, and never sent", () => {
    expect(resolveField(FIELDS, { field: "Nope", value: "a" })).toEqual({ skip: "“Nope” is not a field of this card's list" });
    expect(resolveField(FIELDS, { field: "Budget (DO NOT EDIT)", value: "1" })).toEqual({ skip: "“Budget (DO NOT EDIT)” is marked read-only" });
    expect(resolveField(FIELDS, { field: "Reviewer", value: "Sam" })).toEqual({ skip: "“Reviewer” is a users field, which this cannot write" });
    expect(resolveField(FIELDS, { field: "Squad", value: "Mystery" })).toEqual({ skip: "“Squad” has no option “Mystery” here" });
    expect(resolveField(FIELDS, { field: "Areas", value: "API, Mystery" })).toEqual({ skip: "“Areas” has no option “Mystery” here" });
    expect(resolveField(FIELDS, { field: "Estimate", value: "lots" })).toEqual({ skip: "“lots” is not a number" });
    expect(resolveField(FIELDS, { field: "Review by", value: "soon" })).toEqual({ skip: "“soon” is not a date (write it as 2026-10-31)" });
    expect(resolveField(FIELDS, { field: "Squad", value: " " })).toEqual({ skip: "“Squad” has no value to set" });
    expect(resolveField(null, { field: "Squad", value: "Platform" })).toEqual({ skip: "“Squad” is not a field of this card's list" });
  });
  test("the read-only pattern the server applied is honoured, and only kinds this writes are offered", () => {
    expect(FIELDS.filter(fieldIsWritable).map((f) => f.name)).toEqual(["Squad", "Areas", "Estimate", "Review by", "Release note"]);
  });
});

describe("what a step does here", () => {
  const blocks: StepBlock[] = [{ type: "comment", text: "Merged {pr}", ask: true }, { type: "field", field: "Squad", value: "Platform", ask: true }, { type: "move", statusNames: ["done"] }];
  test("the field first, then the comment: the comment may name the status the card is in by then", () => {
    const r = extrasOf(blocks, { fields: FIELDS, ctx: CTX });
    expect(r.map((x) => ("item" in x ? x.item.kind : "skip"))).toEqual(["field", "comment"]);
  });
  test("asking replaces the template and the setting's value with what the person typed", () => {
    const r = extrasOf(blocks, { fields: FIELDS, ctx: CTX, commentText: "Shipped, thanks", fieldValue: "Growth" });
    expect(r).toEqual([
      { item: { kind: "field", fieldId: "f-squad", fieldKind: "drop_down", name: "Squad", shown: "Growth", value: "o-grow" } },
      { item: { kind: "comment", text: "Shipped, thanks" } },
    ]);
    expect(extrasOf(blocks, { fields: FIELDS, ctx: CTX, commentText: "  " })[1]).toEqual({ skip: "the comment is empty" });
  });
  test("the plan carries both, and a step with either is a step that does something", () => {
    const p = planOf("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks });
    expect(p.comment).toEqual({ text: "Merged {pr}", ask: true });
    expect(p.field).toEqual({ field: "Squad", value: "Platform", ask: true });
    expect(hasExtras(p)).toBe(true);
    expect(hasExtras(planOf("move", { enabled: true, statusNames: ["x"], assign: { who: "none" } }))).toBe(false);
  });
  test("the sentence says what it will do, and where it asks, where it starts", () => {
    const say = (b: StepBlock[]) => blocksSentence({ lead: "Press it:", trigger: "move", blocks: b, item: "card", status: null });
    expect(say([{ type: "comment", text: "Ready for QA" }, { type: "field", field: "Squad", value: "Platform" }])).toBe("Press it: comment “Ready for QA”, then set Squad to Platform.");
    expect(say(blocks.slice(0, 2))).toBe("Press it: ask what to comment on the card, starting from “Merged {pr}”, then ask for Squad, starting at Platform.");
  });
});

describe("what a press costs", () => {
  const items = [
    { kind: "comment" as const, text: "hello" },
    { kind: "field" as const, fieldId: "f-squad", fieldKind: "drop_down", name: "Squad", shown: "Growth", value: "o-grow" },
    { kind: "field" as const, fieldId: "f-pts", fieldKind: "number", name: "Estimate", shown: "3", value: "3" },
  ];
  const io = (log: string[], failOn?: string) => ({
    field: async (id: string, v: string, k: string) => { log.push(`field ${id}=${v} (${k})`); return id === failOn ? { ok: false, error: "refused" } : { ok: true }; },
    comment: async (t: string) => { log.push(`comment ${t}`); return failOn === "comment" ? { ok: false, error: "refused" } : { ok: true }; },
  });
  test("one request per field and per comment, the fields first", async () => {
    const log: string[] = [];
    const r = await runExtras(items, io(log));
    expect(log).toEqual(["field f-squad=o-grow (drop_down)", "field f-pts=3 (number)", "comment hello"]);
    expect(r).toEqual({ ok: true, done: ["Squad → Growth", "Estimate → 3", "commented"] });
  });
  test("it stops at the first that fails and says which; what was done stays said", async () => {
    const log: string[] = [];
    const r = await runExtras(items, io(log, "f-pts"));
    expect(log.length).toBe(2);
    expect(r).toEqual({ ok: false, done: ["Squad → Growth"], error: "setting Estimate: refused" });
  });
  test("nothing to send is no request at all", async () => {
    const log: string[] = [];
    expect(await runExtras([], io(log))).toEqual({ ok: true, done: [] });
    expect(log).toEqual([]);
  });
  test("the card's own write stays one, and the extras follow it in every place that runs a step", async () => {
    const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
    const panel = await read("components/PrPanel.tsx");
    const at = panel.indexOf("function CardReadyForQaButton(");
    const body = panel.slice(at, panel.indexOf("\nfunction ", at + 10));
    expect(body.match(/api\.clickupCard\(/g)?.length).toBe(1);
    expect(body.indexOf("api.clickupCard(")).toBeLessThan(body.indexOf("sendExtras(task.id, extraItems)"));
    expect(panel).toContain("const sendMergeExtras = async () =>");
    expect(panel).toContain("const ex = r.ok && menuExtras.length ? await sendExtras(card.id, menuExtras) : null;");
  });
  test("the writes are the ones behind 'Changes in ClickUp': the routes refuse when it is off", async () => {
    const src = await Bun.file(new URL("../../server/src/clickup.ts", import.meta.url).pathname).text();
    const f = src.slice(src.indexOf("export async function setField("), src.indexOf("export async function clearField("));
    expect(f).toContain("const no = writable();");
    const c = src.slice(src.indexOf("export async function commentOn("), src.indexOf("export async function commentOn(") + 600);
    expect(c).toContain("clickupWriteEnabled()");
  });
});

describe("the rows use the app's own pickers", () => {
  test("a drop-down is the app's Select; there is no new picker", async () => {
    const rows = await Bun.file(new URL("../src/components/StepExtraRows.tsx", import.meta.url).pathname).text();
    const asked = await Bun.file(new URL("../src/components/AskedExtras.tsx", import.meta.url).pathname).text();
    expect(rows).toContain('import { Select } from "./Select.tsx";');
    expect(asked).toContain('import { Select } from "./Select.tsx";');
  });
  test("a fixed comment and field read as lines; an asked one is the control", () => {
    const html = (blocks: StepBlock[], ctx = CTX) => renderToStaticMarkup(React.createElement(AskedExtras, { blocks, fields: FIELDS, ctx, onChange: () => {} }));
    const fixed = html([{ type: "comment", text: "Merged {pr}" }, { type: "field", field: "Squad", value: "Platform" }]);
    expect(fixed).toContain("“Merged #318 Retry the webhook”");
    expect(fixed).toContain("set to <b>Platform</b>");
    expect(fixed).not.toContain("<textarea");
    const asked = html([{ type: "comment", text: "Merged {pr}", ask: true }]);
    expect(asked).toContain("<textarea");
    expect(asked).toContain("Merged #318 Retry the webhook");
    expect(html([{ type: "comment", text: "{author}" }], {})).toContain("Not done:");
  });
});
