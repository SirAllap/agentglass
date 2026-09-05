/*
 * Every write this app can make to a ClickUp card, checked against a stand-in
 * workspace.
 *
 * There is no sandbox card to try these on — the cards are his team's, and a
 * test run must not land on one. So what is asserted here is the REQUEST: the
 * method, the path and the exact body ClickUp would receive. That is where all
 * of this can be wrong in a way nobody notices: a date sent as a string, a
 * points value sent as a custom field, a move that adds to the new list and
 * never removes from the old, a comment edited into plain text.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CU from "../src/clickup.ts";
import * as C from "../src/credentials.ts";
import * as CV from "../src/clickupviews.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-writes-"));

let seen: { method: string; path: string; body: unknown }[] = [];
let reply: (req: Request) => Response | Promise<Response> = () => new Response("{}", { headers: { "content-type": "application/json" } });

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const text = await req.text().catch(() => "");
    seen.push({ method: req.method, path: u.pathname, body: text ? JSON.parse(text) : undefined });
    return reply(req);
  },
});
const BASE = `http://127.0.0.1:${server.port}`;
const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  seen = [];
  reply = () => ok({ id: "t1", name: "a card" });
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.__clearAll();
  C.setCredential("clickup", { token: "pk_1_TEST", accountId: "7" });
  CV.__setViewsPath(join(dir, "views.json"));
  CV.setWritesAllowed(true);
  CU.__setClickUpBase(BASE);
});
afterEach(() => { CU.__reset(); });
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  CV.__setViewsPath(null);
  C.__setCredentialsPath(null);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const last = () => seen[seen.length - 1]!;

describe("the card's own fields", () => {
  test("points go to the task, as a number, not to a custom field", async () => {
    // Measured on a real workspace: sprint points is the NATIVE `points` field.
    // Looking for it among the custom fields finds nothing, and writing it
    // there would 404 on a field id that does not exist.
    const r = await CU.updateTask("t1", { points: 5 });
    expect(r.ok).toBe(true);
    expect(last().method).toBe("PUT");
    expect(last().path).toBe("/task/t1");
    expect(last().body).toEqual({ points: 5 });
  });

  test("a due date is milliseconds and says it carries a time", async () => {
    await CU.updateTask("t1", { due: 1_786_000_000_000 });
    expect(last().body).toEqual({ due_date: 1_786_000_000_000, due_date_time: true });
  });

  test("clearing a date is a null, and then it is not a time any more", async () => {
    await CU.updateTask("t1", { due: null });
    expect(last().body).toEqual({ due_date: null, due_date_time: false });
  });

  test("a description is sent as markdown AND as plain, so either API takes it", async () => {
    await CU.updateTask("t1", { description: "## Title\n- one" });
    expect(last().body).toEqual({ markdown_content: "## Title\n- one", description: "## Title\n- one" });
  });

  test("several fields are one write, not one write each", async () => {
    await CU.updateTask("t1", { name: "new name", points: 2, estimate: 3_600_000 });
    expect(seen).toHaveLength(1);
    expect(last().body).toEqual({ name: "new name", points: 2, time_estimate: 3_600_000 });
  });

  test("a patch that changes nothing does not call ClickUp at all", async () => {
    const r = await CU.updateTask("t1", {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nothing to change");
    expect(seen).toHaveLength(0);
  });

  test("a card that moved under you refuses the write and says so", async () => {
    reply = () => ok({ id: "t1", date_updated: "1754300009999" });
    const r = await CU.updateTask("t1", { points: 1 }, 1754300000000);
    expect(r.conflict).toBe(true);
    // The read happened; the write did not.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
  });
});

describe("custom fields", () => {
  test("each kind goes on the wire in the shape ClickUp accepts", () => {
    expect(CU.fieldWire("drop_down", "opt-1")).toBe("opt-1");
    expect(CU.fieldWire("date", "1786000000000")).toBe(1_786_000_000_000);
    expect(CU.fieldWire("number", "12")).toBe(12);
    expect(CU.fieldWire("currency", "9.5")).toBe(9.5);
    expect(CU.fieldWire("checkbox", "true")).toBe(true);
    expect(CU.fieldWire("checkbox", "false")).toBe(false);
    // A labels field takes an array even when one label is chosen.
    expect(CU.fieldWire("labels", "a, b")).toEqual(["a", "b"]);
    expect(CU.fieldWire("labels", "")).toEqual([]);
    // A kind from a workspace we have never seen: send the words.
    expect(CU.fieldWire("mystery", "whatever")).toBe("whatever");
  });

  test("clearing a field is a DELETE, not an empty string", async () => {
    // A drop-down set to "" is a 400. Emptying one is its own verb.
    await CU.clearField("t1", "f1");
    expect(last().method).toBe("DELETE");
    expect(last().path).toBe("/task/t1/field/f1");
  });

  test("a field id with a slash in it cannot escape the path", async () => {
    await CU.setField("t1", "a/b", "v");
    expect(last().path).toBe("/task/t1/field/a%2Fb");
  });
});

describe("tags", () => {
  test("on is a POST and off is a DELETE, both by name", async () => {
    await CU.setTag("t1", "regression", true);
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/task/t1/tag/regression");
    await CU.setTag("t1", "needs qa", false);
    expect(last().method).toBe("DELETE");
    expect(last().path).toBe("/task/t1/tag/needs%20qa");
  });
});

describe("moving a card between lists, which is how a sprint changes", () => {
  test("it joins the new list first and leaves the old one after", async () => {
    const r = await CU.moveToList("t1", "sprint-2", "sprint-1");
    expect(r.ok).toBe(true);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /list/sprint-2/task/t1",
      "DELETE /list/sprint-1/task/t1",
    ]);
  });

  /* The order matters: a failed remove leaves the card in two sprints, which
     anybody can see and fix. A failed add after a remove would leave it in
     none, which nobody sees until the sprint report is wrong. */
  test("when the add fails, nothing is removed", async () => {
    reply = () => new Response(JSON.stringify({ err: "Team not authorized" }), { status: 400 });
    const r = await CU.moveToList("t1", "sprint-2", "sprint-1");
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(1);
    // And the answer names the app that has to be on, because that is the
    // actual remedy for this refusal.
    expect(r.error).toContain("Multiple Lists");
  });

  test("when only the remove fails, it says the card is in both", async () => {
    let n = 0;
    reply = () => (++n === 1 ? ok({}) : new Response(JSON.stringify({ err: "nope" }), { status: 400 }));
    const r = await CU.moveToList("t1", "sprint-2", "sprint-1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("still in the old one");
  });

  test("no old list means it is added and nothing is removed", async () => {
    await CU.moveToList("t1", "sprint-2");
    expect(seen).toHaveLength(1);
  });
});

