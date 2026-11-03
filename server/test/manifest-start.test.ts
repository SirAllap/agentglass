/*
 * STARTING FROM ZERO, OVER THE REAL ROUTE.
 *
 * A repository's whole history is not a list to sign. The first read stores
 * the line at the trunk's current commit; later reads list only what landed
 * after it. A verdict already given stays, and moving the line is the person's
 * write. The steps are one story in order, so `story()` keeps a shuffled run
 * honest.
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { story } from "./story.ts";

const TOKEN = "machine-token-for-the-start-line-test";
let dir = "", repo = "", base = "";
let second = "", third = "";
const procs: ReturnType<typeof Bun.spawn>[] = [];
const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };

const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
const commitFile = (name: string, text: string, subject: string) => {
  writeFileSync(join(repo, name), text);
  git("add", "-A");
  git("commit", "-qm", subject);
  return git("rev-parse", "HEAD").stdout.trim();
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-manifest-start-"));
  repo = join(dir, "orbit");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  commitFile("a.txt", "a\n", "ORBIT-1101 the first thing");
  second = commitFile("b.txt", "b\n", "ORBIT-1102 the second thing");

  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.XDG_CACHE_HOME = join(dir, "cache");

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  /* No install boundary: every row after the line is signable, which is what
     lets this file give a verdict and then move the line past it. */
  const p = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: repo,
      AGENTGLASS_DB: join(dir, "manifest.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_MANIFEST_BUILD: "f".repeat(40),
    },
    stdout: "ignore", stderr: "pipe",
  });
  procs.push(p);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  desk.origin = base;
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  for (const k of Object.keys(saved) as (keyof typeof saved)[]) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const desk = { authorization: `Bearer ${TOKEN}`, origin: base };
const read = async () => {
  const r = await fetch(`${base}/manifest?project=${encodeURIComponent(repo)}`, { headers: desk });
  return { status: r.status, body: (await r.json()) as Json };
};
const sign = (sha: string, verdict: string) => fetch(`${base}/manifest/signoff`, {
  method: "POST", headers: { ...desk, "content-type": "application/json" },
  body: JSON.stringify({ project: repo, sha, verdict }),
});
const start = () => fetch(`${base}/manifest/start`, {
  method: "POST", headers: { ...desk, "content-type": "application/json" },
  body: JSON.stringify({ project: repo }),
});

const step = story();

step("the first read stores the trunk's current commit and lists nothing older", async () => {
  const a = await read();
  expect(a.status).toBe(200);
  expect(a.body.start.sha).toBe(second);
  expect(typeof a.body.start.at).toBe("number");
  expect(a.body.rows).toEqual([]);
  expect(a.body.counters.merged).toBe(0);
  expect(a.body.left).toBe(0);
  // `first` is the only commit older than the line; the line's own commit is
  // not "older".
  expect(a.body.start.omitted).toBe(1);

  await Bun.sleep(15);
  const b = await read();
  expect(b.body.start.sha).toBe(second);
  expect(b.body.start.at).toBe(a.body.start.at);
});

step("a commit that lands after the line is the only row, and the line stays put", async () => {
  third = commitFile("c.txt", "c\n", "ORBIT-1103 the third thing");
  const r = await read();
  expect(r.body.rows.map((x: Json) => x.subject)).toEqual(["ORBIT-1103 the third thing"]);
  expect(r.body.counters.merged).toBe(1);
  expect(r.body.start.sha).toBe(second);
  expect(r.body.start.omitted).toBe(1);
});

step("a verdict already given stays on screen after the line moves past it", async () => {
  expect((await sign(third, "tested")).status).toBe(200);
  const moved = await start();
  expect(moved.status).toBe(200);
  const body = (await moved.json()) as Json;
  expect(body.start.sha).toBe(third);

  const r = await read();
  expect(r.body.start.sha).toBe(third);
  expect(r.body.rows.map((x: Json) => x.sha)).toEqual([third]);
  expect(r.body.rows[0]!.verdict).toBe("tested");
  expect(r.body.counters.merged).toBe(1);
  // `first` and `second` are older; the line's own commit is not.
  expect(r.body.start.omitted).toBe(2);
  expect(r.body.left).toBe(0);
});

step("a commit behind the line cannot be signed by naming its sha", async () => {
  const r = await sign(second, "tested");
  expect(r.status).toBe(400);
  expect(((await r.json()) as Json).error).toBe("that commit is not one of this project's rows");
});

step("moving the line again puts the newest commit at the line", async () => {
  const fourth = commitFile("d.txt", "d\n", "ORBIT-1104 the fourth thing");
  const moved = await start();
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as Json).start.sha).toBe(fourth);
  const r = await read();
  expect(r.body.rows.map((x: Json) => x.sha)).toEqual([third]);
  // `first` and `second`; `third` carries a verdict, and the line itself is not older.
  expect(r.body.start.omitted).toBe(2);
});

step("a project that is not open is refused", async () => {
  const r = await fetch(`${base}/manifest/start`, {
    method: "POST", headers: { ...desk, "content-type": "application/json" },
    body: JSON.stringify({ project: "/tmp/nowhere-acme" }),
  });
  expect(r.status).toBe(400);
  expect(((await r.json()) as Json).error).toBe("that project is not open");
});
