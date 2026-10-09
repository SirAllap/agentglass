/*
 * The picker's spaces, and what they cost at a stand-in workspace.
 *
 * Measured on a real workspace: ten spaces came back from Get Spaces and the
 * person's cards all sat in one of them. Narrowing to that one must cost no
 * request beyond the single spaces read the picker already made, so the count
 * is asserted here with the cards read first and not read at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";
import * as CV from "../src/clickupviews.ts";
import * as PF from "../src/clickupPrefs.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-statusspaces-"));
let seen: string[] = [];
let taskDelay = 0;
let taskRows: ReturnType<typeof task>[] | null = null;
const ok = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
const WORK = ["to do", "in development", "code review", "released"].map((s, i) => ({ status: s, type: i ? "custom" : "open", orderindex: i }));
const task = (id: string, space: string, list: string, status: string) => ({
  id, name: `Card ${id}`, url: "", date_updated: "1700000000000", status: { status, type: "custom" },
  list: { id: list, name: `List ${list}` }, space: { id: space }, assignees: [], tags: [],
});

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    seen.push(`${req.method} ${p}`);
    if (p === "/user") return ok({ user: { id: 7, username: "me", email: "me@example.test" } });
    if (p === "/team/9/space") return ok({ spaces: [
      { id: "1", name: "Sales", statuses: [{ status: "requests", type: "open" }] },
      { id: "2", name: "Orbit", statuses: WORK },
    ] });
    if (p === "/team/9/task") {
      if (taskDelay) await Bun.sleep(taskDelay);
      return ok({ tasks: taskRows ?? [task("a", "2", "10", "code review"), task("b", "2", "11", "released")], last_page: true });
    }
    return ok({});
  },
});
const count = (re: RegExp) => seen.filter((s) => re.test(s)).length;

beforeEach(() => {
  seen = [];
  taskDelay = 0;
  taskRows = null;
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7", workspaceId: "9" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.__clear();
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.forgetAll();
  PF.__setPrefsPath(join(dir, "prefs.json"));
  rmSync(join(dir, "prefs.json"), { force: true });
});
afterEach(() => { CU.__resetCounts(); CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
  PF.__setPrefsPath(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("clickupStatusSpaces", () => {
  test("cards read: the space they live in leads, and three asks are one spaces request and no card request", async () => {
    await CU.clickupTasks(true);
    seen = [];
    for (let i = 0; i < 3; i++) await CU.clickupStatusSpaces();
    const r = await CU.clickupStatusSpaces();
    expect(r.data!.source).toBe("tasks");
    expect(r.data!.spaces.map((s) => s.name)).toEqual(["Orbit", "Sales"]);
    expect(count(/\/team\/9\/space$/)).toBe(1);
    expect(count(/\/team\/9\/task$/)).toBe(0);
    expect(seen.length).toBe(1);
  });

  /* Measured on a real workspace: the page asked while the server had not read the cards yet, was told
     "every space counts", and kept that until it was reopened. The first look at the cards is ten
     seconds of ClickUp's own latency; an answer given inside it is not "everything", it is "not yet". */
  test("cards not read yet: the answer waits for the first look and then narrows, in one card request", async () => {
    taskDelay = 150;
    const [a, b] = await Promise.all([CU.clickupStatusSpaces(), CU.clickupTasks().catch(() => null)]);
    expect(b).not.toBeNull();
    expect(a.data!.source).toBe("tasks");
    expect(a.data!.spaces.map((s) => [s.name, s.counted])).toEqual([["Orbit", true], ["Sales", false]]);
    expect(count(/\/team\/9\/task$/)).toBe(1);
  });

  test("cards still being read when the wait ends: pending, nothing counted, nothing ignored", async () => {
    taskDelay = 400;
    const r = await CU.clickupStatusSpaces(false, 20);
    expect(r.data!.source).toBe("pending");
    expect(r.data!.spaces.every((s) => s.counted === false && s.pending === true)).toBe(true);
    expect(r.data!.note).toContain("None counts until");
    await Bun.sleep(500);
    const again = await CU.clickupStatusSpaces();
    expect(again.data!.source).toBe("tasks");
    expect(again.data!.spaces[0]!.name).toBe("Orbit");
    expect(count(/\/team\/9\/task$/)).toBe(1);
  });

  test("cards that could not be read at all: every space, and it says so", async () => {
    taskRows = [];
    const r = await CU.clickupStatusSpaces();
    expect(r.data!.source).toBe("spaces");
    expect(r.data!.note).toContain("No cards have been read yet");
    expect(r.data!.spaces.map((s) => s.name)).toEqual(["Sales", "Orbit"]);
  });

  test("a chosen set of spaces does not wait for the cards, and starts no card request", async () => {
    taskDelay = 400;
    expect(PF.setClickupPrefs({ statusSpaces: { counted: ["1"] } }).ok).toBe(true);
    const t0 = Date.now();
    const r = await CU.clickupStatusSpaces();
    expect(Date.now() - t0).toBeLessThan(300);
    expect(r.data!.source).toBe("chosen");
    expect(count(/\/team\/9\/task$/)).toBe(0);
  });

  test("a saved choice of spaces decides what counts, with no request of its own", async () => {
    await CU.clickupTasks(true);
    await CU.clickupStatusSpaces();
    seen = [];
    expect(PF.setClickupPrefs({ statusSpaces: { counted: ["1"] } }).ok).toBe(true);
    const r = await CU.clickupStatusSpaces();
    expect(r.data!.source).toBe("chosen");
    expect(r.data!.spaces.map((s) => [s.name, s.counted])).toEqual([["Sales", true], ["Orbit", false]]);
    expect(seen.length).toBe(0);
  });

  test("a card carries its space from the task payload", () => {
    expect(CU.toTask(task("a", "2", "10", "released") as never).spaceId).toBe("2");
  });
});
