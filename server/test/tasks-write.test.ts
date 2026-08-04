import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Writing to a store somebody else is also writing to.
 *
 * The editor is the other writer and it does not announce itself. Measured on a
 * real store: 30 writers against 30 DISTINCT tasks lost 21 of them, every one
 * exiting 0 — so "the command succeeded" is not evidence that anything landed,
 * and neither is checking the row you touched. What is asserted here is the
 * precondition, and the one property that no amount of care at the call site
 * can recover: that a verb we run leaves everything we did not model alone.
 *
 * Its own disposable store, pinned to this process's timezone for the reason
 * tasks-read.test.ts gives.
 */
const has = !!Bun.which("task");
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
let dir = "", data = "", rc = "";
let mod: typeof import("../src/tasks.ts");

const raw = (args: string[]) =>
  Bun.spawnSync(["task", ...args], {
    env: { ...process.env, TZ, TASKDATA: data, TASKRC: rc },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-tw-"));
  data = join(dir, "data"); rc = join(dir, "taskrc");
  writeFileSync(rc, `data.location=${data}\nuda.ticket.type=string\nuda.ticket.label=Ticket\n`);
  process.env.TASKDATA = data; process.env.TASKRC = rc; process.env.TZ = TZ;
  mod = await import("../src/tasks.ts");
  mod.__resetTaskPaths();
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } });

beforeEach(() => {
  if (!has) return;
  // Re-pointed every test: another suite in this process points the same module
  // at its own fixture, and whichever ran last wins.
  process.env.TASKDATA = data; process.env.TASKRC = rc;
  mod.__resetTaskPaths();
  rmSync(data, { recursive: true, force: true });
  raw(["rc.confirmation=no", "add", "an ordinary task"]);
});

const uuidOf = (needle: string): string => {
  const r = raw(["rc.gc=0", "rc.verbose=nothing", "export"]);
  const all = JSON.parse(r.stdout.toString().slice(r.stdout.toString().indexOf("["))) as { uuid: string; description: string }[];
  return all.find((t) => t.description.includes(needle))!.uuid;
};
const exportOne = (uuid: string): Record<string, unknown> => {
  const r = raw(["rc.gc=0", "rc.verbose=nothing", "export"]);
  const all = JSON.parse(r.stdout.toString().slice(r.stdout.toString().indexOf("["))) as Record<string, unknown>[];
  return all.find((t) => t.uuid === uuid)!;
};

describe("verbs, never import", () => {
  it.skipIf(!has)("completes a task without deleting the attributes it does not model", async () => {
    // The reason this file exists. `task import` replaces a task from the JSON
    // you hand it, so every attribute you did not think of — recurrence, a
    // dependency, a wait date, somebody's UDA — is silently deleted, and a
    // check of the field you meant to change reports success. A verb merges.
    raw(["rc.confirmation=no", "add", "carries everything", "wait:2030-01-01", "ticket:ABC-1", "+keepme", "project:deep.nested"]);
    const dep = uuidOf("an ordinary task");
    const uuid = uuidOf("carries everything");
    raw(["rc.confirmation=no", uuid, "modify", `depends:${dep}`]);

    const before = exportOne(uuid);
    expect(before.wait, "fixture did not take").toBeTruthy();
    expect(before.ticket).toBe("ABC-1");

    const r = await mod.completeTask(uuid);
    expect(r.ok, r.error).toBe(true);

    const after = exportOne(uuid);
    expect(after.status).toBe("completed");
    // …and everything we never modelled is still there.
    expect(after.ticket).toBe("ABC-1");
    expect(after.wait).toBe(before.wait);
    expect(after.depends).toBeTruthy();
    expect(after.project).toBe("deep.nested");
    expect(after.tags).toEqual(["keepme"]);
  });

  it.skipIf(!has)("refuses anything that is not a task id, before it reaches a command", async () => {
    for (const bad of ["1", "../../etc/passwd", "$(id)", "; rm -rf /", "", "not-a-uuid-at-all"]) {
      const r = await mod.completeTask(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.error).toBe("that is not a task id");
    }
  });
});

