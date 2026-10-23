/*
 * The saved-view routes, through a real server, against both personalities of
 * the stand-in. What is asserted is what a browser or a phone would see: the
 * answers, the status codes, the request count at the site, and that a page
 * from another origin cannot change the address book.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { FAKE_EMAIL, FAKE_PAT, FAKE_TOKEN, startFakeJira, type FakeFlavor, type FakeJira } from "./fixtures/fakeJira.ts";

const TOKEN = "machine-token-for-the-jira-views";
const SITES: Record<FakeFlavor, string> = { cloud: "acme.atlassian.net", datacenter: "jira.acme.example" };

for (const flavor of ["cloud", "datacenter"] as const) {
  describe(`the saved-view routes, ${flavor}`, () => {
    const site = SITES[flavor];
    const searchPath = flavor === "cloud" ? "/search/jql" : "/search";
    let dir = "", base = "";
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let fake: FakeJira;
    let output = "";
    let seen = "";
    const step = story();

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), `agx-jira-views-routes-${flavor}-`));
      mkdirSync(join(dir, "agentglass"), { recursive: true });
      fake = startFakeJira({ flavor });
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
        env: {
          PATH: process.env.PATH ?? "",
          TMUX_TMPDIR: TMUX_TEST_TMPDIR,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CACHE_HOME: join(dir, "cache"),
          AGENTGLASS_STATE_DIR: `${dir}/state`,
          AGENTGLASS_ROOT: dir,
          AGENTGLASS_DB: join(dir, "r.db"),
          AGENTGLASS_TOKEN: TOKEN,
          AGENTGLASS_SCAN_DISABLED: "1",
          AGENTGLASS_PORT: String(port),
          AGENTGLASS_JIRA_BASE: fake.base,
        },
        stdout: "pipe", stderr: "pipe",
      });
      for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) {
        void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
      }
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

    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
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
    const count = (p: string | RegExp) => fake.requests.filter((r) => (typeof p === "string" ? r.path === p : p.test(r.path))).length;

    step("not connected: every read is a sentence, nothing is sent", async () => {
      expect((await get("/jira/views")).body).toEqual({ connected: false, site: null, views: [], folders: [] });
      for (const p of ["/jira/view", "/jira/view?id=board:1", "/jira/view?cached=1", "/jira/view-choices", "/jira/project-choices"]) {
        const r = await get(p);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: false, error: "Jira is not connected" });
      }
      expect((await post("/jira/views/add", { kind: "board", id: "1" })).body).toMatchObject({ ok: false, error: "Jira is not connected" });
      expect(fake.requests.length).toBe(0);
    });

    step("connect; the rail is the built-in view alone and costs nothing", async () => {
      const c = await fetch(base + "/jira/connect", {
        method: "POST", headers,
        body: JSON.stringify(flavor === "cloud" ? { email: FAKE_EMAIL, site, token: FAKE_TOKEN } : { site, token: FAKE_PAT }),
      });
      expect(c.status).toBe(200);
      fake.requests.length = 0;
      const v = await get("/jira/views");
      expect(v.body).toMatchObject({ connected: true, site, folders: [] });
      expect(v.body.views.map((x: any) => x.id)).toEqual(["me:assigned"]);
      expect(v.body.views[0]).toMatchObject({ builtin: true, url: "" });
      expect(fake.requests.length).toBe(0);
    });

    step("the list to add from: boards and favourites, then projects", async () => {
      const c = await get("/jira/view-choices");
      expect(c.body.ok).toBe(true);
      expect(c.body.boards.map((b: any) => b.id)).toEqual(["1", "2", "3", "4"]);
      expect(c.body.filters.map((f: any) => f.id)).toEqual(["10020", "10030"]);
      expect(count(/^\/rest\/agile\/1\.0\/board$/)).toBe(1);
      expect((await get("/jira/view-choices?q=sprint")).body.boards.map((b: any) => b.id)).toEqual(["2", "3"]);
      const p = await get("/jira/project-choices");
      expect(p.body).toMatchObject({ ok: true, projects: [{ key: "ORBIT", name: "Orbit" }, { key: "ACME", name: "Acme Platform" }] });
    });

    step("add a board by its address, read it, and it is the current one", async () => {
      const a = await post("/jira/views/add", { url: `https://${site}/jira/software/c/projects/ORBIT/boards/1` });
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ ok: true, view: { id: "board:1", name: "ORBIT board" } });
      const v = await get("/jira/views");
      expect(v.body.views.map((x: any) => x.id)).toEqual(["me:assigned", "board:1"]);
      expect(v.body.current).toBe("board:1");

      fake.requests.length = 0;
      const r = await get("/jira/view?id=board:1");
      expect(r.body.ok).toBe(true);
      expect(r.body.columns.map((c: any) => c.name)).toEqual(["Backlog", "To Do", "Doing", "QA", "Done"]);
      expect(r.body.tasks.map((t: any) => t.customId).sort()).toEqual(["ORBIT-1001", "ORBIT-1042", "ORBIT-1043", "ORBIT-1044", "ORBIT-1045", "ORBIT-1046", "ORBIT-1050"]);
      expect(count(searchPath)).toBe(2);
      expect(count(/agile\/1\.0\/board\/\d+\/issue/)).toBe(0);
    });

    step("asked again it is held; cached=1 asks nobody; force asks the search only", async () => {
      fake.requests.length = 0;
      expect((await get("/jira/view?id=board:1")).body.ok).toBe(true);
      expect((await get("/jira/view?id=board:1&cached=1")).body).toMatchObject({ ok: true, cached: true });
      expect(fake.requests.length).toBe(0);
      expect((await get("/jira/view?id=board:1&force=1")).body.ok).toBe(true);
      expect(fake.requests.filter((r) => r.path !== searchPath).length).toBe(0);
      expect(count(searchPath)).toBe(2);
      // No id: the current one.
      expect((await get("/jira/view?cached=1")).body.view.id).toBe("board:1");
    });

    step("a refused address is a 400 with a sentence and no request", async () => {
      fake.requests.length = 0;
      const a = await post("/jira/views/add", { url: "https://evil.example/issues/?filter=10020" });
      expect(a.status).toBe(400);
      expect(a.body.ok).toBe(false);
      expect((await post("/jira/views/add", { url: `https://${site}/browse/ORBIT-1` })).body.error).toContain("?filter=10000");
      expect((await post("/jira/views/add", { kind: "filter", id: "10040" })).body.error).toBe("That saved filter is not shared with you, or it is gone");
      expect((await post("/jira/views/add", { kind: "board", id: "1; DROP" })).status).toBe(400);
      expect(fake.requests.filter((r) => r.path.startsWith("/rest/agile") && r.path.includes("DROP")).length).toBe(0);
      expect(count(searchPath)).toBe(0);
    });

    step("a filter by pick, an unbounded one reads as a sentence", async () => {
      expect((await post("/jira/views/add", { kind: "filter", id: "10020" })).body).toMatchObject({ ok: true, view: { id: "filter:10020" } });
      expect((await get("/jira/view?id=filter:10020")).body.tasks.map((t: any) => t.customId)).toEqual(["ORBIT-1001", "ORBIT-1046"]);
      await post("/jira/views/add", { kind: "filter", id: "10030" });
      const before = count(searchPath);
      const r = await get("/jira/view?id=filter:10030");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: false, tasks: [] });
      expect(r.body.error).toContain("no restriction");
      expect(count(searchPath)).toBe(before);
    });

    step("a project as a folder, its boards on the rail", async () => {
      const a = await post("/jira/folders/add", { key: "ACME" });
      expect(a.body).toMatchObject({ ok: true, folder: { id: "ACME", lists: [{ id: "2" }, { id: "4" }] } });
      const v = await get("/jira/views");
      expect(v.body.folders.map((f: any) => f.id)).toEqual(["ACME"]);
      expect(v.body.views.filter((x: any) => x.folderId === "ACME").map((x: any) => x.id)).toEqual(["board:2", "board:4"]);
      expect((await post("/jira/folders/add", { key: "NOPE" })).status).toBe(400);
    });

    step("a page from another origin cannot change the address book", async () => {
      const evil = { origin: "https://evil.example" };
      for (const [p, b] of [["/jira/views/add", { kind: "board", id: "3" }], ["/jira/views/remove", { id: "board:1" }], ["/jira/folders/add", { key: "ORBIT" }], ["/jira/folders/remove", { id: "ACME" }]] as const) {
        const r = await post(p, b, evil);
        expect(r.status).toBe(403);
      }
      const v = await get("/jira/views");
      expect(v.body.views.map((x: any) => x.id)).toContain("board:1");
      expect(v.body.folders.map((f: any) => f.id)).toEqual(["ACME"]);
    });

    step("remove a view and a folder; the built-in cannot go", async () => {
      expect((await post("/jira/views/remove", { id: "board:1" })).body).toEqual({ ok: true });
      expect((await post("/jira/views/remove", { id: "me:assigned" })).body).toEqual({ ok: true });
      expect((await post("/jira/folders/remove", { id: "ACME" })).body).toEqual({ ok: true });
      const v = await get("/jira/views");
      expect(v.body.views.map((x: any) => x.id)).toEqual(["me:assigned", "filter:10020", "filter:10030"]);
      expect(v.body.folders).toEqual([]);
      expect((await get("/jira/view?id=board:1")).body).toMatchObject({ ok: false, error: "That view is not saved any more" });
    });

    step("Jira was only read: no write reached it; ClickUp's file was never made; no token leaked", () => {
      expect(fake.requests.filter((r) => r.method !== "GET" && r.path !== searchPath && r.path !== "/search").length).toBe(0);
      expect(existsSync(join(dir, "agentglass", "clickup-views.json"))).toBe(false);
      expect(existsSync(join(dir, "agentglass", "jira-views.json"))).toBe(true);
      for (const s of [FAKE_TOKEN, FAKE_PAT, Buffer.from(`${FAKE_EMAIL}:${FAKE_TOKEN}`).toString("base64")]) {
        expect(seen.includes(s)).toBe(false);
        expect(output.includes(s)).toBe(false);
      }
    });
  });
}
