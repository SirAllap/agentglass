/*
 * The board's saved filter views: the file, the validation, and the route.
 *
 * What is asserted is that nothing malformed reaches disk, that "never saved"
 * and "saved empty" read differently (the window imports its old presets only
 * for the first), and that a page on another origin cannot write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as V from "../src/prViews.ts";
import { emptyLanes, type PrView } from "../../shared/prFilter.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-pr-views-"));
const file = join(dir, "pr-views.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const view = (id: string, name: string, order = 0): PrView => {
  const filter = emptyLanes();
  filter.show.children.push({ id: "r1", field: "text", op: "contains", values: ["BETA"] });
  return { id, name, filter, order };
};

describe("the store", () => {
  beforeEach(() => { rmSync(file, { force: true }); V.__setViewsPath(file); });
  afterAll(() => V.__setViewsPath(null));

  test("a repository never saved is not the same as one saved empty", () => {
    expect(V.viewsFor("acme/orbit")).toEqual({ views: [], saved: false });
    expect(V.setViewsFor("acme/orbit", []).ok).toBe(true);
    expect(V.viewsFor("acme/orbit")).toEqual({ views: [], saved: true });
  });

  test("a list round-trips, is renumbered by position, and keeps repositories apart", () => {
    expect(V.setViewsFor("acme/orbit", [view("a", "Main", 7), view("b", "QA", 7)]).ok).toBe(true);
    expect(V.setViewsFor("acme/relay", [view("c", "Mine")]).ok).toBe(true);
    expect(V.viewsFor("acme/orbit").views.map((v) => [v.name, v.order])).toEqual([["Main", 0], ["QA", 1]]);
    expect(V.viewsFor("acme/relay").views.map((v) => v.name)).toEqual(["Mine"]);
  });

  test("a refusal writes nothing and says why", () => {
    V.setViewsFor("acme/orbit", [view("a", "Main")]);
    const before = readFileSync(file, "utf8");
    const bad: [string, unknown, RegExp][] = [
      ["acme/orbit", "not a list", /must be a list/],
      ["acme/orbit", [view("a", "Main"), view("a", "Again")], /duplicate view id/],
      ["acme/orbit", [{ ...view("a", ""), name: "  " }], /needs a name/],
      ["acme/orbit", [view("a", "x".repeat(25))], /at most 24/],
      ["acme/orbit", Array.from({ length: 13 }, (_, i) => view("v" + i, "n" + i)), /at most 12/],
      ["acme/orbit", [{ ...view("a", "Main"), filter: { show: 1, hide: 2 } }], /./],
      ["not a repo", [], /owner\/name/],
      ["../etc/passwd", [], /owner\/name/],
    ];
    for (const [repo, input, why] of bad) {
      const r = V.setViewsFor(repo, input);
      expect(r.ok, JSON.stringify(input).slice(0, 40)).toBe(false);
      expect((r as { error: string }).error).toMatch(why);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("an invalid pattern in a rule is refused", () => {
    const v = view("a", "Main");
    v.filter.show.children.push({ id: "r2", field: "text", op: "matches", values: ["("] });
    expect(V.setViewsFor("acme/orbit", [v]).ok).toBe(false);
  });

  test("a hand-edited file: a list that no longer validates reads as none, its neighbours stay", () => {
    writeFileSync(file, JSON.stringify({ "acme/orbit": [view("a", "Main")], "acme/relay": [{ id: "x" }], "bad key": [] }));
    expect(V.viewsFor("acme/orbit").views).toHaveLength(1);
    expect(V.viewsFor("acme/relay")).toEqual({ views: [], saved: false });
    writeFileSync(file, "{ not json");
    expect(V.viewsFor("acme/orbit")).toEqual({ views: [], saved: false });
  });
});

describe("the route", () => {
  const step = story();
  let proc: ReturnType<typeof Bun.spawn> | null = null, base = "";
  const cfg = join(dir, "srv");

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: dir,
        XDG_CONFIG_HOME: cfg,
        XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"),
        AGENTGLASS_STATE_DIR: join(dir, "state"),
        AGENTGLASS_ROOT: dir,
        AGENTGLASS_DB: join(dir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }, SERVER_BOOT_MS);

  afterAll(() => { try { proc?.kill(); } catch { /* already gone */ } });

  const url = "/prs/views?repo=acme/orbit";
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  step("GET on a repository never saved says so", async () => {
    const j = await (await fetch(base + url)).json() as any;
    expect(j).toMatchObject({ ok: true, repo: "acme/orbit", views: [], saved: false });
  });

  step("POST saves, GET reads it back, and the file lands under XDG_CONFIG_HOME", async () => {
    const r = await post({ views: [view("a", "Main")] });
    expect(r.status).toBe(200);
    const j = await (await fetch(base + url)).json() as any;
    expect(j.saved).toBe(true);
    expect(j.views[0].name).toBe("Main");
    expect(JSON.parse(readFileSync(join(cfg, "agentglass", "pr-views.json"), "utf8"))["acme/orbit"]).toHaveLength(1);
  });

  step("a refusal is a 400 with a sentence and the saved list stays", async () => {
    for (const body of [{ views: "x" }, { views: [view("a", "Main"), view("a", "Dup")] }, {}, null]) {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(typeof ((await r.json()) as any).error).toBe("string");
    }
    expect(((await (await fetch(base + url)).json()) as any).views).toHaveLength(1);
    const r = await fetch(base + "/prs/views?repo=nope", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ views: [] }) });
    expect(r.status).toBe(400);
  });

  step("a write from a page on another origin is refused", async () => {
    const r = await post({ views: [] }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(((await (await fetch(base + url)).json()) as any).views).toHaveLength(1);
  });
});

