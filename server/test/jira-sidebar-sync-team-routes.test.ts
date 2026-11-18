/*
 * The Jira sidebar's sync and team routes, through a real server against the stand-in site: the favourite filters, the
 * counts for a team member or an unsaved favourite, and the local saved-query operations (edit, duplicate, save a
 * search). What matters: nothing here writes to Jira, a foreign origin cannot change the address book, and the token
 * never appears in an answer.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_TOKEN, startFakeJira, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-sidebar-routes";
const SITE = "acme.atlassian.net";

describe("the sidebar's sync, team and saved-query routes", () => {
  let dir = "", base = "";
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let fake: FakeJira;
  let output = "";
  let seen = "";
  const step = story();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-jira-sidebar-r3-"));
    mkdirSync(join(dir, "agentglass"), { recursive: true });
    fake = startFakeJira({ flavor: "cloud" });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
        AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "r.db"), AGENTGLASS_TOKEN: TOKEN,
        AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_JIRA_BASE: fake.base,
      },
      stdout: "pipe", stderr: "pipe",
    });
    for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) throw new Error("the server did not come up: " + output.slice(0, 400));
  }, SERVER_BOOT_MS);

  afterAll(async () => {
    try { proc?.kill(); } catch { /* already gone */ }
    await fake?.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  // The person speaks from the app window, so every call names the server's own origin (the machine token alone is every agent shell).
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", get origin() { return base; } };
  const get = async (path: string) => {
    const r = await fetch(base + path, { headers });
    const text = await r.text();
    seen += text;
    return { status: r.status, body: JSON.parse(text) as Record<string, any> };
  };
  const post = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const text = await r.text();
    seen += text;
    return { status: r.status, body: JSON.parse(text) as Record<string, any> };
  };
  const reads = () => fake.requests.filter((r) => r.path === "/search/jql").length;

  step("not connected: the favourites are a sentence and nothing is sent", async () => {
    const r = await get("/jira/favourites");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, error: "Jira is not connected" });
    expect(fake.requests.length).toBe(0);
  });

  step("connect", async () => {
    const c = await fetch(base + "/jira/connect", { method: "POST", headers, body: JSON.stringify({ email: FAKE_EMAIL, site: SITE, token: FAKE_TOKEN }) });
    expect(c.status).toBe(200);
  });

  step("a site that fails to answer is a sentence, not remembered, and carries no token", async () => {
    fake.fail({ path: "/filter/favourite", status: 500 });
    const r = await get("/jira/favourites");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(typeof r.body.error).toBe("string");
    expect(r.body.filters).toBeUndefined();
    fake.reset();
    fake.requests.length = 0;
  });

  step("the favourites are exactly the three the site marks, with their searches", async () => {
    // reset() dropped the connection's stand-in state; the stored credentials are the server's own.
    const r = await get("/jira/favourites");
    expect(r.body.ok).toBe(true);
    expect(r.body.filters.map((f: any) => f.name)).toEqual(["Orbit bugs", "Everything", "Needs QA review"]);
    expect(r.body.filters.map((f: any) => f.id)).toEqual(["10020", "10030", "10050"]);
    expect(r.body.filters[2]).toEqual({ id: "10050", name: "Needs QA review", jql: "project = ORBIT AND status = QA" });
    expect(fake.requests.every((q) => q.method === "GET")).toBe(true);
    // The view-choices list still does not carry the searches.
    const c = await get("/jira/view-choices");
    expect(c.body.filters.every((f: any) => f.jql === undefined)).toBe(true);
    expect(seen).not.toContain(FAKE_TOKEN);
  });

  step("a team member's count is a bounded search written from the id", async () => {
    fake.requests.length = 0;
    const mine = await get("/jira/view-count?id=assignee:acc-0001");
    const other = await get("/jira/view-count?id=assignee:acc-0003");
    const full = await get(`/jira/jql?q=${encodeURIComponent('assignee = "acc-0001"')}`);
    expect(mine.body.ok).toBe(true);
    expect(mine.body.count).toBeGreaterThan(0);
    expect(mine.body.count).toBe(full.body.tasks.length);
    expect(other.body.count).not.toBe(mine.body.count);
    const before = reads();
    await get("/jira/view-count?id=assignee:acc-0001");
    expect(reads()).toBe(before);
  });

  step("an id that could smuggle a query is refused before any search", async () => {
    fake.requests.length = 0;
    for (const id of ['assignee:x" OR project = ACME', "assignee:a b", "assignee:", `assignee:${"x".repeat(129)}`, "filter:1; DROP", "filter:"]) {
      const r = await get(`/jira/view-count?id=${encodeURIComponent(id)}`);
      expect(r.body).toMatchObject({ ok: false });
    }
    expect(reads()).toBe(0);
  });

  step("a favourite that is not saved counts through its filter", async () => {
    const n = await get("/jira/view-count?id=filter:10050");
    const direct = await get(`/jira/jql?q=${encodeURIComponent("project = ORBIT AND status = QA")}`);
    expect(n.body.ok).toBe(true);
    expect(n.body.count).toBe(direct.body.tasks.length);
    expect((await get("/jira/views")).body.views.map((v: any) => v.id)).toEqual(["me:assigned"]);
  });

  step("save a search: local, named, and the open view does not move", async () => {
    fake.requests.length = 0;
    const r = await post("/jira/views/save-jql", { jql: "project = ORBIT AND issuetype = Bug", name: "Orbit bugs to triage" });
    expect(r.status).toBe(200);
    expect(r.body.view).toMatchObject({ name: "Orbit bugs to triage", url: `https://${SITE}/issues/?jql=${encodeURIComponent("project = ORBIT AND issuetype = Bug")}` });
    expect(r.body.view.id).toMatch(/^jql:/);
    const v = await get("/jira/views");
    expect(v.body.views.map((x: any) => x.id)).toEqual(["me:assigned", r.body.view.id]);
    expect(v.body.current).toBeUndefined();
    // Saved again with another name: the same row, renamed.
    const again = await post("/jira/views/save-jql", { jql: "project = ORBIT AND issuetype = Bug", name: "Bugs" });
    expect(again.body.view.id).toBe(r.body.view.id);
    expect((await get("/jira/views")).body.views.length).toBe(2);
    expect((await post("/jira/views/save-jql", { jql: "ORDER BY created" })).status).toBe(400);
    expect((await post("/jira/views/save-jql", { jql: "" })).status).toBe(400);
    expect(fake.requests.filter((q) => q.method !== "GET").length).toBe(0);
  });

  step("edit: rename, share with the team, change the search; the id stays", async () => {
    const id = (await get("/jira/views")).body.views[1].id as string;
    expect((await post("/jira/views/edit", { id, name: "Open bugs" })).body.view).toMatchObject({ id, name: "Open bugs" });
    expect((await post("/jira/views/edit", { id, team: true })).body.view).toMatchObject({ id, team: true, name: "Open bugs" });
    const j = await post("/jira/views/edit", { id, jql: "project = ORBIT AND assignee = currentUser()" });
    expect(j.body.view.id).toBe(id);
    expect(j.body.view.url).toBe(`https://${SITE}/issues/?jql=${encodeURIComponent("project = ORBIT AND assignee = currentUser()")}`);
    expect(j.body.view.team).toBe(true);
    expect((await post("/jira/views/edit", { id, team: false })).body.view.team).toBeUndefined();
    expect((await get("/jira/views")).body.views[1]).toMatchObject({ id, name: "Open bugs" });
    // Refused: empty patch, a blank name, an unbounded search, the built-in, something not saved.
    for (const b of [{ id }, { id, name: "  " }, { id, jql: "ORDER BY rank" }, { id: "me:assigned", name: "x" }, { id: "jql:nope", name: "x" }, { id, team: "yes" }]) {
      expect((await post("/jira/views/edit", b)).status).toBe(400);
    }
    expect(fake.requests.filter((q) => q.method !== "GET").length).toBe(0);
  });

  step("duplicate: a copy under a fresh id; a filter becomes the search that reads it; a board cannot", async () => {
    const id = (await get("/jira/views")).body.views[1].id as string;
    const a = await post("/jira/views/duplicate", { id });
    const b = await post("/jira/views/duplicate", { id });
    expect(a.body.view.name).toBe("Open bugs (copy)");
    expect(new Set([id, a.body.view.id, b.body.view.id]).size).toBe(3);
    expect(a.body.view.url).toBe((await get("/jira/views")).body.views.find((x: any) => x.id === id).url);
    await post("/jira/views/add", { kind: "filter", id: "10020" });
    const f = await post("/jira/views/duplicate", { id: "filter:10020" });
    expect(f.body.view).toMatchObject({ name: "Orbit bugs (copy)", url: `https://${SITE}/issues/?jql=${encodeURIComponent("filter = 10020")}` });
    await post("/jira/views/add", { kind: "board", id: "1" });
    expect((await post("/jira/views/duplicate", { id: "board:1" })).status).toBe(400);
    expect((await post("/jira/views/duplicate", { id: "me:assigned" })).status).toBe(400);
  });

  step("none of it wrote to Jira, and a page from another origin changes nothing", async () => {
    expect(fake.requests.filter((q) => q.method !== "GET" && !q.path.endsWith("/search/jql")).length).toBe(0);
    const before = (await get("/jira/views")).body.views.length;
    const evil = { origin: "https://evil.example" };
    for (const [p, b] of [["/jira/views/edit", { id: "board:1", name: "x" }], ["/jira/views/duplicate", { id: "board:1" }], ["/jira/views/save-jql", { jql: "project = ORBIT" }]] as const) {
      expect((await post(p, b, evil)).status).toBe(403);
    }
    expect((await get("/jira/views")).body.views.length).toBe(before);
    expect(seen).not.toContain(FAKE_TOKEN);
  });
});
