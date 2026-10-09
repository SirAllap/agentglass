/*
 * "Also assign" on a step that moves a card: what is saved, what the one write
 * sends, and how many requests a press costs.
 *
 * The tracker is a local stub and every file lives in a private temp dir; nothing
 * here reaches the real ClickUp or the real settings. What is asserted is the
 * REQUEST list: a press that also assigns must cost what a press that does not
 * costs, and "me" must be answered without reading the team.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-assign-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const CV = await import("../src/clickupviews.ts");
const P = await import("../src/clickupPrefs.ts");

let seen: { method: string; path: string; body: unknown }[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const text = await req.text().catch(() => "");
    seen.push({ method: req.method, path: u.pathname, body: text ? JSON.parse(text) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/team") {
      return json({ teams: [{ id: "9001", members: [
        { user: { id: 7, username: "Ada Test", email: "ada@orbit.example" } },
        { user: { id: 8, username: "Sam Rivera", email: "sam@orbit.example" } },
      ] }] });
    }
    return json({ id: "t1", name: "a card", date_updated: "100", status: { status: "ready for deployment" }, assignees: [] });
  },
});

const file = join(dir, "clickup-prefs.json");
beforeEach(() => {
  seen = [];
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.setWritesAllowed(true);
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.forgetAll();
  rmSync(file, { force: true });
  P.__setPrefsPath(file);
});
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
  C.__setCredentialsPath(null);
  P.__setPrefsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

const requests = () => seen.map((r) => `${r.method} ${r.path}`);

describe("the saved row", () => {
  test("every step that moves a status starts at leave as is", () => {
    const p = P.clickupPrefs();
    for (const g of [p.handoff, p.review, p.merge]) expect(g.assign).toEqual({ who: "none" });
  });

  test("a settings file from before the row existed reads as leave as is, whatever else it holds", () => {
    writeFileSync(file, JSON.stringify({
      handoff: { enabled: true, statusNames: ["ready for qa"], unassign: "all" },
      review: { enabled: true, statusNames: ["code review"], assignReviewer: true },
      merge: { enabled: true, statusNames: ["done"] },
    }));
    P.__setPrefsPath(file);
    const p = P.clickupPrefs();
    expect(p.handoff).toEqual({ enabled: true, blocks: [{ type: "move", statusNames: ["ready for qa"] }, { type: "unassign", who: "all" }], statusNames: ["ready for qa"], unassign: "all", assign: { who: "none" } });
    expect(p.review.assign).toEqual({ who: "none" });
    expect(p.merge.assign).toEqual({ who: "none" });
  });

  test("each choice saves, reads back, and is replaced whole by the next", () => {
    const pick = { who: "person", person: { id: 8, name: "Sam Rivera" } } as const;
    expect(P.setClickupPrefs({ handoff: { assign: { who: "me" } } }).ok).toBe(true);
    expect(P.clickupPrefs().handoff.assign).toEqual({ who: "me" });
    expect(P.setClickupPrefs({ review: { assign: { who: "author" } } }).ok).toBe(false); // not a ClickUp choice any more
    expect(P.setClickupPrefs({ merge: { assign: pick } }).ok).toBe(true);
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().merge.assign).toEqual(pick);
    /* The person does not outlive a switch to another choice. */
    expect(P.setClickupPrefs({ merge: { assign: { who: "me" } } }).ok).toBe(true);
    expect(P.clickupPrefs().merge.assign).toEqual({ who: "me" });
    /* And the rest of the group is untouched by a save of the row. */
    expect(P.clickupPrefs().merge.statusNames).toEqual([]);
  });

  test("a malformed choice is refused with a reason and writes nothing", () => {
    P.setClickupPrefs({ handoff: { enabled: true } });
    const before = P.clickupPrefs();
    const refused = (assign: unknown) => P.setClickupPrefs({ handoff: { assign } });
    for (const bad of [
      "me", null, { who: "everyone" }, { who: "person" }, { who: "person", person: { id: 0, name: "x" } },
      { who: "person", person: { id: 1.5, name: "x" } }, { who: "person", person: { id: 8, name: "" } },
      { who: "person", person: { id: 8, name: "Sam", email: "x" } }, { who: "me", person: { id: 8, name: "Sam" } }, { who: "me", extra: 1 },
    ]) {
      const r = refused(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect((r as { error: string }).error).toContain("handoff.assign");
    }
    expect(P.clickupPrefs()).toEqual(before);
  });
});

describe("what a press costs", () => {
  test("the card write is one PUT with the status and the person together, the same as without the person", async () => {
    const plain = await CU.setCard("t1", { status: "ready for deployment" }, 100);
    const plainReqs = requests();
    seen = [];
    const withPerson = await CU.setCard("t1", { status: "ready for deployment", add: [8], rem: [3] }, 100);
    expect(plain.ok && withPerson.ok).toBe(true);
    expect(requests()).toEqual(plainReqs);
    expect(requests()).toEqual(["GET /task/t1", "PUT /task/t1"]);
    expect(seen[1]!.body).toEqual({ assignees: { add: [8], rem: [3] }, status: "ready for deployment" });
  });

  test("me is answered from the connected account: no member list, no team, no extra request", async () => {
    const r = await CU.setCard("t1", { status: "ready for deployment", addMe: true }, 100);
    expect(r.ok).toBe(true);
    expect(requests()).toEqual(["GET /task/t1", "PUT /task/t1"]);
    expect(seen[1]!.body).toEqual({ assignees: { add: [7] }, status: "ready for deployment" });
  });

  test("me twice, or me and the same id, adds once", async () => {
    await CU.setCard("t1", { addMe: true, add: [7] });
    expect(seen.at(-1)!.body).toEqual({ assignees: { add: [7] } });
  });

  test("me with no account id sends nothing instead of guessing", async () => {
    C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada" });
    const r = await CU.setCard("t1", { status: "x", addMe: true });
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
  });

  test("the writes-off switch still stops it", async () => {
    CV.setWritesAllowed(false);
    const r = await CU.setCard("t1", { status: "x", addMe: true });
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
    CV.setWritesAllowed(true);
  });
});

describe("the people a setting can name", () => {
  test("the workspace answer is one request cold and none warm, with you first", async () => {
    const a = await CU.workspaceMembers();
    expect(a.ok && a.data?.members.map((m) => [m.name, !!m.me])).toEqual([["Ada Test", true], ["Sam Rivera", false]]);
    expect(requests()).toEqual(["GET /team"]);
    seen = [];
    const b = await CU.workspaceMembers();
    expect(b.ok).toBe(true);
    expect(seen).toEqual([]);
  });

  test("without a token it says so instead of asking", async () => {
    C.__clearAll();
    const r = await CU.workspaceMembers();
    expect(r.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});
