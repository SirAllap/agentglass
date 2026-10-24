/*
 * The door an agent has to "tell me when CI passes, ignoring these checks": the
 * plain route the bell uses, `POST /prs/notify-watch/add`. Driven over HTTP on a
 * real server, then the stored rule is evaluated in a second process on the
 * same database with a mocked read, so nothing reaches GitHub: what the route
 * accepted is what the watch decides with.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir: string, repo: string, base: string, dbFile: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-prignore-"));
  repo = join(dir, "orbit");
  mkdirSync(repo);
  for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:acme/orbit.git"]]) {
    const g = Bun.spawnSync(["git", ...args], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: dir } });
    if (g.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
  }
  dbFile = join(dir, "f.db");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      // No gh on this PATH: the server's own timer can read nothing, so only the test's mocked read decides.
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const add = (rule: unknown) => post("/prs/notify-watch/add", { root: repo, number: 7, title: "ORBIT-1042 add thing", rule });

describe("POST /prs/notify-watch/add with an ignore list", () => {
  test("a list that is not a list is refused with a sentence, and nothing is stored", async () => {
    const r = await add({ type: "ci-pass", ignore: "e2e-flaky" });
    expect(r.status).toBe(400);
    expect((await r.json() as { error: string }).error).toContain("not a rule");
    const w = await fetch(base + "/prs/notify-watch").then((x) => x.json()) as { watches: unknown[] };
    expect(w.watches).toEqual([]);
  });

  test("the list is stored trimmed and deduped, and shows in the list the window reads", async () => {
    const r = await add({ type: "ci-pass", ignore: [" e2e-flaky ", "e2e-flaky", "", "lint-slow"] });
    expect(r.status).toBe(200);
    const w = await fetch(base + "/prs/notify-watch").then((x) => x.json()) as { watches: { rule: unknown }[] };
    expect(w.watches.map((x) => x.rule)).toEqual([{ type: "ci-pass", ignore: ["e2e-flaky", "lint-slow"] }]);
  });

  test("the stored rule is what decides: a red ignored check fires it, a red one that is not ignored does not", async () => {
    try { proc?.kill(); } catch { /* gone */ }
    await proc?.exited; // one process on the file at a time
    const code = `
      const W = await import(${JSON.stringify(join(import.meta.dir, "../src/prNotifyWatch.ts"))});
      const got = [];
      W.subscribeWatchFire((f) => got.push([f.summary, f.detail, f.payload?.line]));
      const c = (name, state) => ({ name, workflow: "", state, done: state !== "pending" });
      const snap = (all) => ({ allDone: all.every((x) => x.done), verdict: all.some((x) => x.state === "failure") ? "red" : "green", all });
      await W.checkWatches(async () => snap([c("lint", "success"), c("e2e-flaky", "failure"), c("lint-slow", "pending"), c("docs", "failure")]));
      const before = got.length;
      await W.checkWatches(async () => snap([c("lint", "success"), c("e2e-flaky", "failure"), c("lint-slow", "pending"), c("docs", "success")]));
      console.log(JSON.stringify({ before, got }));`;
    const p = Bun.spawn(["bun", "-e", code], {
      env: { PATH: process.env.PATH ?? "", HOME: dir, AGENTGLASS_DB: dbFile, AGENTGLASS_SCAN_DISABLED: "1", NODE_ENV: "test" }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect(err).not.toContain("error");
    const res = JSON.parse(out.trim().split("\n").pop()!);
    expect(res.before).toBe(0); // docs is red and not ignored
    expect(res.got).toEqual([["CI passed", "ignoring 2: e2e-flaky, lint-slow", "ignoring 2: e2e-flaky, lint-slow"]]);
  });
});
