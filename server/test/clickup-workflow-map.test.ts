/*
 * What the workflow map stands on, server side.
 *
 * Two things moved: the review menu's move and the merge dialog's choice became
 * steps like the others (off until added, kept for a file that already had
 * them), and the statuses a status picker offers now come from the answer the
 * space list already gives, held ten minutes, so a pick costs no request.
 *
 * Every file lives under a private temp dir and the tracker is a local stub;
 * nothing here reads the real config directory or reaches the real tracker.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cu-map-"));
const C = await import("../src/credentials.ts");
const CU = await import("../src/clickup.ts");
const P = await import("../src/clickupPrefs.ts");

let paths: string[] = [];
let mode: "ok" | "limit" = "ok";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    paths.push(u.pathname + u.search);
    if (mode === "limit") return new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 40) } });
    return new Response(JSON.stringify({
      spaces: [
        { id: "1", name: "Engineering", statuses: [
          { status: "to do", type: "open", color: "#87909e" },
          { status: "ready for qa", type: "custom", color: "#4194f6" },
          { status: "done", type: "done" },
        ] },
        { id: "2", name: "Support", statuses: [{ status: "open", type: "open" }, { status: "solved", type: "closed" }] },
      ],
    }), { headers: { "content-type": "application/json", "x-ratelimit-remaining": "99" } });
  },
});

const file = join(dir, "clickup-prefs.json");
beforeEach(() => {
  paths = []; mode = "ok";
  C.__setCredentialsPath(join(dir, "credentials.json"));
  C.setCredential("clickup", { token: "pk_1_TEST", account: "Ada", workspace: "Orbit", workspaceId: "9001", accountId: "7" });
  CU.__setClickUpBase(`http://127.0.0.1:${server.port}`);
  CU.forgetAll();
  rmSync(file, { force: true });
  P.__setPrefsPath(file);
});
afterAll(() => {
  server.stop(true);
  CU.__setClickUpBase(null);
  C.__setCredentialsPath(null);
  P.__setPrefsPath(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("the review menu and the merge choice are steps", () => {
  test("a fresh machine has neither: both are off and the merge choice names no status", () => {
    const p = P.clickupPrefs();
    expect(p.review.enabled).toBe(false);
    expect(p.merge).toEqual({ enabled: false, blocks: [], statusNames: [], assign: { who: "none" } });
  });

  test("a file from before the key existed keeps the review item it always had", () => {
    writeFileSync(file, JSON.stringify({ review: { statusNames: ["In review"], assignReviewer: true } }));
    P.__setPrefsPath(file);
    const p = P.clickupPrefs();
    expect(p.review.enabled).toBe(true);
    expect(p.review.statusNames).toEqual(["In review"]);
    /* The merge dialog's card row was always there too: it stays, with no status, which is "Leave it there". */
    expect(p.merge).toEqual({ enabled: true, blocks: [], statusNames: [], assign: { who: "none" } });
  });

  test("the marker an older start wrote for a machine with no token is not a user: connecting later turns nothing on", () => {
    writeFileSync(file, JSON.stringify({
      handoff: { enabled: false, statusNames: [], unassign: "none" },
      review: { statusNames: [], assignReviewer: false },
      flows: { noteOnCard: false },
    }));
    P.__setPrefsPath(file);
    const p = P.clickupPrefs();
    expect([p.review.enabled, p.merge.enabled, p.handoff.enabled, p.review.assignReviewer, p.flows.noteOnCard]).toEqual([false, false, false, false, false]);
  });

  test("a hand-off alone is enough to show somebody was using it: the review item and merge choice stay", () => {
    writeFileSync(file, JSON.stringify({ handoff: { enabled: true, statusNames: [], unassign: "all" }, review: { statusNames: [], assignReviewer: false } }));
    P.__setPrefsPath(file);
    const p = P.clickupPrefs();
    expect([p.review.enabled, p.merge.enabled]).toEqual([true, true]);
  });

  test("a file that says it is off is believed", () => {
    writeFileSync(file, JSON.stringify({ review: { enabled: false, statusNames: [], assignReviewer: false } }));
    P.__setPrefsPath(file);
    expect(P.clickupPrefs().review.enabled).toBe(false);
  });

  test("the first start with a token seeds the review item and the merge choice on, like the other three", () => {
    expect(P.settleFirstRun(true)).toBe("seeded");
    const p = P.clickupPrefs();
    expect([p.review.enabled, p.merge.enabled, p.handoff.enabled, p.review.assignReviewer, p.flows.noteOnCard]).toEqual([true, true, true, true, true]);
  });

  test("the first start without one seeds nothing on", () => {
    P.settleFirstRun(false);
    const p = P.clickupPrefs();
    expect([p.review.enabled, p.handoff.enabled, p.review.assignReviewer, p.flows.noteOnCard, p.merge.enabled]).toEqual([false, false, false, false, false]);
  });

  test("a save of one merge key leaves the other, and a typo is refused rather than dropped", () => {
    expect(P.setClickupPrefs({ merge: { enabled: true } }).ok).toBe(true);
    const r = P.setClickupPrefs({ merge: { statusNames: ["done"] } });
    expect(r.ok && r.prefs.merge).toEqual({ enabled: true, blocks: [{ type: "move", statusNames: ["done"] }], statusNames: ["done"], assign: { who: "none" } });
    expect(P.setClickupPrefs({ merge: { status: "done" } }).ok).toBe(false);
    expect(P.setClickupPrefs({ review: { enabled: "yes" } }).ok).toBe(false);
  });
});

describe("statuses from the space list", () => {
  test("each space carries its own statuses, with type and colour", async () => {
    const r = await CU.clickupSpaces();
    expect(r.ok).toBe(true);
    expect(r.data?.spaces.map((s) => [s.name, s.statuses.map((x) => x.status)])).toEqual([
      ["Engineering", ["to do", "ready for qa", "done"]],
      ["Support", ["open", "solved"]],
    ]);
    expect(r.data?.spaces[0]!.statuses[1]).toEqual({ status: "ready for qa", type: "custom", color: "#4194f6" });
    expect(r.data?.spaces[1]!.statuses[0]).toEqual({ status: "open", type: "open" });
  });

  test("a second read inside ten minutes is not a request, and a Re-read is exactly one", async () => {
    await CU.clickupSpaces();
    await CU.clickupSpaces();
    await CU.clickupSpaces();
    expect(paths).toEqual(["/team/9001/space?archived=false"]);
    await CU.clickupSpaces(true);
    expect(paths.length).toBe(2);
  });

  test("a refusal is reported as one and is not held, so the next ask goes out again", async () => {
    mode = "limit";
    const bad = await CU.clickupSpaces();
    expect(bad.ok).toBe(false);
    expect(bad.throttled).toBe(true);
    mode = "ok";
    CU.__reset();
    const good = await CU.clickupSpaces();
    expect(good.ok).toBe(true);
  });
});
