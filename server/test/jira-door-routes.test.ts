/*
 * The agent door to a Jira card, through a real server and the fake site: what
 * `agentglass-ui jira ...` and its MCP twin send. The door calls what the routes
 * call, so what is pinned here is what it adds: every string a person typed on
 * the site arrives under `untrusted` and none in `state`; with writes off an
 * acting verb is refused with the very sentence the route gives, and the site
 * never hears of it; below control level 3 the acting verbs are refused whatever
 * the Jira switch says, read-only included; a step that landed short of the
 * whole says so; a page from another origin can use none of it; the
 * action log names who asked; and no answer carries the token.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { DOOR_VERBS } from "../src/jiraDoor.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-door";
const PR = { url: "https://github.com/acme/orbit/pull/318", title: "Retry the export", number: 318, author: "octo-ada" };

interface Booted { dir: string; base: string; proc: ReturnType<typeof Bun.spawn>; fake: FakeJira; call: (m: string, p: string, b?: unknown, h?: Record<string, string>) => Promise<{ status: number; body: Record<string, any> }>; seen: () => string }
const booted: Booted[] = [];

async function boot(extra: Record<string, string> = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "agx-jira-door-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  const fake = startFakeJira({ pageSize: 2 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"), AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "r.db"),
      AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_JIRA_BASE: fake.base, ...extra,
    },
    stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) throw new Error("the server did not come up: " + output.slice(0, 400));
  let seen = "";
  const call: Booted["call"] = async (method, path, body, h = {}) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...h } };
    if (method === "POST") init.body = JSON.stringify(body ?? {});
    const r = await fetch(base + path, init);
    const text = await r.text();
    seen += text;
    return { status: r.status, body: JSON.parse(text) as Record<string, any> };
  };
  const b = { dir, base, proc, fake, call, seen: () => seen };
  booted.push(b);
  return b;
}

afterAll(async () => {
  for (const b of booted) {
    try { b.proc.kill(); } catch { /* already gone */ }
    await b.fake.stop();
    try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* fine */ }
  }
});

/** The level at which the door's acting verbs run at all; the Jira write switch is asked after it. */
const ACTING = { AGENTGLASS_CONTROL_LEVEL: "3" };
const BASE64 = Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64");
const door = (b: Booted, verb: string, body: Record<string, unknown> = {}, h?: Record<string, string>) => b.call("POST", `/jira/door/${verb}`, { as: "orchestrator", ...body }, h);
const stamp = (b: Booted, k: string) => Date.parse(b.fake.state.issues[k]!.updated);
const writes = (b: Booted) => b.fake.requests.filter((q) => q.method !== "GET");