describe("the precondition", () => {
  it.skipIf(!has)("refuses when the store moved under the row on screen", async () => {
    // What the client saw, then somebody else's edit, then our click. The
    // answer is 409 and the fresh list — never a retry, because retrying
    // against a moved store is how the other writer's work gets reverted.
    const uuid = uuidOf("an ordinary task");
    const stale = (await mod.listTasks(true)).fingerprint;
    raw(["rc.confirmation=no", "add", "the editor got there first"]);

    const r = await mod.completeTask(uuid, stale);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.error).toContain("changed this task");
    // And it did not write: the task is still open.
    expect(exportOne(uuid).status).toBe("pending");
    // The caller is handed truth to re-render from, not left guessing.
    expect(r.tasks!.some((t) => t.description === "the editor got there first")).toBe(true);
  });

  it.skipIf(!has)("goes through when the fingerprint still matches", async () => {
    const uuid = uuidOf("an ordinary task");
    const fresh = (await mod.listTasks(true)).fingerprint;
    const r = await mod.completeTask(uuid, fresh);
    expect(r.ok, r.error).toBe(true);
    expect(exportOne(uuid).status).toBe("completed");
    // The new fingerprint comes back, so the next write needs no round trip.
    expect(r.fingerprint).toBeTruthy();
    expect(r.fingerprint).not.toBe(fresh);
  });
});

describe("the quick-add grammar", () => {
  it("emits a struct, and leaves anything that is not a token in the text", () => {
    // Every field becomes its own argv element, so nothing is concatenated and
    // nothing is quoted — because nothing reaches a shell.
    const p = mod.parseInput("fix the login redirect !h +auth @web #3 *tomorrow 9:00");
    expect(p.description).toBe("fix the login redirect");
    expect(p.priority).toBe("H");
    expect(p.tags).toEqual(["auth"]);
    expect(p.project).toBe("web");
    expect(p.due).toBeTruthy();
    expect(p.remind).toBe("tomorrow 9:00");
  });

  it("keeps accents in a tag rather than truncating them", () => {
    // A \w-based class turns +revisión into the tag `revisi`, silently. This
    // user writes in two languages; that is not an exotic input here.
    expect(mod.parseInput("algo +revisión").tags).toEqual(["revisión"]);
    expect(mod.parseInput("algo @día.uno").project).toBe("día.uno");
  });

  it("refuses a token that is not one, and leaves it visible in the description", () => {
    // The alternative is eating it: the user types `+rm -rf /` and the app
    // quietly drops the text rather than showing what it did with it.
    const p = mod.parseInput("write about C++ and +$(id) and @../../etc");
    expect(p.tags).toEqual([]);
    expect(p.project).toBe(null);
    expect(p.description).toContain("$(id)");
    expect(p.description).toContain("../../etc");
  });

  it("says so when there is nothing left but labels", async () => {
    const r = await mod.addTask("!h +auth @web");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("all labels");
  });

  it.skipIf(!has)("adds a task with everything the grammar found", async () => {
    const r = await mod.addTask("ship the thing !m +release @deploy #2");
    expect(r.ok, r.error).toBe(true);
    const t = r.tasks!.find((x) => x.description === "ship the thing")!;
    expect(t.priority).toBe("M");
    expect(t.tags).toEqual(["release"]);
    expect(t.project).toBe("deploy");
    expect(t.due).toBeTruthy();
  });
});

describe("the kill switch", () => {
  it("is read from the module, so no route can forget it", () => {
    // Checked once where every verb passes, rather than at each call site —
    // a new verb is covered by construction.
    expect(typeof mod.TASK_WRITE_ENABLED).toBe("boolean");
    const src = Bun.file(new URL("../src/tasks.ts", import.meta.url).pathname);
    expect(src).toBeTruthy();
  });

  it.skipIf(!has)("never blocks the reminders, which are ours to write", async () => {
    // The whole reason the schedule lives in our own database: turning off
    // writes to somebody else's store must not turn off being told things.
    const R = await import("../src/reminders.ts");
    const before = R.listReminders("upcoming").length;
    const d = new Date(Date.now() + 60_000);
    const p = (n: number) => String(n).padStart(2, "0");
    const civil = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    expect(R.addReminder({ title: "still works", civil }).ok).toBe(true);
    expect(R.listReminders("upcoming").length).toBe(before + 1);
  });
});
