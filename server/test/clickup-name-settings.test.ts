/*
 * The three name guesses that became settings: which lists are sprints, which
 * custom fields are read-only, and whether "assigned to me" asks for subtasks.
 *
 * What is pinned first is the default: with no settings file the query string
 * and the answers are exactly what they were before the settings existed. A
 * setting is then asserted to change only its own thing.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-names-"));
const CU = await import("../src/clickup.ts");
const P = await import("../src/clickupPrefs.ts");

let paths: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    paths.push(u.pathname + u.search);
    const body = u.pathname.endsWith("/field")
      ? { fields: [
          { id: "f1", name: "Owner (DO NOT EDIT)", type: "drop_down" },
          { id: "f2", name: "Locked by ops", type: "text" },
          { id: "f3", name: "Notes", type: "text" },
        ] }
      : u.pathname.startsWith("/list/") ? { name: "Backlog", statuses: [] }
      : { tasks: [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
  },
});

beforeEach(() => {
  paths = [];
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.__reset();
  rmSync(join(dir, "clickup-prefs.json"), { force: true });
  P.__setPrefsPath(join(dir, "clickup-prefs.json"));
});
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  P.__setPrefsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("assigned to me and subtasks", () => {
  test("default: the query string is exactly the one that shipped, with no subtasks", async () => {
    await CU.fetchTasks("pk_1_X", "9001", "7");
    expect(paths).toEqual(["/team/9001/task?page=0&order_by=due_date&include_closed=false&assignees%5B%5D=7"]);
  });

  test("on: subtasks=true is added and nothing else changes", async () => {
    expect(P.setClickupPrefs({ assigned: { includeSubtasks: true } }).ok).toBe(true);
    await CU.fetchTasks("pk_1_X", "9001", "7");
    expect(paths).toEqual(["/team/9001/task?page=0&order_by=due_date&include_closed=false&subtasks=true&assignees%5B%5D=7"]);
  });

  test("switching it back off removes it again", async () => {
    P.setClickupPrefs({ assigned: { includeSubtasks: true } });
    P.setClickupPrefs({ assigned: { includeSubtasks: false } });
    await CU.fetchTasks("pk_1_X", "9001", "7");
    expect(paths[0]).not.toContain("subtasks");
  });
});

describe("which lists are sprints", () => {
  test("default: Sprint-named and date-ranged lists, nothing else", () => {
    expect(CU.looksLikeSprint("Sprint 12")).toBe(true);
    expect(CU.looksLikeSprint("Iteration 4 (1/1/26 - 1/7/26)")).toBe(true);
    expect(CU.looksLikeSprint("Iteration 12")).toBe(false);
    expect(CU.looksLikeSprint("Backlog")).toBe(false);
  });

  test("a saved pattern adds a naming habit and keeps the dated shape", () => {
    expect(P.setClickupPrefs({ sprintListPattern: "^iteration\\b" }).ok).toBe(true);
    expect(CU.looksLikeSprint("Iteration 12")).toBe(true);
    expect(CU.looksLikeSprint("Iteration 4 (1/1/26 - 1/7/26)")).toBe(true);
    expect(CU.looksLikeSprint("Sprint 12")).toBe(false);
    expect(CU.sprintOf([{ name: "Iteration 12" }], "Bugs")).toBe("Iteration 12");
  });
});

describe("which custom fields are read-only", () => {
  const flags = async () => {
    const r = await CU.listMeta("pk_1_X", "L1");
    return Object.fromEntries(r.data!.fields.map((f) => [f.name, f.readOnly]));
  };

  test("default: only a name that says do not edit", async () => {
    expect(await flags()).toEqual({ "Owner (DO NOT EDIT)": true, "Locked by ops": false, "Notes": false });
  });

  test("a saved pattern replaces the guess", async () => {
    P.setClickupPrefs({ readOnlyFieldPattern: "locked by" });
    expect(await flags()).toEqual({ "Owner (DO NOT EDIT)": false, "Locked by ops": true, "Notes": false });
  });
});
