/*
 * An agent on the Polaris routes: what it does directly, what it must ask the person for,
 * what it can never do, and the line the project's orchestrator is woken with.
 *
 * Route level, with the outside world behind PolarisIo: the head GitHub reports, the branch
 * update and the typing into a session are all stubs that count their calls.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS, type DoorValue } from "../../shared/polaris.ts";
import { seatAllows } from "../src/auth.ts";
import { writePolaris } from "../src/config.ts";
import { actionLog } from "../src/db.ts";
import { __draftOf, __resetPolaris, __setDraft, askAction, decidePolaris, headOfPr, onPolarisRequests, onPolarisWake, polarisRequests, sweep, type PolarisIo, type PolarisWho } from "../src/polaris.ts";
import { polarisRoute } from "../src/polarisRoutes.ts";
import { callerFor, phoneMayAnswerPolaris } from "../src/auth.ts";
import { issueDevice, __resetDevices } from "../src/devices.ts";

const INDEX = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const saved = { home: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
const dirs: string[] = [];
const ROOT = "/work/acme/orbit";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const BASE = "c".repeat(40);
const agent: PolarisWho = { kind: "agent", name: "orbit-chair" };
const person: PolarisWho = { kind: "person" };

let head = HEAD;
let synced: [number, string][] = [];
let typed: [string, string][] = [];
let woken: string[] = [];
let io: PolarisIo;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-agent-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.AGENTGLASS_ROOT;
  __resetPolaris();
  __resetDevices();
  head = HEAD; synced = []; typed = []; woken = [];
  io = {
    rerunJob: async () => ({ ok: true }), readJobs: async () => null,
    headOf: async () => head,
    sessionPane: async (root, pane) => (root === ROOT && pane === "%3" ? { name: "orbit-chair" } : null),
    updateBranch: async (_r, n, sha) => { synced.push([n, sha]); return { ok: true }; },
    sendTo: async (pane, text) => { typed.push([pane, text]); return "sent"; },
  };
  onPolarisWake((_r, line) => { woken.push(line); });
  onPolarisRequests(null);
});
afterAll(() => {
  onPolarisWake(null); onPolarisRequests(null);
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.home], ["AGENTGLASS_ROOT", saved.root]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const on = (over: Record<string, DoorValue> = {}) => writePolaris(ROOT, { enabled: true, preset: "custom", doors: { ...structuredClone(PRESETS.guided.doors), relaunch: { mode: "live", cap: 3 }, ...over } });
const post = (who: PolarisWho, path: string, b: Record<string, unknown>, n = 7) => polarisRoute("POST", `/polaris/items/${n}/${path}`, new URLSearchParams(), { root: ROOT, ...b }, who, io);
const draft = async (reason = "failing", text = "Fix the failing build.") => expect((await post(agent, "action", { type: "beacon-draft", reason, text }))!.status).toBe(200);
const lastLog = () => actionLog(5).find((r) => r.actor === "polaris")!;

describe("what an agent does directly", () => {
  test("the in-memory types answer 200", async () => {
    on();
    await draft();
    expect((await post(agent, "action", { type: "beacon-edit", reason: "failing", text: "Fix it." }))!.status).toBe(200);
    expect(__draftOf(ROOT, 7, "failing")).toBe("Fix it.");
    expect((await post(agent, "action", { type: "propose", door: "course", text: "split it" }))!.status).toBe(200);
    expect((await post(agent, "action", { type: "ignore", reason: "failing" }))!.status).toBe(200);
    expect((await post(agent, "beacon/discard", { reason: "failing" }))!.status).toBe(200);
    expect(lastLog().detail).toContain("asked by orbit-chair");
  });

  test("dock and the settings are refused, and a phone cannot act at all", async () => {
    on();
    expect((await post(agent, "action", { type: "dock" }))!.status).toBe(403);
    expect((await polarisRoute("PUT", "/polaris/settings", new URLSearchParams(), { root: ROOT, enabled: false }, agent))!.status).toBe(403);
    expect((await post({ kind: "phone" }, "action", { type: "ignore" }))!.status).toBe(403);
  });

  test("an agent's text over 2000 characters is a 400; the person's is cut as before", async () => {
    on();
    const long = "x".repeat(2001);
    expect((await post(agent, "action", { type: "beacon-draft", reason: "failing", text: long }))!.status).toBe(400);
    expect(__draftOf(ROOT, 7, "failing")).toBeUndefined();
    expect((await post(person, "action", { type: "beacon-draft", reason: "failing", text: long }))!.status).toBe(200);
    expect(__draftOf(ROOT, 7, "failing")).toHaveLength(2000);
  });

  test("an unknown type names every type", async () => {
    on();
    const r = (await post(agent, "action", { type: "merge" }))!;
    expect(r.status).toBe(400);
    for (const t of ["beacon-draft", "beacon-edit", "beacon-discard", "dock", "ignore", "propose", "sync", "beacon-send-on-click"]) expect(String(r.body.error)).toContain(t);
  });
});

describe("a sync waits for the person", () => {
  const ask = (path = "action", b: Record<string, unknown> = {}) => post(agent, path, { type: "sync", headSha: HEAD, baseSha: BASE, ...b });

  test("202 with the request, listed with its state and asker, and nothing ran", async () => {
    on();
    const r = (await ask())!;
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, pending: true, request: { kind: "polaris-action", type: "sync", number: 7, root: ROOT, state: "pending", asker: "orbit-chair", who: "orbit-chair", headSha: HEAD, setting: "polaris.sync" } });
    expect(polarisRequests()).toHaveLength(1);
    expect(synced).toEqual([]);
  });

  test("the audit sentence and the stable asker name travel together, and the CLI filters on the name", async () => {
    on();
    const said = 'an agent calling itself "orbit-chair"';
    const r = await polarisRoute("POST", "/polaris/items/7/action", new URLSearchParams(), { root: ROOT, type: "sync", headSha: HEAD }, { kind: "agent", name: said, askerName: "orbit-chair" }, io);
    expect(r!.body.request).toMatchObject({ asker: said, askerName: "orbit-chair" });
    // A newer ask from the same agent replaces its own, though the sentence is not the key.
    const again = await polarisRoute("POST", "/polaris/items/7/action", new URLSearchParams(), { root: ROOT, type: "sync", headSha: HEAD }, { kind: "agent", name: said, askerName: "orbit-chair" }, io);
    expect(polarisRequests({ all: true }).map((x) => x.id)).toEqual([(again!.body.request as { id: string }).id]);
  });

  test("the decision is typed into the project's chair, by the root's name", async () => {
    on();
    const { promptSeatForPolaris } = await import("../src/seatwake.ts");
    const typed: string[] = [];
    const sitting = async () => ({ name: "orbit-chair", kind: "opencode", cwd: ROOT, paneId: "%7", windowId: "", startedAt: 1, endedAt: null });
    onPolarisWake((root, line) => { void promptSeatForPolaris(root, line, {
      seated: sitting as never,
      screen: (async () => null) as never,
      prompt: (async (_p: string, t: string) => { typed.push(t); return "sent"; }) as never,
    }); });
    const id = ((await ask())!.body.request as { id: string }).id;
    expect(await decidePolaris(id, true, "person", {}, io)).toMatchObject({ ok: true, state: "approved" });
    await new Promise((r) => setTimeout(r, 10));
    expect(typed).toEqual(["Polaris: your sync request for PR #7 was approved: done."]);
    // The entry point wires that line to this door, rather than to a private copy of it.
    expect(INDEX).toContain("SeatWake.promptSeatForPolaris(root, line)");
  });

  test("a second ask for the same pull request replaces the first", async () => {
    on();
    const a = (await ask())!.body.request as { id: string };
    const b = (await ask())!.body.request as { id: string };
    expect(b.id).not.toBe(a.id);
    expect(polarisRequests({ all: true }).map((x) => x.id)).toEqual([b.id]);
  });

  test("another agent's pending ask is not cancelled by a newer one", async () => {
    on();
    const mine = (await ask())!.body.request as { id: string };
    const theirs = (await post({ kind: "agent", name: "orbit-builder" }, "action", { type: "sync", headSha: HEAD, baseSha: BASE }))!.body.request as { id: string };
    expect(polarisRequests({ all: true }).map((x) => x.id).sort()).toEqual([mine.id, theirs.id].sort());
  });

  test("the waiting cap is per project: a queue here does not spend another project's room", async () => {
    on();
    const OTHER = "/work/acme/other";
    expect(writePolaris(OTHER, { enabled: true, preset: "custom", doors: { ...structuredClone(PRESETS.guided.doors), relaunch: { mode: "live", cap: 3 } } }).ok).toBe(true);
    for (let n = 1; n <= 20; n++) expect((await post(agent, "action", { type: "sync", headSha: HEAD }, n))!.status).toBe(202);
    expect((await post(agent, "action", { type: "sync", headSha: HEAD }, 99))!.status).toBe(429);
    const elsewhere = await polarisRoute("POST", "/polaris/items/3/action", new URLSearchParams(), { root: OTHER, type: "sync", headSha: HEAD }, agent, io);
    expect(elsewhere!.status).toBe(202);
  });

  test("dry: audited and skipped, no request; off: refused, no request", async () => {
    on({ relaunch: { mode: "dry", cap: 3 } });
    expect(await ask()).toMatchObject({ status: 200, body: { ok: true, outcome: "skipped-in-dry-run" } });
    expect(lastLog()).toMatchObject({ action: "/polaris/sync", detail: expect.stringContaining("asked by orbit-chair") });
    on({ relaunch: { mode: "off", cap: 3 } });
    expect((await ask())!.status).toBe(409);
    expect(polarisRequests({ all: true })).toEqual([]);
  });

  test("the head the agent names must be the one the server read", async () => {
    on();
    expect((await ask("action", { headSha: MOVED }))!.status).toBe(409);
    expect((await ask("action", { headSha: undefined }))!.status).toBe(409);
    expect(polarisRequests({ all: true })).toEqual([]);
  });

  test("a loop of asks for one pull request cannot spend a GitHub read each", async () => {
    on();
    let reads = 0;
    const counting: PolarisIo = { ...io, headOf: async () => { reads++; return head; } };
    const t0 = 9_000_000;
    for (let i = 0; i < 6; i++) expect((await askAction("sync", { root: ROOT, number: 7, headSha: HEAD }, "orbit-chair", counting, t0 + i)).request).toBeDefined();
    const capped = await askAction("sync", { root: ROOT, number: 7, headSha: HEAD }, "orbit-chair", counting, t0 + 6);
    expect(capped).toMatchObject({ ok: false, status: 429 });
    expect(reads).toBe(6);
    // The window rolls: a minute later the same ask is answered again, with its one read.
    expect((await askAction("sync", { root: ROOT, number: 7, headSha: HEAD }, "orbit-chair", counting, t0 + 61_000)).request).toBeDefined();
    expect(reads).toBe(7);
  });

  test("approving replays the args once and the audit names both", async () => {
    on();
    const id = ((await ask())!.body.request as { id: string }).id;
    const d = await decidePolaris(id, true, "person", {}, io);
    expect(d).toMatchObject({ ok: true, applied: true, state: "approved", setting: "polaris.sync" });
    expect(synced).toEqual([[7, HEAD]]);
    expect(lastLog().detail).toContain("asked by orbit-chair, approved by person");
    const again = await decidePolaris(id, true, "person", {}, io);
    // The sentence names the state: without the state guard the refusal came from `synced`, which is idempotency, not replay.
    expect(again).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("already approved") });
    expect(synced).toHaveLength(1);
    expect(polarisRequests({ all: true })[0]).toMatchObject({ state: "approved" });
    expect(woken.at(-1)).toContain("was approved");
  });

  test("a moved head is refused on approve and the request is marked changed", async () => {
    on();
    const id = ((await ask())!.body.request as { id: string }).id;
    head = MOVED;
    expect(await decidePolaris(id, true, "person", {}, io)).toMatchObject({ ok: false, status: 409 });
    expect(synced).toEqual([]);
    expect(polarisRequests({ all: true })[0]).toMatchObject({ state: "changed" });
  });

  test("declining runs nothing and tells the orchestrator", async () => {
    on();
    const id = ((await ask())!.body.request as { id: string }).id;
    expect(await decidePolaris(id, false, "phone", {}, io)).toMatchObject({ ok: true, applied: false, state: "declined" });
    expect(synced).toEqual([]);
    expect(woken.at(-1)).toContain("declined");
  });

  test("an unanswered ask expires after 30 minutes and then leaves the list", async () => {
    on();
    const t0 = 5_000_000;
    const r = await askAction("sync", { root: ROOT, number: 7, headSha: HEAD }, "orbit-chair", io, t0);
    expect(r.request?.state).toBe("pending");
    expect(polarisRequests({}, t0 + 30 * 60_000 + 1)).toEqual([]);
    expect(polarisRequests({ all: true }, t0 + 30 * 60_000 + 1)[0]).toMatchObject({ state: "expired" });
    expect(await decidePolaris(r.request!.id, true, "person", {}, io, t0 + 30 * 60_000 + 1)).toMatchObject({ ok: false, status: 409 });
    expect(polarisRequests({ all: true }, t0 + 61 * 60_000)).toEqual([]);
  });

  test("a reset forgets every request", async () => {
    on();
    await ask();
    __resetPolaris();
    expect(polarisRequests({ all: true })).toEqual([]);
  });
});

describe("a send waits for the person", () => {
  const send = (path: "action" | "beacon/send" = "beacon/send", b: Record<string, unknown> = {}) =>
    post(agent, path, { reason: "failing", paneId: "%3", ...(path === "action" ? { type: "beacon-send-on-click" } : {}), ...b });

  test("202 on both routes, with the draft and the session on the card", async () => {
    on();
    await draft();
    for (const p of ["action", "beacon/send"] as const) {
      const r = (await send(p))!;
      expect(r.status).toBe(202);
      expect(r.body.request).toMatchObject({ type: "beacon-send-on-click", state: "pending", draftText: "Fix the failing build.", paneId: "%3", headSha: HEAD, label: "Send a message to orbit-chair for PR #7" });
    }
    expect(typed).toEqual([]);
  });

  test("a pane that is not a live session of this project is refused, so the card cannot name another project's session", async () => {
    on();
    await draft();
    const r = (await send("beacon/send", { paneId: "%9" }))!;
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("not a live session of this project");
    expect(polarisRequests({ all: true })).toEqual([]);
    expect(typed).toEqual([]);
  });

  test("no draft, no session, or the beacon door off: refused, no request", async () => {
    on();
    expect((await send())!.status).toBe(409);
    await draft();
    expect((await send("beacon/send", { paneId: undefined }))!.status).toBe(409);
    on({ beacon: { mode: "off" } });
    expect((await send())!.status).toBe(409);
    expect(polarisRequests({ all: true })).toEqual([]);
  });

  test("approving types the draft once", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    expect(await decidePolaris(id, true, "person", {}, io)).toMatchObject({ ok: true, applied: true, state: "approved" });
    expect(typed).toEqual([["%3", "Fix the failing build."]]);
    expect((await decidePolaris(id, true, "person", {}, io)).ok).toBe(false);
    expect(typed).toHaveLength(1);
    expect(polarisRequests({ all: true })[0]).toMatchObject({ state: "approved" });
  });

  test("a second approval is refused by the state even when the same draft exists again", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    expect(await decidePolaris(id, true, "person", {}, io)).toMatchObject({ ok: true, applied: true });
    // With the draft gone, "there is no draft" would refuse a replay by accident. Put it back: only the state guard stands.
    __setDraft(ROOT, 7, "failing", "Fix the failing build.");
    const again = await decidePolaris(id, true, "person", {}, io);
    expect(again).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("already approved") });
    expect(typed).toHaveLength(1);
  });

  test("a draft edited after the ask is not sent", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    await post(agent, "beacon/edit", { reason: "failing", text: "Something else." });
    expect(await decidePolaris(id, true, "person", {}, io)).toMatchObject({ ok: false, status: 409 });
    expect(typed).toEqual([]);
    expect(polarisRequests({ all: true })[0]).toMatchObject({ state: "changed" });
  });

  test("a moved head is not sent", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    head = MOVED;
    expect((await decidePolaris(id, true, "person", {}, io)).ok).toBe(false);
    expect(typed).toEqual([]);
  });

  test("Approve all never approves a send", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    expect(await decidePolaris(id, true, "person", { bulk: true }, io)).toMatchObject({ ok: false, status: 403 });
    expect(typed).toEqual([]);
    expect(polarisRequests()).toHaveLength(1);
  });

  test("a session that ended between the ask and the approval is not typed into", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    // The pane was live when the agent asked; by the time the person approves it is gone.
    const gone: PolarisIo = { ...io, sessionPane: async () => null };
    expect(await decidePolaris(id, true, "person", {}, gone)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("session") });
    expect(typed).toEqual([]);
    expect(polarisRequests({ all: true })[0]).toMatchObject({ state: "changed" });
  });

  test("two approvals of one send at once run it once", async () => {
    on();
    await draft();
    const id = ((await send())!.body.request as { id: string }).id;
    // Slow the read both clicks wait on, so both are inside the request when the other arrives.
    const slow: PolarisIo = { ...io, headOf: async () => { await Bun.sleep(10); return head; } };
    const [a, b] = await Promise.all([decidePolaris(id, true, "person", {}, slow), decidePolaris(id, true, "person", {}, slow)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const refused = (a.ok ? b : a) as { status?: number; error?: string };
    expect(refused.status).toBe(409);
    expect(String(refused.error)).toContain("already approved");
    expect(typed).toHaveLength(1);
  });
});

describe("the head a request is bound to", () => {
  test("is read from the pull request itself, one call, never the board's cache", async () => {
    const asked: string[][] = [];
    const sha = "d".repeat(40);
    const run = async (args: string[]) => { asked.push(args); return { code: 0, stdout: `${sha}\n`, stderr: "" }; };
    expect(await headOfPr("gh:acme/orbit", 7, run)).toBe(sha);
    expect(asked).toEqual([["api", "repos/acme/orbit/pulls/7", "--jq", ".head.sha"]]);
    // A failed read, or an answer that is not a sha, is null: a stale board row must not stand in for it.
    expect(await headOfPr("gh:acme/orbit", 7, async () => ({ code: 1, stdout: sha, stderr: "HTTP 500" }))).toBeNull();
    expect(await headOfPr("gh:acme/orbit", 7, async () => ({ code: 0, stdout: "null", stderr: "" }))).toBeNull();
  });
});

describe("who may answer", () => {
  test("a phone with the answer grant approves a sync and never a send", () => {
    const { token } = issueDevice("phone", "answer");
    const as = (t: string) => callerFor(new Request("http://x/", { headers: { authorization: `Bearer ${t}` } }), new URL("http://x/"), "machine-token");
    expect(phoneMayAnswerPolaris("sync", as(token))).toBe(true);
    expect(phoneMayAnswerPolaris("beacon-send-on-click", as(token))).toBe(false);
    // Nothing weaker: a read grant, no caller, and the machine token every agent shell holds.
    expect(phoneMayAnswerPolaris("sync", as(issueDevice("reader", "read").token))).toBe(false);
    expect(phoneMayAnswerPolaris("sync", null)).toBe(false);
    expect(phoneMayAnswerPolaris("sync", { kind: "machine", scope: "full" })).toBe(false);
    expect(phoneMayAnswerPolaris("beacon-send-on-click", as(issueDevice("full-phone", "full").token))).toBe(false);
  });

  test("index.ts: an agent never, a phone never for a send, a seat only to ask", () => {
    const fn = INDEX.slice(INDEX.indexOf("function mayAnswerSettingsRequest("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/x-agentglass-agent"\)\) return false/);
    // The rule itself is exercised as behaviour above; here only that index.ts hands it the ask it was asked about.
    expect(body).toMatch(/phoneMayAnswerPolaris\(ask, caller\)/);
    expect(body).toMatch(/caller\?\.kind === "device" && !caller\.principal\) return false/);
    expect(INDEX).toMatch(/const may = mayAnswerSettingsRequest\(req, caller, ask\)/);
    expect(INDEX).toMatch(/const d = may \? await decidePolaris\(/);
  });

  test("a seat may post to the Polaris act routes only with the power to assign", () => {
    for (const p of ["/polaris/items/7/action", "/polaris/items/7/beacon/send", "/polaris/items/7/beacon/edit", "/polaris/items/7/beacon/discard"]) {
      expect(seatAllows("assign", "POST", p, ROOT)).toBe(true);
      expect(seatAllows("nudge", "POST", p, ROOT)).toBe(false);
      expect(seatAllows("speak", "POST", p, ROOT)).toBe(false);
    }
    expect(seatAllows("assign", "POST", "/polaris/settings", ROOT)).toBe(false);
    expect(seatAllows("assign", "POST", "/polaris/items/7/beacon/other", ROOT)).toBe(false);
    expect(seatAllows("assign", "POST", "/settings/requests/decide", ROOT)).toBe(false);
  });
});

describe("the wake line", () => {
  const item = (reason: string, headSha = HEAD, number = 12, ignored = false) => ({ reason, number, headSha, dropped: [], ignored });
  const pass = async (items: unknown[], now: number) => {
    const load = (async () => ({ ok: true, enabled: true, items })) as never;
    await sweep(ROOT, io, now, load);
  };
  const T = 40_000_000;
  const gap = 6 * 60_000;

  test("an ignored pull request wakes nobody, even at a head nobody has seen", async () => {
    on({ diagnose: { mode: "auto" }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await pass([item("failing", HEAD, 12, true)], T);
    expect(woken).toEqual([]);
    // The same pull request, not ignored, still wakes: the guard skips the item and not the loop.
    await pass([item("failing", HEAD, 12, false)], T + gap);
    expect(woken).toHaveLength(1);
  });

  test("a red that is not a dropped job wakes once per head, even if it is red twice", async () => {
    on({ diagnose: { mode: "auto" }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await pass([item("failing")], T);
    await pass([item("failing")], T + gap);
    expect(woken).toEqual([`Polaris: PR #12 is red and it is not a dropped job. Read it: agentglass-ui polaris items --root ${ROOT}`]);
    await pass([item("failing", MOVED)], T + 2 * gap);
    expect(woken).toHaveLength(2);
  });

  test("diagnose click or off wakes nobody", async () => {
    for (const mode of ["click", "off"]) {
      on({ diagnose: { mode }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
      await pass([item("failing")], T);
    }
    expect(woken).toEqual([]);
  });

  test("falling behind follows the course door: any mode but off", async () => {
    on({ course: { mode: "off" }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await pass([item("behind")], T);
    expect(woken).toEqual([]);
    on({ course: { mode: "hours", hours: 24 }, lookAgain: { mode: "on", minutes: 5, steps: 1 } });
    await pass([item("behind")], T + gap);
    expect(woken).toEqual([`Polaris: PR #12 fell behind its base branch. Read it: agentglass-ui polaris items --root ${ROOT}`]);
  });
});
