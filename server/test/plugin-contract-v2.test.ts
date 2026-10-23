/*
 * Review-plugin contract v2, the app's side: a run's cost and its wait for an
 * OK, a finding's agreement and authors, a plugin answering a thread, and the
 * buttons a plugin adds to its findings. Every new field is optional, so the
 * first block says old payloads still go in unchanged; the rest say each new
 * one is bounded and that the event a plugin hears has the documented shape.
 * Nothing here can reach GitHub: the guard tests read the source for it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunning, manifestHash, validateManifest, type PluginManifest } from "../src/plugins.ts"; // imported first: the cycle plugins.ts <-> plugin-ui.ts resolves only from this side
import {
  PLUGIN_REPLIES_PER_HOUR, __resetPluginUi, __setPluginNotesPath, costByDay, decideRun, notesFor, pressNoteAction, replyAsPlugin,
  setLivenessCheck, takeEvents, upsertNotes, upsertRun,
} from "../src/plugin-ui.ts";
import { REPLIES_PER_NOTE, REPLY_MAX_CHARS, validateContributes, validateNote, validateRun, type Contributes } from "../../shared/pluginUi.ts";

const P = "acme-review";
const REPO = "acme/orbit";
const C: Contributes = { prNotes: true, noteActions: [{ id: "fix", label: "Fix" }, { id: "ask", label: "Ask" }] };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-contract-v2-"));
  setLivenessCheck(() => true);
});
afterAll(() => {
  __setPluginNotesPath(null);
  setLivenessCheck((name) => isRunning(name));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  __setPluginNotesPath(join(dir, `notes-${Math.random().toString(36).slice(2)}.json`));
  __resetPluginUi();
  await takeEvents(P, 0);
});

const run = (extra: Record<string, unknown> = {}) => ({ id: "run-1", repo: REPO, number: 1042, state: "running", title: "Local review", ...extra });
const note = (extra: Record<string, unknown> = {}) => ({ id: "f-1", repo: REPO, number: 1042, severity: "high", title: "Guard runs after the loop", ...extra });
const storedRun = (id = "run-1") => notesFor(REPO, 1042)!.runs.find((r) => r.id === id)!;
const storedNote = (id = "f-1") => notesFor(REPO, 1042)!.notes.find((n) => n.id === id)!;

describe("old payloads", () => {
  test("a run and a note without any new field are accepted and carry none", () => {
    expect(upsertRun(P, C, run()).ok).toBe(true);
    expect(upsertNotes(P, C, [note()]).ok).toBe(true);
    const r = storedRun();
    expect(r.costUsd).toBeUndefined();
    expect(r.decision).toBeUndefined();
    const n = storedNote();
    expect(n.agreement).toBeUndefined();
    expect(n.by).toBeUndefined();
  });
  test("fields this app does not know are ignored, not refused", () => {
    expect(upsertRun(P, C, run({ somethingNew: { a: 1 } })).ok).toBe(true);
    expect(upsertNotes(P, C, [note({ somethingNew: 7 })]).ok).toBe(true);
    expect("somethingNew" in storedRun()).toBe(false);
    expect("somethingNew" in storedNote()).toBe(false);
  });
  test("the old states still validate", () => {
    for (const state of ["queued", "running", "done", "failed", "cancelled"]) expect(validateRun(run({ state })).ok).toBe(true);
  });
});

describe("run: costUsd and needs-ok", () => {
  test("a cost is kept to four decimals", () => {
    expect(upsertRun(P, C, run({ costUsd: 0.123456 })).ok).toBe(true);
    expect(storedRun().costUsd).toBe(0.1235);
  });
  test("the bounds are 0 and 1000, both inclusive", () => {
    expect(validateRun(run({ costUsd: 0 })).ok).toBe(true);
    expect(validateRun(run({ costUsd: 1000 })).ok).toBe(true);
    for (const costUsd of [-0.0001, 1000.0001]) {
      const r = validateRun(run({ costUsd }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("run.costUsd must be between 0 and 1000");
    }
  });
  test("a cost that is not a number is refused, with its own sentence", () => {
    for (const costUsd of ["0.42", null, NaN, Infinity, {}, [1]]) {
      const r = validateRun(run({ costUsd }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("run.costUsd must be a number");
    }
  });
  test("needs-ok is a state, and the error for a bad one lists it", () => {
    expect(validateRun(run({ state: "needs-ok" })).ok).toBe(true);
    const r = validateRun(run({ state: "waiting" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("run.state must be queued, running, needs-ok, done, failed or cancelled");
  });
  test("a plugin cannot send the person's decision", () => {
    expect(upsertRun(P, C, run({ state: "needs-ok", decision: "approve" })).ok).toBe(true);
    expect(storedRun().decision).toBeUndefined();
  });
});

describe("run decision: Approve run and Skip", () => {
  const waiting = () => expect(upsertRun(P, C, run({ state: "needs-ok", costUsd: 0.42 })).ok).toBe(true);

  test("approve tells the plugin, with the documented shape", async () => {
    waiting();
    const before = Date.now();
    expect(decideRun(P, "run-1", "approve")).toEqual({ ok: true });
    const ev = await takeEvents(P, 0);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "run-approve", id: "run-1", repo: REPO, number: 1042 });
    expect((ev[0] as { at: number }).at).toBeGreaterThanOrEqual(before);
    expect(Object.keys(ev[0]!).sort()).toEqual(["at", "id", "number", "repo", "type"]);
    expect(storedRun().decision).toBe("approve");
  });
  test("skip tells the plugin run-skip", async () => {
    waiting();
    expect(decideRun(P, "run-1", "skip").ok).toBe(true);
    expect((await takeEvents(P, 0))[0]).toMatchObject({ type: "run-skip", id: "run-1" });
  });
  test("a second press sends no second event", async () => {
    waiting();
    decideRun(P, "run-1", "approve");
    await takeEvents(P, 0);
    const again = decideRun(P, "run-1", "skip");
    expect(again).toEqual({ ok: false, error: "already answered: approve" });
    expect(await takeEvents(P, 0)).toEqual([]);
  });
  test("only a run that is waiting can be answered", async () => {
    expect(upsertRun(P, C, run({ state: "running" })).ok).toBe(true);
    expect(decideRun(P, "run-1", "approve")).toEqual({ ok: false, error: "that run is not waiting for an OK" });
    expect(decideRun(P, "nope", "approve")).toEqual({ ok: false, error: "no such run" });
    expect(decideRun(P, "run-1", "maybe")).toEqual({ ok: false, error: "decision must be approve or skip" });
    expect(await takeEvents(P, 0)).toEqual([]);
  });
  test("the answer survives the plugin repeating needs-ok and goes when the run moves on", () => {
    waiting();
    decideRun(P, "run-1", "approve");
    upsertRun(P, C, run({ state: "needs-ok", costUsd: 0.5 }));
    expect(storedRun().decision).toBe("approve");
    upsertRun(P, C, run({ state: "running", costUsd: 0.5 }));
    expect(storedRun().decision).toBeUndefined();
  });
  test("another plugin's run is not reachable", () => {
    waiting();
    expect(decideRun("other-plugin", "run-1", "approve")).toEqual({ ok: false, error: "no such run" });
  });
});

describe("cost per plugin per day", () => {
  const T = Date.UTC(2026, 9, 17, 10);
  test("sums the runs of a day, counting a run once however often its cost is repeated", () => {
    upsertRun(P, C, run({ id: "a", costUsd: 0.1, startedAt: T }));
    upsertRun(P, C, run({ id: "a", costUsd: 0.25, startedAt: T }));
    upsertRun(P, C, run({ id: "b", costUsd: 0.5, startedAt: T + 1000 }));
    const r = costByDay(P);
    expect(r).toEqual({ ok: true, days: [{ plugin: P, day: "2026-10-17", usd: 0.75, runs: 2 }] });
  });
  test("separates days and plugins, newest first, and filters by plugin", () => {
    const today = Date.now();
    upsertRun(P, C, run({ id: "a", costUsd: 1, startedAt: today }));
    upsertRun(P, C, run({ id: "b", costUsd: 2, startedAt: today - 86_400_000 }));
    upsertRun("acme-lint", C, run({ id: "c", costUsd: 4, startedAt: today }));
    const all = costByDay();
    expect(all.ok && all.days.map((d) => `${d.plugin}:${d.usd}`)).toEqual([`acme-lint:4`, `${P}:1`, `${P}:2`]);
    const mine = costByDay(P);
    expect(mine.ok && mine.days).toHaveLength(2);
  });
  test("a run with no cost adds nothing; days is bounded", () => {
    upsertRun(P, C, run({ id: "a" }));
    expect(costByDay(P)).toEqual({ ok: true, days: [] });
    for (const days of ["0", "91", "1.5", "abc"]) expect(costByDay(P, days).ok).toBe(false);
    expect(costByDay(P, "90").ok).toBe(true);
    expect(costByDay("../etc").ok).toBe(false);
  });
  test("the window excludes older days", () => {
    upsertRun(P, C, run({ id: "old", costUsd: 3, startedAt: Date.now() - 10 * 86_400_000 }));
    const r = costByDay(P, "5");
    expect(r.ok && r.days).toEqual([]);
    const r2 = costByDay(P, "30");
    expect(r2.ok && r2.days).toHaveLength(1);
  });
});

describe("note: agreement and by", () => {
  test("both are stored", () => {
    expect(upsertNotes(P, C, [note({ agreement: { k: 2, n: 3 }, by: ["claude", "codex"] })]).ok).toBe(true);
    expect(storedNote().agreement).toEqual({ k: 2, n: 3 });
    expect(storedNote().by).toEqual(["claude", "codex"]);
  });
  test("agreement: whole numbers, 0 <= k <= n, 1 <= n <= 20", () => {
    for (const a of [{ k: 0, n: 1 }, { k: 20, n: 20 }, { k: 0, n: 5 }]) expect(validateNote(note({ agreement: a })).ok).toBe(true);
    const bad: unknown[] = [{ k: 4, n: 3 }, { k: -1, n: 3 }, { k: 1, n: 0 }, { k: 1, n: 21 }, { k: 1.5, n: 3 }, { k: "1", n: 3 }, { n: 3 }, [], "2/3", null];
    for (const agreement of bad) {
      const r = validateNote(note({ agreement }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toStartWith("note.agreement");
    }
  });
  test("by: at most five short strings", () => {
    expect(validateNote(note({ by: ["a", "b", "c", "d", "e"] })).ok).toBe(true);
    const six = validateNote(note({ by: ["a", "b", "c", "d", "e", "f"] }));
    expect(six.ok).toBe(false);
    if (!six.ok) expect(six.error).toBe("note.by holds at most 5 names");
    for (const by of ["claude", [1], [""], ["x".repeat(41)], [null]]) {
      const r = validateNote(note({ by }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toStartWith("note.by");
    }
  });
  test("by is cleaned like other note text and has no repeats", () => {
    const r = validateNote(note({ by: ["<b>claude</b>", "claude", "co\u0000dex\n", "a   b"] }));
    expect(r.ok && r.value.by).toEqual(["claude", "codex", "a b"]);
  });
  test("a tag that removing another tag puts together is removed too", () => {
    const r = validateNote(note({ by: ["<<b>script>orbit</<b>script>", "<<i>i>bot"] }));
    expect(r.ok && r.value.by).toEqual(["orbit", "bot"]);
  });
  test("an empty by is left out", () => {
    const r = validateNote(note({ by: [] }));
    expect(r.ok && r.value.by).toBeUndefined();
  });
  test("one bad note refuses the batch, and stores none of it", () => {
    const r = upsertNotes(P, C, [note({ id: "ok-1" }), note({ id: "bad", agreement: { k: 9, n: 3 } })]);
    expect(r.ok).toBe(false);
    expect(notesFor(REPO, 1042)!.notes).toHaveLength(0);
  });
});

describe("plugin reply route", () => {
  const seed = () => expect(upsertNotes(P, C, [note()]).ok).toBe(true);

  test("stored as agent:<plugin>, told to nobody, answered with the thread", async () => {
    seed();
    const r = await replyAsPlugin(P, C, { id: "f-1", text: "The guard moved above the loop in 3f9a2c1." });
    expect(r.ok).toBe(true);
    const t = storedNote().replies!;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ by: `agent:${P}`, text: "The guard moved above the loop in 3f9a2c1." });
    expect(r.ok && r.replies).toEqual(t);
    expect(await takeEvents(P, 0)).toEqual([]);
  });
  test("the person's status is not touched", async () => {
    seed();
    await replyAsPlugin(P, C, { id: "f-1", text: "hi" });
    expect(storedNote().status).toBe("open");
    expect(storedNote().statusBy).toBe("plugin");
  });
  test("an unknown finding is a 404; a body that is not {id, text} is a 400", async () => {
    seed();
    expect(await replyAsPlugin(P, C, { id: "nope", text: "x" })).toEqual({ ok: false, status: 404, error: "no such note" });
    expect(await replyAsPlugin("someone-else", C, { id: "f-1", text: "x" })).toMatchObject({ ok: false, status: 404 });
    expect(await replyAsPlugin(P, C, null)).toMatchObject({ ok: false, status: 400 });
    expect(await replyAsPlugin(P, C, { text: "x" })).toMatchObject({ ok: false, status: 400, error: "id is required" });
    expect(await replyAsPlugin(P, C, { id: "f-1" })).toMatchObject({ ok: false, status: 400, error: "text must be a string" });
    expect(await replyAsPlugin(P, C, { id: "f-1", text: " \n " })).toMatchObject({ ok: false, status: 400, error: "text is empty" });
    expect(await replyAsPlugin(P, { prNotes: false }, { id: "f-1", text: "x" })).toMatchObject({ ok: false, status: 400 });
  });
  test("a person's length cap applies", async () => {
    seed();
    expect((await replyAsPlugin(P, C, { id: "f-1", text: "x".repeat(REPLY_MAX_CHARS) })).ok).toBe(true);
    const over = await replyAsPlugin(P, C, { id: "f-1", text: "x".repeat(REPLY_MAX_CHARS + 1) });
    expect(over).toEqual({ ok: false, status: 400, error: `text is over ${REPLY_MAX_CHARS} characters` });
  });
  test("fifty replies a finding, then a clear refusal", async () => {
    seed();
    // The hourly cap is lower than 50; spread the replies over many hours.
    const t0 = Date.now() - 100 * 3_600_000;
    for (let i = 0; i < REPLIES_PER_NOTE; i++) expect((await replyAsPlugin(P, C, { id: "f-1", text: `r${i}` }, t0 + i * 3_600_000)).ok).toBe(true);
    expect(await replyAsPlugin(P, C, { id: "f-1", text: "one more" }, Date.now())).toEqual({ ok: false, status: 400, error: `a finding keeps at most ${REPLIES_PER_NOTE} replies` });
  });
  test("thirty an hour per plugin, then a 429 that says so; the hour passes", async () => {
    seed();
    expect(upsertNotes(P, C, [note({ id: "f-2" })]).ok).toBe(true);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < PLUGIN_REPLIES_PER_HOUR; i++) expect((await replyAsPlugin(P, C, { id: i % 2 ? "f-1" : "f-2", text: `r${i}` }, t0 + i)).ok).toBe(true);
    const r = await replyAsPlugin(P, C, { id: "f-1", text: "too many" }, t0 + 1000);
    expect(r).toEqual({ ok: false, status: 429, error: "at most 30 replies an hour per plugin; try again later" });
    expect(storedNote("f-1").replies!.some((x) => x.text === "too many")).toBe(false);
    expect((await replyAsPlugin(P, C, { id: "f-1", text: "later" }, t0 + 3_600_001)).ok).toBe(true);
  });
  test("the cap is per plugin", async () => {
    seed();
    expect(upsertNotes("acme-lint", C, [note({ id: "g-1" })]).ok).toBe(true);
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < PLUGIN_REPLIES_PER_HOUR; i++) await replyAsPlugin(P, C, { id: "f-1", text: `r${i}` }, t0 + i);
    expect((await replyAsPlugin("acme-lint", C, { id: "g-1", text: "mine" }, t0 + 5)).ok).toBe(true);
  });
  test("postToGitHub in the body is ignored: the reply is local and says so", async () => {
    seed();
    await replyAsPlugin(P, C, { id: "f-1", text: "x", postToGitHub: true, reply: { postToGitHub: true } });
    expect(storedNote().replies![0]).not.toHaveProperty("postedOnGitHub");
  });
  test("a plugin sending the finding again keeps the thread", async () => {
    seed();
    await replyAsPlugin(P, C, { id: "f-1", text: "x" });
    upsertNotes(P, C, [note({ title: "Guard runs after the loop (again)" })]);
    expect(storedNote().replies).toHaveLength(1);
  });
});

describe("finding actions", () => {
  const seed = () => expect(upsertNotes(P, C, [note()]).ok).toBe(true);

  test("a declared action tells the plugin which finding, with the documented shape", async () => {
    seed();
    expect(pressNoteAction(P, C, "fix", "f-1")).toEqual({ ok: true });
    const ev = await takeEvents(P, 0);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "note-action", id: "fix", noteId: "f-1", repo: REPO, number: 1042 });
    expect(Object.keys(ev[0]!).sort()).toEqual(["at", "id", "noteId", "number", "repo", "type"]);
  });
  test("an undeclared action, an unknown or foreign finding are refused", async () => {
    seed();
    expect(pressNoteAction(P, C, "explode", "f-1")).toEqual({ ok: false, error: "that plugin declares no such finding action" });
    expect(pressNoteAction(P, { prNotes: true }, "fix", "f-1")).toMatchObject({ ok: false });
    expect(pressNoteAction(P, C, "fix", "nope")).toEqual({ ok: false, error: "no such note" });
    expect(pressNoteAction("someone-else", C, "fix", "f-1")).toEqual({ ok: false, error: "no such note" });
    expect(pressNoteAction(P, C, "fix", 7)).toMatchObject({ ok: false });
    expect(await takeEvents(P, 0)).toEqual([]);
  });
});

describe("manifest contributes.noteActions", () => {
  const v = (noteActions: unknown) => validateContributes({ noteActions });
  test("up to four, id and label, label trimmed", () => {
    const r = v([{ id: "fix", label: "  Fix  " }, { id: "ask", label: "x".repeat(24) }]);
    expect(r.ok && r.value.noteActions).toEqual([{ id: "fix", label: "Fix" }, { id: "ask", label: "x".repeat(24) }]);
    expect(v(Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, label: "Go" }))).ok).toBe(true);
  });
  test("refusals say which rule", () => {
    const err = (x: unknown) => { const r = v(x); return r.ok ? null : r.error; };
    expect(err(Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: "Go" })))).toBe("contributes.noteActions must be a list of at most 4");
    expect(err({ id: "a", label: "A" })).toBe("contributes.noteActions must be a list of at most 4");
    expect(err([{ id: "a", label: "x".repeat(25) }])).toBe("finding action label must be 1-24 characters");
    expect(err([{ id: "a", label: "   " }])).toBe("finding action label must be 1-24 characters");
    expect(err([{ id: "Fix", label: "Fix" }])).toBe("finding action id must be 1-40 of a-z, 0-9, - and start with a letter");
    expect(err([{ id: "a", label: "A" }, { id: "a", label: "B" }])).toBe('finding action id "a" appears twice');
    expect(err(["fix"])).toBe("a finding action must be an object");
  });
  test("a manifest without it is unchanged", () => {
    const r = validateContributes({ prNotes: true });
    expect(r.ok && "noteActions" in r.value).toBe(false);
  });
});

describe("approval", () => {
  const base = { name: "acme-review", publisher: "acme", description: "d", entrypoint: "true", scope: "read", contributes: { prNotes: true } };

  test("adding finding buttons changes what was approved, so the person is asked again", () => {
    const before = validateManifest(base) as PluginManifest;
    const after = validateManifest({ ...base, contributes: { prNotes: true, noteActions: [{ id: "fix", label: "Fix" }] } }) as PluginManifest;
    expect(after.contributes.noteActions).toEqual([{ id: "fix", label: "Fix" }]);
    expect(manifestHash(after)).not.toBe(manifestHash(before));
  });
  test("a changed label is a changed approval too", () => {
    const a = validateManifest({ ...base, contributes: { noteActions: [{ id: "fix", label: "Fix" }] } }) as PluginManifest;
    const b = validateManifest({ ...base, contributes: { noteActions: [{ id: "fix", label: "Fix it for me" }] } }) as PluginManifest;
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
  test("a bad one is refused by the manifest validator with its sentence", () => {
    expect(validateManifest({ ...base, contributes: { noteActions: [{ id: "fix", label: "x".repeat(25) }] } })).toContain("finding action label must be 1-24 characters");
  });
});

/** The text of `function <name>(` up to its own closing brace, comments removed. */
function bodyOf(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  // The signature may hold braces of its own (a return type): the body opens at the first line that ends with one.
  const open = at + src.slice(at).search(/\{[ \t]*\n/);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  }
  throw new Error("no closing brace");
}

