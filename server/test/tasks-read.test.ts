import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The local task list, read against a disposable Taskwarrior store.
 *
 * Its own TASKDATA and TASKRC, never the developer's: this suite spawns `task`,
 * and pointing it at somebody's real store is how a test suite ends up owning
 * their afternoon. The fixture is built here rather than committed, so the
 * assertions describe the shape rather than a snapshot.
 *
 * Deliberately covers what a real store usually does not: a task due TODAY —
 * where the UTC→local conversion earns its keep, because getting it wrong makes
 * every such task render permanently overdue — a deleted one, a project, two
 * annotations of different kinds, and a description carrying the characters the
 * quick-add grammar treats as tokens.
 */
// Computed at module scope, not in beforeAll: `skipIf` is evaluated when the
// describe block is built, which is before any hook has run.
const has = !!Bun.which("task");
let dir: string;
let mod: typeof import("../src/tasks.ts");

/*
 * The child is pinned to the parent's timezone, and that is the whole point.
 *
 * Bun runs tests in UTC for determinism, while a spawned `task` inherits the
 * machine's zone. Left alone the two disagree: in Europe/Madrid, `due:today`
 * is stored as 22:00Z of the *previous* day, which a UTC parent then reads back
 * as yesterday. Both are right in their own zone; the test is what was wrong.
 * Production never sees this — the server and the `task` it spawns are one
 * process tree with one zone — so pinning them together here is the honest
 * fixture, not a workaround.
 */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const run = (args: string[], env: Record<string, string>) =>
  Bun.spawnSync(["task", ...args], { env: { ...process.env, TZ, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-task-"));
  const data = join(dir, "data");
  const rc = join(dir, "taskrc");
  writeFileSync(rc, `data.location=${data}\n`);
  process.env.TASKDATA = data;
  process.env.TASKRC = rc;
  if (has) {
    const env = { TASKDATA: data, TASKRC: rc };
    const today = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const iso = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    run(["rc.confirmation=no", "add", "Due today, which is the one that breaks", `due:${iso}`, "+today", "project:fixture"], env);
    run(["rc.confirmation=no", "add", "A literal +word and a #3 and an @at in the text", "priority:H"], env);
    run(["rc.confirmation=no", "add", "This one gets deleted"], env);
    run(["rc.confirmation=no", "3", "delete"], env);
    run(["rc.confirmation=no", "2", "annotate", "a note about the thing"], env);
    run(["rc.confirmation=no", "2", "annotate", "https://example.invalid/ticket/1"], env);
  }
  mod = await import("../src/tasks.ts");
  mod.__resetTaskPaths();
});

afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

describe("reading the store", () => {
  it.skipIf(!has)("keeps a task due today out of overdue", async () => {
    // Taskwarrior stores every date in UTC. Reading only the date half puts
    // local midnight on the previous day for anyone east of Greenwich, so the
    // task the user just gave a due date of today renders as already late.
    const snap = await mod.listTasks(true);
    const t = snap.tasks.find((x) => x.description.startsWith("Due today"));
    expect(t, "the fixture task was not read back").toBeTruthy();
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    expect(t!.due).toBe(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`);
  });

  it.skipIf(!has)("splits annotations into prose and links", async () => {
    const snap = await mod.listTasks(true);
    const t = snap.tasks.find((x) => x.description.includes("literal +word"));
    expect(t!.notes).toEqual(["a note about the thing"]);
    expect(t!.urls).toEqual(["https://example.invalid/ticket/1"]);
  });

  it.skipIf(!has)("carries no taskwarrior id into the model", async () => {
    // `id` is a display number that is reassigned on garbage collection, so a
    // client holding one across a refresh acts on whatever inherited it.
    const snap = await mod.listTasks(true);
    for (const t of snap.tasks) expect(Object.keys(t)).not.toContain("id");
    expect(snap.tasks.every((t) => t.uuid.length > 8)).toBe(true);
  });

  it.skipIf(!has)("reads a deleted task as deleted rather than pending", async () => {
    const snap = await mod.listTasks(true);
    const t = snap.tasks.find((x) => x.description === "This one gets deleted");
    expect(t?.status).toBe("deleted");
  });

  it.skipIf(!has)("does not write to the store it is reading", async () => {
    // `task export` runs a garbage collection as a side effect and rewrites
    // pending.data — measured, 514 bytes to 371 on a real store. Every read
    // would be a write, renumbering ids under whatever else has the store open.
    // `rc.gc=0` is what stops it, and this is the assertion that keeps it there.
    const data = join(dir, "data");
    const before = readdirSync(data).map((f) => `${f}:${Bun.file(join(data, f)).size}`).sort().join("|");
    await mod.listTasks(true);
    await mod.listTasks(true);
    const after = readdirSync(data).map((f) => `${f}:${Bun.file(join(data, f)).size}`).sort().join("|");
    expect(after).toBe(before);
  });
});

describe("date conversion", () => {
  it("turns a UTC stamp into the local calendar day", () => {
    // 22:00 UTC on the 30th is the 31st in any zone east of UTC+2.
    const got = mod.twDate("20260330T220000Z");
    const want = new Date(Date.UTC(2026, 2, 30, 22, 0, 0));
    const p = (n: number) => String(n).padStart(2, "0");
    expect(got).toBe(`${want.getFullYear()}-${p(want.getMonth() + 1)}-${p(want.getDate())}`);
  });

  it("accepts a bare date and refuses anything else", () => {
    expect(mod.twDate("20260330")).toBe("2026-03-30");
    expect(mod.twDate("nonsense")).toBe(null);
    expect(mod.twDate(undefined)).toBe(null);
  });
});

describe("capability", () => {
  it("says which of the two failures it is", async () => {
    // "Not installed" and "installed but never set up" need different
    // sentences: one is a thing to install, the other is a question only the
    // user can answer. A single "unavailable" would send them nowhere.
    const cap = await mod.taskCapability(true);
    expect(typeof cap.available).toBe("boolean");
    expect(typeof cap.configured).toBe("boolean");
    if (!cap.available || !cap.configured) expect(cap.reason).toBeTruthy();
  });

  it("never creates the user's config while probing", async () => {
    // Running `task` with rc.confirmation=no to see whether it works
    // auto-answers its first-run question and writes a ~1.5 KB taskrc. The
    // probe asks the filesystem first for exactly this reason.
    const probe = mkdtempSync(join(tmpdir(), "agx-probe-"));
    const savedRc = process.env.TASKRC, savedData = process.env.TASKDATA;
    process.env.TASKRC = join(probe, "taskrc");
    process.env.TASKDATA = join(probe, "data");
    mod.__resetTaskPaths();
    const cap = await mod.taskCapability(true);
    expect(readdirSync(probe)).toEqual([]);
    if (Bun.which("task")) expect(cap.configured).toBe(false);
    process.env.TASKRC = savedRc; process.env.TASKDATA = savedData;
    mod.__resetTaskPaths();
    rmSync(probe, { recursive: true, force: true });
  });
});