describe("the card door", () => {
  const step = story();
  let b!: Booted;

  step("boot, connect and configure the handoff step", async () => {
    b = await boot(ACTING);
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    const blocks = [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr}" }, { type: "link" }];
    expect((await b.call("POST", "/jira/steps", { steps: { handoff: { enabled: true, blocks } } })).status).toBe(200);
  });

  step("card: the words of the card are under untrusted and none of them is in state", async () => {
    const r = await door(b, "card", { key: "ORBIT-1042" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.untrusted.title).toBe("Fix timeout when syncing the board");
    expect(r.body.untrusted.status).toBe("In Progress");
    expect(r.body.untrusted.comments.map((c: { text: string }) => c.text)).toEqual(["@Ada Example can you take a look at the retry loop?"]);
    const state = JSON.stringify(r.body.state);
    for (const said of ["Fix timeout", "In Progress", "retry loop", "Ada", "sync"]) expect(state).not.toContain(said);
    // What an agent needs to act: the stamp a step is checked against, and whether a write would be accepted.
    expect(r.body.state.updated).toBe(stamp(b, "ORBIT-1042"));
    expect(r.body.state.writes).toBe(false);
  });

  step("card: what is not a card id is a sentence, and the site is not asked", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "card", { key: "ORBIT-1042; DROP" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "That is not a Jira card id" });
    expect(b.fake.requests.length).toBe(0);
  });

  step("moves: ids in state, the team's own names under untrusted", async () => {
    const r = await door(b, "moves", { key: "ORBIT-1042" });
    expect(r.body.ok).toBe(true);
    const ids = (r.body.state.moves as { id: string }[]).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect((r.body.untrusted.moves as { id: string; toStatus: string }[]).map((m) => m.id)).toEqual(ids);
    expect(JSON.stringify(r.body.state)).not.toContain("In Review");
    expect((r.body.untrusted.moves as { toStatus: string }[]).map((m) => m.toStatus)).toContain("In Review");
  });

  step("card: what the pane draws beside the words is on the door too, ids in state and every typed string under untrusted", async () => {
    const r = await door(b, "card", { key: "ORBIT-1050" });
    expect(r.body.state).toMatchObject({ linkedCount: 5, subtasksDone: 0, subtasksTotal: 0, attachmentCount: 0 });
    expect(r.body.untrusted.linked.map((l: { phrase: string; key: string }) => [l.phrase, l.key])).toEqual([
      ["blocks", "ACME-8"], ["is blocked by", "ACME-7"], ["duplicates", "ACME-8"], ["is cloned by", "ACME-7"], ["relates to", "ORBIT-1001"],
    ]);
    const files = await door(b, "card", { key: "ORBIT-1042" });
    expect(files.body.state).toMatchObject({ attachmentCount: 2, flagged: true });
    expect(files.body.untrusted.attachments.map((a: { name: string }) => a.name)).toEqual(["timeout-trace.png", "sync-log.txt"]);
    expect(files.body.untrusted.details.map((d: { label: string }) => d.label)).toContain("Reporter");
    expect(JSON.stringify(files.body.state)).not.toContain("timeout-trace");
    expect(JSON.stringify(files.body.state)).not.toContain("Impediment");
  });

  step("links: every web link of the card, one request, the pull requests counted in state and the titles under untrusted", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "links", { key: "ORBIT-1042" });
    expect(r.body.ok).toBe(true);
    expect(r.body.state).toEqual({ linkCount: 1, pullRequests: 1 });
    expect(r.body.untrusted.links).toEqual([{ id: "10200", title: "#2196 Fix the timeout", url: "https://github.com/acme/orbit/pull/2196", pullRequest: true }]);
    expect(b.fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /issue/ORBIT-1042/remotelink"]);
    expect((await door(b, "links", { key: "nope" })).body).toEqual({ ok: false, error: "That is not a Jira card id" });
  });

  step("activity: a page of the history, one request, its sentences under untrusted and where the next page starts in state", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "activity", { key: "ORBIT-1050" });
    expect(r.body.state).toEqual({ kind: "history", total: 230, shown: 100, next: 100 });
    expect(r.body.untrusted.events[0]).toMatchObject({ who: "Grace Sample", text: 'changed the Status from "To Do" to "In Progress"' });
    expect(JSON.stringify(r.body.state)).not.toContain("Status");
    expect(b.fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(["GET /issue/ORBIT-1050/changelog"]);
    const next = await door(b, "activity", { key: "ORBIT-1050", start: 200 });
    expect(next.body.state).toEqual({ kind: "history", total: 230, shown: 30 });
    expect((await door(b, "activity", { key: "ORBIT-1050", kind: "worklog" })).body.state).toMatchObject({ kind: "worklog", total: 25, shown: 25 });
    expect((await door(b, "activity", { key: "ORBIT-1050", kind: "everything" })).body).toEqual({ ok: false, error: "kind is one of history, worklog, comments" });
  });

  step("steps: which are on is state, what they write is untrusted", async () => {
    const r = await door(b, "steps");
    expect(r.body.state.steps).toEqual({ handoff: { enabled: true }, review: { enabled: false }, merge: { enabled: false } });
    expect(r.body.untrusted.steps.handoff.blocks.length).toBe(3);
    expect(JSON.stringify(r.body.state)).not.toContain("Opened");
  });

  step("writes off: step and link are refused with the route's own sentence, and the site never hears of them", async () => {
    b.fake.requests.length = 0;
    const route = await b.call("POST", "/jira/step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    const viaDoor = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(route.body).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    expect(viaDoor.status).toBe(route.status);
    expect(viaDoor.body).toEqual(route.body);
    const linkRoute = await b.call("POST", "/jira/link", { key: "ORBIT-1042", url: PR.url });
    const linkDoor = await door(b, "link", { key: "ORBIT-1042", url: PR.url });
    expect(linkDoor.body).toEqual(linkRoute.body);
    expect(linkDoor.body.error).toBe("Writing to Jira is switched off");
    // The switch is asked first, as on the screen, whatever else is wrong with the request.
    const bad = { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: { ...PR, url: "https://evil.example/acme/orbit/pull/1" } };
    expect((await door(b, "step", bad)).body).toEqual((await b.call("POST", "/jira/step", bad)).body);
    expect(writes(b).length).toBe(0);
  });

  step("a page from another origin can use none of it", async () => {
    expect((await b.call("POST", "/jira/writes", { on: true })).status).toBe(200);
    b.fake.requests.length = 0;
    const evil = { origin: "https://evil.example" };
    for (const verb of ["card", "moves", "links", "activity", "steps", "step", "link"]) expect((await door(b, verb, { key: "ORBIT-1042" }, evil)).status).toBe(403);
    expect(b.fake.requests.length).toBe(0);
  });

  step("step: a stamp that moved is a 409 and no write", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042") - 1000, trigger: "handoff", pr: PR });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, conflict: true });
    expect(writes(b).length).toBe(0);
  });

  step("step: lands as the route does, and its answer is shaped", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.state.moved).toBe(true);
    expect(r.body.untrusted).toMatchObject({ status: "In Review", was: "In Progress" });
    expect(JSON.stringify(r.body.state)).not.toContain("In Review");
    expect(writes(b).map((q) => q.path)).toEqual(["/issue/ORBIT-1042/transitions", "/issue/ORBIT-1042/comment", "/issue/ORBIT-1042/remotelink"]);
  });

  step("step: a pull request address that is not one on a known host is refused before any request, though only the comment would quote it", async () => {
    b.fake.requests.length = 0;
    for (const url of ["https://evil.example/acme/orbit/pull/1", "javascript:alert(1)", "http://github.com/acme/orbit/pull/1", "https://github.com@evil.example/acme/orbit/pull/1"]) {
      const r = await door(b, "step", { key: "ORBIT-1043", updated: stamp(b, "ORBIT-1043"), trigger: "handoff", pr: { ...PR, url } });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: "That is not a pull request address" });
    }
    expect(b.fake.requests.length).toBe(0);
  });

  step("step: the step list is the route's: a step that is not one is refused", async () => {
    const r = await door(b, "step", { key: "ORBIT-1043", updated: stamp(b, "ORBIT-1043"), trigger: "everything" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "That is not one of the steps" });
  });

  step("link: posts once, then reads the card's links and does not post again", async () => {
    b.fake.requests.length = 0;
    const url = "https://github.com/acme/orbit/pull/319";
    const first = await door(b, "link", { key: "ORBIT-1043", url, title: "Second export fix" });
    expect(first.body).toEqual({ ok: true, state: { linked: true, url } });
    const again = await door(b, "link", { key: "ORBIT-1043", url });
    expect(again.body).toEqual({ ok: true, state: { linked: false, url } });
    expect(writes(b).length).toBe(1);
  });

  step("link: an address that is not a pull request on a known host is refused before any request", async () => {
    b.fake.requests.length = 0;
    for (const url of ["https://evil.example/acme/orbit/pull/1", "file:///etc/passwd", "http://169.254.169.254/latest", "https://github.com/acme/orbit/issues/1"]) {
      const r = await door(b, "link", { key: "ORBIT-1043", url });
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
    }
    expect(b.fake.requests.length).toBe(0);
  });

  step("an unknown verb is a 404 and names the verbs", async () => {
    const r = await door(b, "delete", { key: "ORBIT-1042" });
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("card, moves, links, linktypes, activity, steps, step, link");
  });

  step("the action log names who asked, and the acting verb names the card", async () => {
    const rows = (await b.call("GET", "/actions?limit=50")).body.actions as { action: string; target: string; ok: boolean }[];
    const acted = rows.find((a) => a.action === "/jira/door/step" && a.ok);
    expect(acted?.target).toBe("as orchestrator · ORBIT-1042");
    // A read names who, not what was looked at.
    expect(rows.find((a) => a.action === "/jira/door/card")?.target).toBe("as orchestrator");
  });

  step("no answer carries the token", async () => {
    expect(b.seen()).not.toContain(FAKE_TOKEN);
    expect(b.seen()).not.toContain(BASE64);
  });
});