describe("comments", () => {
  test("a new comment is sent as ops, never as plain text", async () => {
    // `comment_text` is shown verbatim on the card: the asterisks would be
    // part of the comment.
    await CU.commentOn("t1", "**done** and tested");
    const body = last().body as { comment: { text?: string; attributes?: Record<string, unknown> }[]; notify_all: boolean };
    expect(last().path).toBe("/task/t1/comment");
    expect(body.notify_all).toBe(false);
    expect(body).not.toHaveProperty("comment_text");
    expect(body.comment[0]).toEqual({ text: "done", attributes: { bold: true } });
  });

  test("an empty comment is not a write", async () => {
    expect((await CU.commentOn("t1", "   ")).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("an edit sends ops, and falls back to plain text only if they are refused", async () => {
    let n = 0;
    reply = () => (++n === 1 ? new Response(JSON.stringify({ err: "unsupported" }), { status: 400 }) : ok({}));
    const r = await CU.editComment("c1", "**still** broken");
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toHaveProperty("comment");
    expect(seen[1]!.body).toEqual({ comment_text: "**still** broken" });
  });

  test("an edit that ClickUp accepts does not post twice", async () => {
    await CU.editComment("c1", "fixed");
    expect(seen).toHaveLength(1);
  });

  test("a reply goes to the thread, not to the card", async () => {
    await CU.replyToComment("c1", "on it");
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/comment/c1/reply");
  });

  test("resolving and deleting are their own verbs", async () => {
    await CU.resolveComment("c1", true);
    expect(last()).toMatchObject({ method: "PUT", path: "/comment/c1", body: { resolved: true } });
    await CU.deleteComment("c1");
    expect(last()).toMatchObject({ method: "DELETE", path: "/comment/c1" });
  });
});

describe("checklists and new cards", () => {
  test("a checklist, an item and a tick are three different addresses", async () => {
    await CU.addChecklist("t1", "QA");
    expect(last().path).toBe("/task/t1/checklist");
    await CU.addChecklistItem("cl1", "check staging");
    expect(last().path).toBe("/checklist/cl1/checklist_item");
    await CU.setChecklistItem("cl1", "it1", true);
    expect(last()).toMatchObject({ method: "PUT", path: "/checklist/cl1/checklist_item/it1", body: { resolved: true } });
  });

  test("a new card carries the priority as ClickUp's number", async () => {
    reply = () => ok({ id: "new1", url: "https://example.invalid/t/new1" });
    const r = await CU.createTask("list-9", { name: "Look into the retry loop", priority: "high", points: 3 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: "new1", url: "https://example.invalid/t/new1" });
    expect(last().body).toEqual({ name: "Look into the retry loop", priority: 2, points: 3 });
  });

  test("a card with no title is refused here rather than by ClickUp", async () => {
    expect((await CU.createTask("list-9", { name: "  " })).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("the switch that has to hold for all of them", () => {
  test("with writing off, nothing reaches ClickUp", async () => {
    CV.setWritesAllowed(false);
    const tries = [
      () => CU.updateTask("t1", { points: 1 }),
      () => CU.setTag("t1", "x", true),
      () => CU.setField("t1", "f", "v"),
      () => CU.clearField("t1", "f"),
      () => CU.moveToList("t1", "l2", "l1"),
      () => CU.createTask("l", { name: "x" }),
      () => CU.addChecklist("t1", "c"),
      () => CU.addChecklistItem("c1", "i"),
      () => CU.setChecklistItem("c1", "i1", true),
      () => CU.editComment("c1", "x"),
      () => CU.replyToComment("c1", "x"),
      () => CU.resolveComment("c1", true),
      () => CU.deleteComment("c1"),
    ];
    for (const go of tries) {
      const r = await go();
      expect(r.ok).toBe(false);
      expect(r.error).toBe("Writing to ClickUp is switched off");
    }
    expect(seen).toHaveLength(0);
  });
});
