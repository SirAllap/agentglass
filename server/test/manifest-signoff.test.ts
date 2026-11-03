/*
 * SIGNING OFF, OVER THE REAL ROUTE.
 *
 * The rule worth pinning is not the SQL: it is who may write, on which commits,
 * and that a refusal is one sentence. A test of `signOff()` alone would pass
 * with the route open to an agent's shell.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-this-test";
let dir = "", repo = "", base = "", bareBase = "", phoneRead = "", phoneAnswer = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];
let first = "", build = "", ready = "";
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };

const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const commitFile = (name: string, text: string, subject: string) => {
  writeFileSync(join(repo, name), text);
  git("add", "-A");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD").stdout.trim();
};

async function boot(env: Record<string, string>): Promise<{ base: string; proc: ReturnType<typeof Bun.spawn> }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const p = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state-" + port),
      AGENTGLASS_ROOT: repo,
      AGENTGLASS_DB: join(dir, `manifest-${port}.db`),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...env,
    },
    stdout: "ignore", stderr: "pipe",
  });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + "/health")).ok) return { base: url, proc: p }; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(p.stderr as ReadableStream).text()).slice(0, 400));
}

/** These tests are about the window and the boundary, so their line sits before
 *  the first commit: every seeded row is after it. */
function beforeEveryCommit(origin: string): void {
  const db = new Database(join(dir, `manifest-${new URL(origin).port}.db`));
  try { db.query("INSERT OR REPLACE INTO manifest_start (project, sha, at) VALUES (?, ?, 0)").run(repo, "e".repeat(40)); }
  finally { db.close(); }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-manifest-sign-"));
  repo = join(dir, "orbit");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  first = commitFile("a.txt", "a\n", "ORBIT-1001 the first thing");
  build = commitFile("b.txt", "b\n", "ORBIT-1002 the second thing");
  ready = commitFile("c.txt", "c\n", "ORBIT-1003 the third thing");

  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  const { issueDevice } = await import("../src/devices.ts");
  phoneRead = issueDevice("Acme phone", "read").token;
  phoneAnswer = issueDevice("Acme desk phone", "answer").token;

  ({ base } = await boot({ AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_MANIFEST_BUILD: build }));
  desk.origin = base;
  beforeEveryCommit(base);
  /* A second install: no credential, and a build commit this checkout does not
     have. The only state in which "no install boundary" exists. */
  const bare = await boot({ AGENTGLASS_MANIFEST_BUILD: "f".repeat(40) });
  bareBase = bare.base;
  beforeEveryCommit(bareBase);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const desk = { authorization: `Bearer ${TOKEN}`, origin: "" };
const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/manifest/signoff`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const deskPost = (body: unknown) => post(body, desk);
const deskGet = (p: string) => get(p, desk);
/** Every test that counts a verdict clears both rows first: the file shares one
    server, and `--seed` shuffles the tests inside it. */
const reset = async () => { for (const sha of [first, build]) await deskPost({ project: repo, sha, verdict: "cleared" }); };

describe("the rows", () => {
  test("carry every window row, in the build or not, with the counters that go with them", async () => {
    await reset();
    const r = await deskGet(`/manifest?project=${encodeURIComponent(repo)}`);
    expect(r.status).toBe(200);
    const b = await r.json() as Json;
    expect(b.boundary).toBe("build");
    expect(b.signOff).toBe("yes");
    expect(b.rows.map((x: Json) => x.subject)).toEqual([
      "ORBIT-1003 the third thing", "ORBIT-1002 the second thing", "ORBIT-1001 the first thing",
    ]);
    expect(b.rows[0].group).toBe("ready");
    expect(b.rows[0].inBuild).toBe(false);
    expect(b.rows[1].group).toBe("toTest");
    expect(b.rows[1].ticket).toBe("ORBIT-1002");
    expect(b.counters).toEqual({ merged: 3, running: 0, builtWaiting: 1 });
    expect(b.left).toBe(2);
  });

  test("404 for a project that is not open, and the sentence says so", async () => {
    const r = await deskGet(`/manifest?project=${encodeURIComponent("/tmp/nowhere-acme")}`);
    expect(r.status).toBe(404);
    expect((await r.json() as Json).error).toBe("that project is not open");
  });

  test("the summary lists the open project and the dot's count", async () => {
    await reset();
    const b = await (await deskGet("/manifest")).json() as Json;
    expect(b.projects).toHaveLength(1);
    expect(b.projects[0].root).toBe(repo);
    expect(b.projects[0].left).toBe(2);
  });
});

describe("who may sign", () => {
  test("an agent credential is refused with one sentence", async () => {
    const r = await post({ project: repo, sha: build, verdict: "tested" },
      { authorization: `Bearer ${TOKEN}`, origin: base, "x-agentglass-agent": "seat" });
    expect(r.status).toBe(403);
    expect((await r.json() as Json).error).toBe("only the person signs off");
  });

  test("a phone paired read can read the list and cannot sign", async () => {
    const g = await get(`/manifest?project=${encodeURIComponent(repo)}`, bearer(phoneRead));
    expect(g.status).toBe(200);
    expect((await g.json() as Json).signOff).toBe("grant");
    const r = await post({ project: repo, sha: build, verdict: "tested" }, bearer(phoneRead));
    expect(r.status).toBe(403);
    expect((await r.json() as Json).error).toBe("only the person signs off");
  });

  test("a phone paired answer signs, and the row says it came from the phone", async () => {
    const r = await post({ project: repo, sha: build, verdict: "tested", note: "looks right" }, bearer(phoneAnswer));
    expect(r.status).toBe(200);
    const b = await deskGet(`/manifest?project=${encodeURIComponent(repo)}`);
    const row = (await b.json() as Json).rows.find((x: Json) => x.sha === build);
    expect(row.verdict).toBe("tested");
    expect(row.kind).toBe("phone");
    expect(row.note).toBe("looks right");
    expect(row.group).toBe("toTest");
  });

  test("a tokenless install with no Origin refuses the write", async () => {
    const r = await fetch(`${bareBase}/manifest/signoff`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: repo, sha: build, verdict: "tested" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("the write", () => {
  test("signing again keeps at, so a row does not restart its 24 hours", async () => {
    await reset();
    expect((await deskPost({ project: repo, sha: build, verdict: "tested" })).status).toBe(200);
    const before = (await (await deskGet(`/manifest?project=${encodeURIComponent(repo)}`)).json() as Json).rows.find((x: Json) => x.sha === build);
    await Bun.sleep(10);
    const r = await deskPost({ project: repo, sha: build, verdict: "failed", note: "broke the tab strip" });
    expect(r.status).toBe(200);
    const after = (await (await deskGet(`/manifest?project=${encodeURIComponent(repo)}`)).json() as Json).rows.find((x: Json) => x.sha === build);
    expect(after.verdict).toBe("failed");
    expect(after.at).toBe(before.at);
  });

  test("cleared removes it and answers 200 even where no verdict was", async () => {
    await deskPost({ project: repo, sha: build, verdict: "tested" });
    const a = await deskPost({ project: repo, sha: build, verdict: "cleared" });
    expect(a.status).toBe(200);
    expect((await a.json() as Json).cleared).toBe(true);
    const b = await deskPost({ project: repo, sha: ready, verdict: "cleared" });
    expect(b.status).toBe(200);
    const row = (await (await deskGet(`/manifest?project=${encodeURIComponent(repo)}`)).json() as Json).rows.find((x: Json) => x.sha === build);
    expect(row.verdict).toBeNull();
  });

  test("a row outside the build cannot be signed, and the sentence is Ready to install's", async () => {
    const r = await deskPost({ project: repo, sha: ready, verdict: "tested" });
    expect(r.status).toBe(400);
    expect((await r.json() as Json).error).toBe("merged, not in the build you are looking at");
  });

  test("a sha that is not this project's row is refused", async () => {
    const r = await deskPost({ project: repo, sha: "a".repeat(40), verdict: "tested" });
    expect(r.status).toBe(400);
    const short = await deskPost({ project: repo, sha: "abc", verdict: "tested" });
    expect(short.status).toBe(400);
    expect((await short.json() as Json).error).toBe("sha must be 40 hex characters");
  });

  test("a note over 500 characters is refused and the row keeps its verdict", async () => {
    await reset();
    const r = await deskPost({ project: repo, sha: build, verdict: "tested", note: "x".repeat(501) });
    expect(r.status).toBe(400);
    expect((await r.json() as Json).error).toBe("500 characters at most");
    const row = (await (await deskGet(`/manifest?project=${encodeURIComponent(repo)}`)).json() as Json).rows.find((x: Json) => x.sha === build);
    expect(row.verdict).toBeNull();
  });

  test("a write clears the summary cache, so the dot cannot stay on", async () => {
    await reset();
    const before = (await (await deskGet("/manifest")).json() as Json).projects[0].left;
    expect(before).toBe(2);
    await deskPost({ project: repo, sha: build, verdict: "tested" });
    const after = (await (await deskGet("/manifest")).json() as Json).projects[0].left;
    expect(after).toBe(1);
    await deskPost({ project: repo, sha: build, verdict: "cleared" });
  });

  test("GET writes nothing", async () => {
    const read = async () => (await (await deskGet(`/manifest?project=${encodeURIComponent(repo)}`)).json() as Json)
      .rows.filter((x: Json) => x.verdict).length;
    const a = await read();
    await deskGet(`/manifest?project=${encodeURIComponent(repo)}`);
    expect(await read()).toBe(a);
  });
});

describe("a project with no install boundary", () => {
  test("claims none, carries every window row, and every one signs", async () => {
    const origin = bareBase;
    const b = await (await fetch(`${origin}/manifest?project=${encodeURIComponent(repo)}`, { headers: { origin } })).json() as Json;
    expect(b.boundary).toBe("none");
    expect(b.counters.builtWaiting).toBeNull();
    expect(b.rows).toHaveLength(3);
    expect(b.rows.every((x: Json) => x.group === "toTest" && x.inBuild === null)).toBe(true);
    expect(b.left).toBe(3);
    const r = await fetch(`${origin}/manifest/signoff`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ project: repo, sha: ready, verdict: "tested" }),
    });
    expect(r.status).toBe(200);
  });
});