describe("the card door moves a card whose screen asks for fields", () => {
  const step = story();
  let b!: Booted;

  step("boot with writes on, and a move to Done that asks for a resolution and may take a comment", async () => {
    b = await boot({ ...ACTING, AGENTGLASS_JIRA_WRITE: "1" });
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    b.fake.state.workflow.transitions["2"]!.push({
      id: "51", name: "Finish", toStatusId: "5", requiredFields: [], acceptsAssignee: false,
      screen: [
        { key: "resolution", name: "Resolution", required: true, schema: { type: "resolution", system: "resolution" }, allowedValues: [{ id: "10000", name: "Done" }, { id: "10001", name: "Won't Do" }] },
        { key: "comment", name: "Comment", required: false, schema: { type: "comment", system: "comment" } },
      ],
    });
  });

  step("moves lists the screen under untrusted: the site's own words are data", async () => {
    const r = await door(b, "moves", { key: "ORBIT-1042" });
    const mv = (r.body.untrusted.moves as { id: string; fields?: { key: string; kind: string; required: boolean; choices?: { id: string }[] }[] }[]).find((m) => m.id === "51")!;
    expect(mv.fields!.map((f) => [f.key, f.kind, f.required])).toEqual([["resolution", "option", true], ["comment", "comment", false]]);
    expect(mv.fields![0]!.choices!.map((c) => c.id)).toEqual(["10000", "10001"]);
    expect(JSON.stringify(r.body.state)).not.toContain("Resolution");
  });

  step("move without the required field: a 400 with the sentence, and nothing is sent", async () => {
    b.fake.requests.length = 0;
    const r = await door(b, "move", { key: "ORBIT-1042", id: "51", updated: stamp(b, "ORBIT-1042") });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("That move needs Resolution");
    expect(writes(b).length).toBe(0);
  });

  step("a choice the site did not offer, and fields that are not a table: refused, nothing is sent", async () => {
    expect((await door(b, "move", { key: "ORBIT-1042", id: "51", updated: stamp(b, "ORBIT-1042"), fields: { resolution: "42" } })).body.error).toBe("Resolution is not one of the choices");
    expect((await door(b, "move", { key: "ORBIT-1042", id: "51", updated: stamp(b, "ORBIT-1042"), fields: "10000" })).body.error).toBe("fields must be an object of values by field key");
    expect(writes(b).length).toBe(0);
  });

  step("with the field and a comment: the card moves through the same route the form uses", async () => {
    const r = await door(b, "move", { key: "ORBIT-1042", id: "51", updated: stamp(b, "ORBIT-1042"), fields: { resolution: "10000", comment: "Shipped" } });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.state.moved).toBe(true);
    expect(b.fake.state.issues["ORBIT-1042"]!.statusId).toBe("5");
    expect(b.fake.state.issues["ORBIT-1042"]!.resolution).toBe("Done");
    // The stand-in shares its workflow with other files in this process: what this adds, it takes out.
    const list = b.fake.state.workflow.transitions["2"]!;
    list.splice(list.findIndex((t) => t.id === "51"), 1);
  });
});