describe("nothing here reaches GitHub", () => {
  const pluginUi = readFileSync(join(import.meta.dir, "../src/plugin-ui.ts"), "utf8");
  const index = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
  const WORDS = /addComment|GitHubPoster|poster|fetch\(|spawn|\bgh\b|api\.github/;

  test.each(["export async function replyAsPlugin(", "export function decideRun(", "export function pressNoteAction(", "export function costByDay("])("%s has no way out", (head) => {
    expect(bodyOf(pluginUi, head)).not.toMatch(WORDS);
  });
  test("the routes that call them do not hold a poster either", () => {
    for (const route of ['pathname === "/plugin/self/pr/notes/reply"', 'pathname === "/plugins/pr-run-decision"', 'pathname === "/plugins/pr-note-action"', 'pathname === "/plugins/pr-notes/cost"']) {
      const at = index.indexOf(route);
      expect(at).toBeGreaterThan(-1);
      const chunk = index.slice(at, index.indexOf("\n    }\n", at) + 1);
      expect(chunk).not.toMatch(WORDS);
    }
  });
  test("breaking the guard on purpose goes red", () => {
    const poisoned = pluginUi.replace("export function decideRun(plugin: string, id: unknown, decision: unknown): { ok: true } | { ok: false; error: string } {", "export function decideRun(plugin: string, id: unknown, decision: unknown): { ok: true } | { ok: false; error: string } {\n  void addComment;");
    expect(bodyOf(poisoned, "export function decideRun(")).toMatch(WORDS);
  });
});
