/*
 * The one JSON door to the file operations. WHO may call is index.ts's job;
 * here: a caller that is not on this machine gets nothing, an unknown op is a
 * 400, a delete without the count changes nothing, and the undo label travels
 * with every answer so a menu can say what Ctrl+Z would do.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_IRREVERSIBLE, fsPathsOf, fsReadOp, fsRun } from "../src/fsroute.ts";
import { __resetJournalForTest } from "../src/fsops.ts";

const was = { HOME: process.env.HOME, XDG: process.env.XDG_DATA_HOME, ROOTS: process.env.AGENTGLASS_DISK_ROOTS };
const home = mkdtempSync(join(tmpdir(), "agx-fsroute-"));
beforeEach(() => {
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = join(home, "d");
  process.env.AGENTGLASS_DISK_ROOTS = "";
  __resetJournalForTest();
});
afterAll(() => {
  for (const [k, v] of [["HOME", was.HOME], ["XDG_DATA_HOME", was.XDG], ["AGENTGLASS_DISK_ROOTS", was.ROOTS]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

test("a caller that is not local gets a 403 and nothing happens", async () => {
  const r = await fsRun({ op: "mkdir", parent: home, name: "x" }, false);
  expect(r.status).toBe(403);
  expect(existsSync(join(home, "x"))).toBe(false);
  expect(fsReadOp("jobs", new URLSearchParams(), false).status).toBe(403);
});

test("an unknown op is a 400 that lists the known ones", async () => {
  const r = await fsRun({ op: "format-disk" }, true);
  expect(r.status).toBe(400);
  expect(JSON.stringify(r.body)).toContain("trash");
});

test("delete without the count is refused and the file stays", async () => {
  const f = join(home, "a.txt");
  writeFileSync(f, "a");
  expect((await fsRun({ op: "delete", paths: [f] }, true)).status).toBe(400);
  expect(existsSync(f)).toBe(true);
  expect((await fsRun({ op: "delete", paths: [f], confirm: 1 }, true)).status).toBe(200);
});

test("every answer carries what undo would do", async () => {
  mkdirSync(join(home, "src"));
  const r = await fsRun({ op: "mkdir", parent: home, name: "made" }, true);
  expect((r.body as { undo: { label: string } }).undo.label).toBe("Undo new folder made");
  const u = await fsRun({ op: "undo" }, true);
  expect(u.status).toBe(200);
  expect(existsSync(join(home, "made"))).toBe(false);
});

test("redo goes through the same door, is reversible so an agent may use it, and every answer says what it would do", async () => {
  expect((FS_IRREVERSIBLE as readonly string[]).includes("redo")).toBe(false);
  await fsRun({ op: "mkdir", parent: home, name: "again" }, true);
  const u = await fsRun({ op: "undo" }, true);
  expect((u.body as { redo: { available: boolean; label: string } }).redo).toEqual({ available: true, label: "Redo new folder again" });
  const r = await fsRun({ op: "redo" }, true);
  expect(r.status).toBe(200);
  expect(existsSync(join(home, "again"))).toBe(true);
  expect((await fsRun({ op: "redo" }, true)).status).toBe(400);
});

test("a single path or a list both reach the operation, and every named path is listed for the held-back check", () => {
  expect(fsPathsOf({ path: "/a", paths: ["/b", 3], dest: "/c", parent: "/d" }).sort()).toEqual(["/a", "/b", "/c", "/d"]);
  expect(FS_IRREVERSIBLE).toEqual(["delete", "empty-trash"]);
});