describe("the card door, when a step lands short of the whole", () => {
  const step = story();
  let b!: Booted;

  step("boot with writes on and a handoff that moves, comments and links", async () => {
    b = await boot({ ...ACTING, AGENTGLASS_JIRA_WRITE: "1" });
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    const blocks = [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr}" }, { type: "link" }];
    expect((await b.call("POST", "/jira/steps", { steps: { handoff: { enabled: true, blocks } } })).status).toBe(200);
  });

  step("the move landed and the comment was refused: the answer says so, in the screen's sentence, under untrusted", async () => {
    b.fake.fail({ path: "/issue/ORBIT-1042/comment", method: "POST", status: 400, times: 1 });
    const r = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.state).toMatchObject({ moved: true, partial: true });
    expect(r.body.untrusted.partial).toBe("Moved to In Review, but the comment was not posted: Jira did not accept that comment");
    expect(JSON.stringify(r.body.state)).not.toContain("In Review");
  });

  step("a step that landed whole says nothing of the kind", async () => {
    const r = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.body.ok).toBe(true);
    expect(r.body.state.partial).toBeUndefined();
    expect(r.body.untrusted.partial).toBeUndefined();
  });

  step("two steps on one card at once: the second is refused by the lock the screen's route holds", async () => {
    b.fake.fail({ path: "/issue/ORBIT-1043*", delayMs: 300, times: 1 });
    const body = { key: "ORBIT-1043", updated: stamp(b, "ORBIT-1043"), trigger: "handoff", pr: PR };
    const both = await Promise.all([door(b, "step", body), door(b, "step", body)]);
    const refused = both.filter((r) => r.body.error === "A step is already running on ORBIT-1043: wait for it to finish");
    expect(refused.length).toBe(1);
    expect(refused[0]!.status).toBe(400);
  });
});

