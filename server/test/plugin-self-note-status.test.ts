/*
 * POST /plugin/self/pr/notes/status: a plugin closing its OWN finding when its
 * Re-check found the bug fixed. open -> resolved, nothing else; the person's
 * word outranks it; no echo event back to the plugin that asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunning } from "../src/plugins.ts"; // imported first: the cycle plugins.ts <-> plugin-ui.ts resolves only from this side
import {
  PLUGIN_STATUS_PER_HOUR, __setPluginNotesPath, dropNotesOf, notesFor, resolveOwnNote, setLivenessCheck, setNoteStatus, takeEvents, upsertNotes, answerNote,
} from "../src/plugin-ui.ts";
import type { Contributes } from "../../shared/pluginUi.ts";

const C = { prNotes: true } as Contributes;
const P = "acme-review", Q = "acme-lint", REPO = "acme/orbit";
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-self-status-")); __setPluginNotesPath(join(dir, "plugin-notes.json")); setLivenessCheck(() => true); });
afterAll(() => { __setPluginNotesPath(null); setLivenessCheck((n) => isRunning(n)); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { dropNotesOf(P); dropNotesOf(Q); });

const note = (id: string) => ({ id, repo: REPO, number: 1042, severity: "high", title: `finding ${id}`, path: "src/a.ts", line: 3 });
const mine = (id: string) => notesFor(REPO, 1042)!.notes.find((n) => n.plugin === P && n.id === id)!;

describe("a plugin resolves its own finding", () => {
  test("open -> resolved, tagged agent:<plugin> with when", () => {
    upsertNotes(P, C, [note("a")]);
    expect(resolveOwnNote(P, C, { id: "a", status: "resolved" }, 5_000)).toEqual({ ok: true, status: "resolved" });
    expect(mine("a")).toMatchObject({ status: "resolved", statusAgent: `agent:${P}`, statusAt: 5_000 });
  });
  test("asking twice is not an error and changes nothing", () => {
    upsertNotes(P, C, [note("a")]);
    resolveOwnNote(P, C, { id: "a", status: "resolved" }, 5_000);
    expect(resolveOwnNote(P, C, { id: "a", status: "resolved" }, 9_000)).toMatchObject({ ok: true, unchanged: true });
    expect(mine("a").statusAt).toBe(5_000);
  });
  test("only resolved: dismissed, open and junk are 400", () => {
    upsertNotes(P, C, [note("a")]);
    for (const status of ["dismissed", "open", "fixed", undefined]) expect(resolveOwnNote(P, C, { id: "a", status })).toMatchObject({ ok: false, status: 400 });
    expect(resolveOwnNote(P, C, { status: "resolved" })).toMatchObject({ ok: false, status: 400 });
    expect(mine("a").status).toBe("open");
  });
  test("another plugin's finding is a 404, and stays open", () => {
    upsertNotes(Q, C, [note("z")]);
    expect(resolveOwnNote(P, C, { id: "z", status: "resolved" })).toMatchObject({ ok: false, status: 404 });
    expect(notesFor(REPO, 1042)!.notes.find((n) => n.plugin === Q)!.status).toBe("open");
  });
  test("what the person set is never touched: 409 for dismissed, resolved and a reopened one", () => {
    upsertNotes(P, C, [note("a"), note("b"), note("c")]);
    setNoteStatus(P, "a", "dismissed");
    setNoteStatus(P, "b", "resolved");
    setNoteStatus(P, "c", "resolved"); setNoteStatus(P, "c", "open");
    for (const id of ["a", "b", "c"]) {
      const r = resolveOwnNote(P, C, { id, status: "resolved" });
      expect(r).toMatchObject({ ok: false, status: 409 });
      expect((r as { error: string }).error).toContain("the person set");
    }
    expect(mine("a").status).toBe("dismissed");
    expect(mine("b").statusAgent).toBeUndefined();
    expect(mine("c").status).toBe("open");
  });
  test("an agent answering for the person counts as the person", () => {
    upsertNotes(P, C, [note("a")]);
    answerNote(P, "a", { status: "dismissed", by: "agent:acme-bot" });
    expect(resolveOwnNote(P, C, { id: "a", status: "resolved" })).toMatchObject({ ok: false, status: 409 });
  });
  test("the person reopening clears the plugin's mark", () => {
    upsertNotes(P, C, [note("a")]);
    resolveOwnNote(P, C, { id: "a", status: "resolved" });
    setNoteStatus(P, "a", "open");
    expect(mine("a").statusAgent).toBeUndefined();
  });
  test("a finding already dismissed by the plugin's own earlier pass is 409, not reopened", () => {
    upsertNotes(P, C, [{ ...note("a"), status: "dismissed" }]);
    expect(resolveOwnNote(P, C, { id: "a", status: "resolved" })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("limits and echo", () => {
  test("60 an hour per plugin, then 429; the hour moves on", () => {
    upsertNotes(P, C, Array.from({ length: PLUGIN_STATUS_PER_HOUR + 2 }, (_, i) => note(`n${i}`)));
    for (let i = 0; i < PLUGIN_STATUS_PER_HOUR; i++) expect(resolveOwnNote(P, C, { id: `n${i}`, status: "resolved" }, 1_000 + i).ok).toBe(true);
    expect(resolveOwnNote(P, C, { id: "n60", status: "resolved" }, 2_000)).toMatchObject({ ok: false, status: 429 });
    expect(resolveOwnNote(P, C, { id: "n60", status: "resolved" }, 1_000 + 3_600_001)).toMatchObject({ ok: true });
  });
  test("the plugin is not told about its own change (no note-status event)", async () => {
    upsertNotes(P, C, [note("a")]);
    await takeEvents(P, 0);
    resolveOwnNote(P, C, { id: "a", status: "resolved" });
    expect(JSON.stringify(await takeEvents(P, 0))).not.toContain("note-status");
    // and the probe can see one when the person acts, so the absence above means something
    upsertNotes(P, C, [note("b")]);
    await takeEvents(P, 0);
    setNoteStatus(P, "b", "resolved");
    expect(JSON.stringify(await takeEvents(P, 0))).toContain("note-status");
  });
  test("a manifest without prNotes is refused", () => {
    expect(resolveOwnNote(P, {} as Contributes, { id: "a", status: "resolved" })).toMatchObject({ ok: false, status: 400 });
  });
});