describe("the route is gated like every other write", () => {
  // /prs/merge is the reference: whatever it answers a caller, /prs/views answers the same.
  const TOKEN = "t".repeat(32);
  let proc: ReturnType<typeof Bun.spawn> | null = null, base = "";
  const home = join(dir, "keyed");

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
        TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: home,
        XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
        AGENTGLASS_STATE_DIR: join(home, "state"), AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(home, "k.db"),
        AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + "/health")).status < 500) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up");
  }, SERVER_BOOT_MS);
  afterAll(() => { try { proc?.kill(); } catch { /* already gone */ } });

  const write = (path: string, headers: Record<string, string>, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const views = (headers: Record<string, string>) => write("/prs/views?repo=acme/orbit", headers, { views: [view("a", "Main")] });
  const merge = (headers: Record<string, string>) => write("/prs/merge", headers, { root: dir, number: 1, method: "squash" });
  const auth = { authorization: `Bearer ${TOKEN}` };

  test("without the token a write and a read are refused, as the merge route refuses", async () => {
    const m = (await merge({})).status;
    expect(m).toBeGreaterThanOrEqual(400);
    expect((await views({})).status).toBe(m);
    expect((await fetch(base + "/prs/views?repo=acme/orbit")).status).toBeGreaterThanOrEqual(400);
  });

  test("a write from another origin is refused with the merge route's status, token or not", async () => {
    for (const h of [
      { origin: "https://evil.example" },
      { origin: "https://evil.example", ...auth },
    ]) {
      const m = (await merge(h)).status;
      expect(m, JSON.stringify(h)).toBeGreaterThanOrEqual(400);
      expect((await views(h)).status, JSON.stringify(h)).toBe(m);
    }
    const r = await fetch(base + "/prs/views?repo=acme/orbit", { headers: auth });
    expect(((await r.json()) as any).saved, "nothing was written").toBe(false);
  });

  test("a trusted caller writes, and the answer reflects the origin rather than a wildcard", async () => {
    const r = await views({ ...auth, origin: base });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(base);
  });
});