describe("the card door at the level a server starts with", () => {
  const step = story();
  let b!: Booted;

  step("boot at the default level with Jira writes on", async () => {
    b = await boot({ AGENTGLASS_JIRA_WRITE: "1" });
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    const blocks = [{ type: "move", statusNames: ["In Review"] }, { type: "comment", text: "Opened {pr}" }, { type: "link" }];
    expect((await b.call("POST", "/jira/steps", { steps: { handoff: { enabled: true, blocks } } })).status).toBe(200);
  });

  step("the reads are open, and say a write would be accepted by the site's switch", async () => {
    const card = await door(b, "card", { key: "ORBIT-1042" });
    expect(card.body.ok).toBe(true);
    expect(card.body.state.writes).toBe(true);
    expect((await door(b, "moves", { key: "ORBIT-1042" })).body.ok).toBe(true);
    expect((await door(b, "steps")).body.ok).toBe(true);
  });

  step("step and link are refused with one sentence that names both things the owner turns on, and the site hears nothing", async () => {
    b.fake.requests.length = 0;
    const s = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    const l = await door(b, "link", { key: "ORBIT-1042", url: PR.url });
    for (const [verb, r] of [["step", s], ["link", l]] as const) {
      expect(r.status).toBe(403);
      expect(r.body).toEqual({
        ok: false,
        error: `${verb} changes a card on a Jira site, which the agent door does only at control level 3 with writing to Jira switched on, and this server allows up to level 2. Both are the owner's settings, the level made when the server starts; ask the person who runs agentglass if you need it, and do not try to change them.`,
      });
    }
    expect(b.fake.requests.length).toBe(0);
    expect(b.fake.state.issues["ORBIT-1042"]!.statusId).toBe("2");
  });

  step("the refusal is in the action log, with who asked and which card", async () => {
    const rows = (await b.call("GET", "/actions?limit=50")).body.actions as { action: string; target: string; ok: boolean; detail: string | null }[];
    const refused = rows.find((a) => a.action === "/jira/door/step");
    expect(refused).toMatchObject({ ok: false, target: "as orchestrator · ORBIT-1042", detail: "level" });
  });

  step("the screen's own route is not the door: the person's press still runs the step", async () => {
    const r = await b.call("POST", "/jira/step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    expect(r.body.ok).toBe(true);
  });
});

describe("the card door on a server held read-only", () => {
  const step = story();
  let b!: Booted;

  step("reads work, acting verbs are refused whatever the Jira switch says, and nothing is sent", async () => {
    b = await boot({ AGENTGLASS_CONTROL_READONLY: "1", AGENTGLASS_JIRA_WRITE: "1" });
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    expect((await door(b, "card", { key: "ORBIT-1042" })).body.ok).toBe(true);
    b.fake.requests.length = 0;
    const s = await door(b, "step", { key: "ORBIT-1042", updated: stamp(b, "ORBIT-1042"), trigger: "handoff", pr: PR });
    const l = await door(b, "link", { key: "ORBIT-1042", url: PR.url });
    expect(s.status).toBe(403);
    expect(l.status).toBe(403);
    expect(s.body.error).toBe("step changes a card on a Jira site, which the agent door does only at control level 3 with writing to Jira switched on, and the owner has made this server read-only (opens and reads only). Both are the owner's settings, the level made when the server starts; ask the person who runs agentglass if you need it, and do not try to change them.");
    expect(b.fake.requests.length).toBe(0);
  });
});

// ── the CLI and the MCP twin ───────────────────────────────────────────────

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;
const CLI = BIN("agentglass-ui");
const MCP = BIN("agentglass-ui-mcp");

/** A snippet run with a bin file loaded as a module (its main does not run); data comes in as JSON on `D`. */
function py(file: string, body: string, data: unknown = null): any {
  const src = `
import json, sys
ns = {"__name__": "probe", "__file__": ${JSON.stringify(file)}}
exec(compile(open(${JSON.stringify(file)}).read(), ${JSON.stringify(file)}, "exec"), ns)
D = json.loads(sys.stdin.read())
g = ns
${body}
`;
  const p = Bun.spawnSync(["python3", "-c", src], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", AGENTGLASS_SERVER: "http://127.0.0.1:1" },
    stdin: new TextEncoder().encode(JSON.stringify(data)), stdout: "pipe", stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
}

describe.skipIf(!HAVE_PY)("the card verbs, as pure functions", () => {
  const body = (verb: string, given: unknown, as?: string) => py(CLI, "print(json.dumps(g['jira_body'](D[0], D[1], D[2])))", [verb, given, as ?? null]) as [Record<string, any> | null, string | null];

  test("the CLI's verbs are the server's, no more and no fewer", () => {
    expect(py(CLI, "print(json.dumps(list(g['JIRA_VERBS'])))")).toEqual([...DOOR_VERBS]);
    const acting = py(CLI, "print(json.dumps([k for k, v in g['JIRA_VERBS'].items() if v['acting']]))");
    expect(acting).toEqual(["step", "link", "edit", "comment", "comment-edit", "comment-delete", "move", "subtask", "relate", "unrelate", "weblink", "unweblink", "worklog", "worklog-edit", "worklog-delete", "watch", "vote"]);
  });

  test("a step's choice and pull request travel nested, as the route reads them, and the name is stamped", () => {
    const [b, why] = body("step", { key: "ORBIT-1042", trigger: "handoff", updated: "1768294800000", to: "In Review", stay: "true", pr_url: "https://github.com/acme/orbit/pull/318", pr_number: "318" }, "orchestrator");
    expect(why).toBeNull();
    expect(b).toEqual({
      key: "ORBIT-1042", trigger: "handoff", updated: 1768294800000, as: "orchestrator",
      choice: { to: "In Review", stay: true }, pr: { url: "https://github.com/acme/orbit/pull/318", number: 318 },
    });
  });

  test("a move's fields travel as one object, from JSON text or an object, and anything else is a sentence", () => {
    const want = { key: "ORBIT-1042", id: "51", updated: 5, fields: { resolution: "10000", comment: "Shipped" } };
    expect(body("move", { key: "ORBIT-1042", id: "51", updated: "5", fields: '{"resolution":"10000","comment":"Shipped"}' })[0]).toEqual(want);
    expect(body("move", { key: "ORBIT-1042", id: "51", updated: 5, fields: { resolution: "10000", comment: "Shipped" } })[0]).toEqual(want);
    expect(body("move", { key: "ORBIT-1042", id: "51", updated: 5, fields: "not json" })[1]).toBe("fields must be a JSON object by field key");
    expect(body("move", { key: "ORBIT-1042", id: "51", updated: 5, fields: "[1]" })[1]).toBe("fields must be a JSON object by field key");
    expect(body("card", { key: "ORBIT-1042", fields: {} })[1]).toBe("card takes key, not fields");
  });

  test("a missing, unknown or mistyped argument is one sentence and no request", () => {
    expect(body("card", {})[1]).toBe("card needs key (a card id such as ORBIT-1042)");
    expect(body("card", { key: "ORBIT-1042", url: "x" })[1]).toBe("card takes key, not url");
    expect(body("step", { key: "ORBIT-1042", trigger: "handoff", updated: "soon" })[1]).toBe("updated must be a whole number");
    expect(body("step", { key: "ORBIT-1042", trigger: "handoff", updated: 5, stay: "maybe" })[1]).toBe("stay must be true or false");
    expect(body("delete", { key: "ORBIT-1042" })[1]).toContain("is not a card verb");
  });

  test("the MCP twin lists one tool per verb, reads marked read-only, acting ones not", () => {
    const tools = py(MCP, "print(json.dumps(g['jira_tools']()))") as { name: string; annotations: { readOnlyHint: boolean }; inputSchema: { required: string[] } }[];
    expect(tools.map((t) => t.name)).toEqual(DOOR_VERBS.map((v) => `ui_jira_${v}`));
    expect(Object.fromEntries(tools.map((t) => [t.name, t.annotations.readOnlyHint]))).toEqual({ ui_jira_card: true, ui_jira_moves: true, ui_jira_links: true, ui_jira_linktypes: true, ui_jira_activity: true, ui_jira_steps: true, ui_jira_step: false, ui_jira_link: false, ui_jira_edit: false, ui_jira_comment: false, "ui_jira_comment-edit": false, "ui_jira_comment-delete": false, ui_jira_move: false, ui_jira_subtask: false, ui_jira_relate: false, ui_jira_unrelate: false, ui_jira_weblink: false, ui_jira_unweblink: false, ui_jira_worklog: false, "ui_jira_worklog-edit": false, "ui_jira_worklog-delete": false, ui_jira_watch: false, ui_jira_vote: false });
    expect(tools.find((t) => t.name === "ui_jira_step")!.inputSchema.required).toEqual(["key", "trigger", "updated"]);
  });

  test("below level 3 the MCP twin lists the reads only, and a step is marked as able to take something away", () => {
    for (const level of [1, 2]) expect((py(MCP, "print(json.dumps(g['jira_tools'](D)))", level) as { name: string }[]).map((t) => t.name)).toEqual(["ui_jira_card", "ui_jira_moves", "ui_jira_links", "ui_jira_linktypes", "ui_jira_activity", "ui_jira_steps"]);
    const at3 = py(MCP, "print(json.dumps(g['jira_tools'](3)))") as { name: string; annotations: { destructiveHint: boolean } }[];
    expect(Object.fromEntries(at3.map((t) => [t.name, t.annotations.destructiveHint]))).toEqual({ ui_jira_card: false, ui_jira_moves: false, ui_jira_links: false, ui_jira_linktypes: false, ui_jira_activity: false, ui_jira_steps: false, ui_jira_step: true, ui_jira_link: false, ui_jira_edit: false, ui_jira_comment: false, "ui_jira_comment-edit": false, "ui_jira_comment-delete": true, ui_jira_move: false, ui_jira_subtask: false, ui_jira_relate: false, ui_jira_unrelate: true, ui_jira_weblink: false, ui_jira_unweblink: true, ui_jira_worklog: false, "ui_jira_worklog-edit": false, "ui_jira_worklog-delete": true, ui_jira_watch: false, ui_jira_vote: false });
  });
});

describe.skipIf(!HAVE_PY)("the CLI and the MCP twin against a running app", () => {
  const step = story();
  let b!: Booted;
  const env = () => ({ PATH: process.env.PATH ?? "", HOME: b.dir, XDG_CONFIG_HOME: b.dir, AGENTGLASS_SERVER: b.base, AGENTGLASS_TOKEN: TOKEN });
  async function cli(...args: string[]) {
    const p = Bun.spawn(["python3", CLI, "--as", "orbit-cli", ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out: out.trim() ? JSON.parse(out) : null, err, code };
  }

  step("boot and connect", async () => {
    b = await boot(ACTING);
    expect((await b.call("POST", "/jira/connect", { email: FAKE_EMAIL, site: "acme.atlassian.net", token: FAKE_TOKEN })).status).toBe(200);
    expect((await b.call("POST", "/jira/steps", { steps: { handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["In Review"] }, { type: "link" }] } } })).status).toBe(200);
  });

  step("jira card: the words are under untrusted, exit 0", async () => {
    const r = await cli("jira", "card", "ORBIT-1042");
    expect(r.code).toBe(0);
    expect(r.out.untrusted.title).toBe("Fix timeout when syncing the board");
    expect(JSON.stringify(r.out.state)).not.toContain("Fix timeout");
  });

  step("jira moves and steps read through the same door", async () => {
    expect((await cli("jira", "moves", "ORBIT-1042")).out.state.moves.length).toBeGreaterThan(0);
    expect((await cli("jira", "steps")).out.state.steps.handoff).toEqual({ enabled: true });
  });

  step("writes off: step and link exit 1 with the screen's sentence, and the site hears nothing", async () => {
    b.fake.requests.length = 0;
    const s = await cli("jira", "step", "ORBIT-1042", "handoff", "--updated", String(stamp(b, "ORBIT-1042")), "--pr-url", PR.url);
    const l = await cli("jira", "link", "ORBIT-1042", PR.url);
    for (const r of [s, l]) {
      expect(r.code).toBe(1);
      expect(r.out).toEqual({ ok: false, error: "Writing to Jira is switched off" });
    }
    expect(writes(b).length).toBe(0);
  });

  step("a mistyped argument stops in the CLI, before any request", async () => {
    b.fake.requests.length = 0;
    const r = await cli("jira", "step", "ORBIT-1042", "handoff", "--updated", "soon");
    expect(r.code).toBe(1);
    expect(r.out.error).toBe("updated must be a whole number");
    expect(b.fake.requests.length).toBe(0);
  });

  step("writes on: the CLI runs the step and the link, and the log names orbit-cli", async () => {
    expect((await b.call("POST", "/jira/writes", { on: true })).status).toBe(200);
    b.fake.requests.length = 0;
    const s = await cli("jira", "step", "ORBIT-1042", "handoff", "--updated", String(stamp(b, "ORBIT-1042")), "--pr-url", PR.url);
    expect(s.code).toBe(0);
    expect(s.out.untrusted.status).toBe("In Review");
    expect(writes(b).map((q) => q.path)).toEqual(["/issue/ORBIT-1042/transitions", "/issue/ORBIT-1042/remotelink"]);
    const l = await cli("jira", "link", "ORBIT-1043", "https://github.com/acme/orbit/pull/320");
    expect(l.out).toEqual({ ok: true, state: { linked: true, url: "https://github.com/acme/orbit/pull/320" } });
    const rows = (await b.call("GET", "/actions?limit=50")).body.actions as { action: string; target: string }[];
    expect(rows.find((a) => a.action === "/jira/door/link")?.target).toBe("as orbit-cli · ORBIT-1043");
  });

  step("the MCP server lists the card tools and runs one, with the name it was given", async () => {
    const p = Bun.spawn(["python3", MCP], { env: { ...env(), AGENTGLASS_UI_AS: "orbit-mcp" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: string[] = [];
    void (async () => { for await (const c of p.stdout as unknown as AsyncIterable<Uint8Array>) lines.push(...new TextDecoder().decode(c).split("\n").filter(Boolean)); })();
    const send = (m: unknown) => { (p.stdin as { write(s: string): void }).write(JSON.stringify(m) + "\n"); };
    const reply = async (id: number) => {
      for (let i = 0; i < 100; i++) { const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id); if (hit) return hit; await Bun.sleep(50); }
      throw new Error("no reply " + id);
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = (await reply(1)).result.tools.map((t: { name: string }) => t.name);
      for (const v of DOOR_VERBS) expect(names).toContain(`ui_jira_${v}`);
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ui_jira_card", arguments: { key: "ORBIT-1042" } } });
      const card = JSON.parse((await reply(2)).result.content[0].text);
      expect(card.ok).toBe(true);
      expect(card.untrusted.title).toBe("Fix timeout when syncing the board");
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ui_jira_link", arguments: { key: "ORBIT-1043", url: "https://evil.example/acme/orbit/pull/1" } } });
      const refused = await reply(3);
      expect(refused.result.isError).toBe(true);
      expect(JSON.parse(refused.result.content[0].text).ok).toBe(false);
      const rows = (await b.call("GET", "/actions?limit=50")).body.actions as { action: string; target: string }[];
      expect(rows.some((a) => a.action === "/jira/door/card" && a.target === "as orbit-mcp")).toBe(true);
    } finally { try { p.kill(); } catch { /* gone */ } }
  });

  step("no answer carries the token", async () => {
    expect(b.seen()).not.toContain(FAKE_TOKEN);
    expect(b.seen()).not.toContain(TOKEN);
  });
});
