/*
 * A card's stamp moves for a comment, a tag or a due date as well as for the
 * fields a write sets. Measured: the person's own comment moved it, and the
 * reviewer they put on the card next was refused as "somebody changed this
 * card". These tests read the card the way the panel does (that is what leaves
 * the baseline), then change it behind the panel's back and write.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";
import * as CV from "../src/clickupviews.ts";
import { __clearSeen } from "../src/cardStamp.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-stale-"));

let seen: { method: string; path: string; body: unknown }[] = [];
let now: Record<string, unknown> = {};
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const text = await req.text().catch(() => "");
    seen.push({ method: req.method, path: new URL(req.url).pathname, body: text ? JSON.parse(text) : undefined });
    return ok(req.method === "GET" ? now : { id: "t1" });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

const ana = { id: 11, username: "Ana" };
const bo = { id: 12, username: "Bo" };
const card = (stamp: number, o: { status?: string; assignees?: { id: number; username: string }[]; priority?: string } = {}) => ({
  id: "t1",
  name: "Retry the webhook delivery",
  date_updated: String(stamp),
  status: { status: o.status ?? "to do", type: "open" },
  assignees: o.assignees ?? [ana],
  priority: { priority: o.priority ?? "normal" },
});

const T0 = 1_754_300_000_000;
const puts = () => seen.filter((x) => x.method === "PUT");

beforeEach(() => {
  seen = [];
  __clearSeen();
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.setWritesAllowed(true);
  CU.__setClickUpBase(BASE);
  // The panel read the card at T0.
  CU.toTask(card(T0) as never);
});
afterEach(() => { CU.__reset(); __clearSeen(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("assigning after the card's stamp moved", () => {
  test("a comment moved only the stamp: the assignee write goes out", async () => {
    now = card(T0 + 5000);
    const r = await CU.setAssignee("t1", 12, true, T0);
    expect(r.ok).toBe(true);
    expect(r.conflict).toBeUndefined();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.path).toBe("/task/t1");
    expect(puts()[0]!.body).toEqual({ assignees: { add: [12] } });
  });

  test("somebody else got on the card meanwhile: conflict, names who, no PUT", async () => {
    now = card(T0 + 5000, { assignees: [ana, bo] });
    const r = await CU.setAssignee("t1", 12, true, T0);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.error).toBe("This card changed while you had it open: it is now assigned to Ana, Bo. Reloaded");
    expect(puts()).toHaveLength(0);
  });

  test("the same holds for assigning yourself and for a card-wide set", async () => {
    now = card(T0 + 5000, { assignees: [bo] });
    expect((await CU.assignSelf("t1", true, T0)).conflict).toBe(true);
    expect((await CU.setCard("t1", { add: [12] }, T0)).conflict).toBe(true);
    expect(puts()).toHaveLength(0);
    now = card(T0 + 5000);
    expect((await CU.assignSelf("t1", true, T0)).ok).toBe(true);
    expect((await CU.setCard("t1", { add: [12] }, T0)).ok).toBe(true);
    expect(puts()).toHaveLength(2);
  });
});

// The card shows a person by name, and a name is not a person.
describe("an assignee who reads the same", () => {
  test("another account with the same name: conflict, no PUT", async () => {
    now = card(T0 + 5000, { assignees: [{ id: 99, username: "Ana" }] });
    const r = await CU.setAssignee("t1", 12, true, T0);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.error).toBe("This card changed while you had it open: it is now assigned to Ana. Reloaded");
    expect(puts()).toHaveLength(0);
  });

  test("people with no username are told apart by id", async () => {
    // The panel read the card with one nameless assignee; another nameless one took over.
    __clearSeen();
    CU.toTask({ ...card(T0), assignees: [{ id: 21 }] } as never);
    now = { ...card(T0 + 5000), assignees: [{ id: 22 }] };
    const r = await CU.setAssignee("t1", 12, true, T0);
    expect(r.conflict).toBe(true);
    expect(puts()).toHaveLength(0);
    now = { ...card(T0 + 5000), assignees: [{ id: 21 }] };
    expect((await CU.setAssignee("t1", 12, true, T0)).ok).toBe(true);
    expect(puts()).toHaveLength(1);
  });
});

describe("moving after the card's stamp moved", () => {
  test("only the people changed: the status write goes out", async () => {
    now = card(T0 + 5000, { assignees: [ana, bo] });
    const r = await CU.setStatus("t1", "in progress", T0);
    expect(r.ok).toBe(true);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toEqual({ status: "in progress" });
  });

  test("the status changed: conflict, says what it is now, no PUT", async () => {
    now = card(T0 + 5000, { status: "in review" });
    const r = await CU.setStatus("t1", "in progress", T0);
    expect(r.conflict).toBe(true);
    expect(r.error).toBe("This card changed while you had it open: its status is now in review. Reloaded");
    expect(puts()).toHaveLength(0);
  });

  test("a priority write is held to the priority only", async () => {
    now = card(T0 + 5000, { status: "in review" });
    expect((await CU.setPriority("t1", "high", T0)).ok).toBe(true);
    now = card(T0 + 6000, { priority: "urgent" });
    const r = await CU.setPriority("t1", "high", T0);
    expect(r.conflict).toBe(true);
    expect(r.error).toContain("its priority is now urgent");
  });
});

describe("a stamp nobody read", () => {
  test("is the old conflict, even when nothing it sets has changed", async () => {
    now = card(T0 + 5000);
    const r = await CU.setAssignee("t1", 12, true, T0 - 1);
    expect(r.conflict).toBe(true);
    expect(r.error).toContain("Somebody changed this card");
    expect(puts()).toHaveLength(0);
  });

  test("a write with the current stamp is not judged at all", async () => {
    now = card(T0);
    expect((await CU.setAssignee("t1", 12, true, T0)).ok).toBe(true);
  });
});
