// /cleanup/plan and /cleanup/run on a booted server whose PATH holds only fake
// gh/docker/tmux (and the real git) and whose home is a scratch directory.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRANCH, PR, makeWorld, type World } from "./cleanupFixture.ts";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "orbit-cleanup-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
let w: World, base = "", proc: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  w = makeWorld();
  const shim = join(w.root, "shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(w.root, "view.json"), JSON.stringify(w.pr));
  writeFileSync(join(w.root, "list.json"), JSON.stringify(w.openPrs));
  const sh = (name: string, body: string) => { writeFileSync(join(shim, name), `#!/bin/sh\n${body}\n`); chmodSync(join(shim, name), 0o755); };
  sh("gh", `case "$2" in view) cat "${w.root}/view.json";; list) cat "${w.root}/list.json";; *) exit 2;; esac`);
  // buildx du prints a table and a trailer; builder prune prints what it removed. A call log shows what ran.
  sh("docker", `echo "$@" >> "${w.root}/docker.log"; case "$1 $2" in "buildx du") printf 'ID\tRECLAIMABLE\tSIZE\nabc\ttrue\t1GB\nShared:\t0B\nReclaimable:\t49.2GB\nTotal:\t52.1GB\n';; "builder prune") printf 'Deleted build cache objects:\nabc\nTotal:\t12.5GB\n';; esac; exit 0`);
  sh("tmux", 'echo "no server running" >&2; exit 1');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [shim, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      HOME: w.home, XDG_CONFIG_HOME: join(w.root, "xdg-config"), XDG_DATA_HOME: join(w.root, "xdg-data"), XDG_CACHE_HOME: join(w.root, "xdg-cache"),
      AGENTGLASS_STATE_DIR: join(w.root, "agx-state"), AGENTGLASS_DB: join(w.root, "c.db"), TMUX_TMPDIR: TMUX_TEST_TMPDIR, AGENTGLASS_ROOT: w.root,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}, SERVER_BOOT_MS);
afterAll(() => { try { proc?.kill(); } catch { /* gone */ } w?.cleanup(); });

// No desk key on a hand-started server: the person is the machine token from the app's own origin; an agent is the same token without it.
const person = () => ({ ...AUTH, origin: base });
const plan = async (repo = w.main) => (await (await fetch(`${base}/cleanup/plan?repo=${encodeURIComponent(repo)}&pr=${PR}`, { headers: AUTH })).json()) as any;
const run = (body: unknown) => fetch(base + "/cleanup/run", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify(body) });

describe("/cleanup", () => {
  test("the plan route answers from live git and the fake gh, and changes nothing", async () => {
    const r = await plan();
    expect(r.ok).toBe(true);
    expect(r.plan.blocks).toEqual([]);
    expect(r.plan.items.map((i: { kind: string }) => i.kind)).toEqual(["worktree", "branch", "fetch-prune", "stash", "own-state"]);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("the CLI prints the plan by default, and a run with a wrong id exits 1 without removing anything", () => {
    const cli = (...args: string[]) => {
      const p = Bun.spawnSync(["python3", "-I", new URL("../../bin/agentglass-cleanup", import.meta.url).pathname, String(PR), "--repo", w.main, ...args], {
        env: { PATH: process.env.PATH ?? "", HOME: w.home, AGENTGLASS_SERVER: base, AGENTGLASS_TOKEN: TOKEN }, stdout: "pipe", stderr: "pipe",
      });
      return { code: p.exitCode, json: JSON.parse(p.stdout.toString() || "{}") };
    };
    const dry = cli();
    expect(dry.code).toBe(0);
    expect(dry.json.plan.items.length).toBeGreaterThan(0);
    const bad = cli("--yes", "deadbeef");
    expect(bad.code).toBe(1);
    expect(bad.json.error).toMatch(/state changed/);
    expect(cli("--dry-run", "--yes", "x").json.error).toMatch(/pick one/);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a plan route call for something that is not a repository, or without a pull request number, is a 400", async () => {
    expect((await fetch(`${base}/cleanup/plan?repo=${encodeURIComponent(w.root)}&pr=${PR}`, { headers: AUTH })).status).toBe(400);
    expect((await fetch(`${base}/cleanup/plan?repo=${encodeURIComponent(w.main)}&pr=x`, { headers: AUTH })).status).toBe(400);
  });

  test("a run with a wrong plan id is a 409 and removes nothing", async () => {
    const bad = await run({ repo: w.main, pr: PR, planId: "0".repeat(64) });
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { error: string }).error).toMatch(/state changed/);
    expect(existsSync(w.wt)).toBe(true);
  });

  // The machine token is every agent shell's credential: it never runs a clean, it raises a card.
  test("an agent's run with the right id raises an approval card and removes nothing; the person declines it and still nothing goes", async () => {
    const p = await plan();
    const r = await run({ repo: w.main, pr: PR, planId: p.plan.id });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { ok: boolean; approval: string; cardId: string };
    expect(body).toMatchObject({ ok: true, approval: "pending" });
    expect(existsSync(w.wt)).toBe(true);
    const card = ((await (await fetch(base + "/settings/requests", { headers: AUTH })).json()) as { requests: { id: string; setting: string }[] }).requests.find((x) => x.id === body.cardId);
    expect(card?.setting).toBe("cleanup.run");

    // the agent cannot answer its own card
    const self = await fetch(base + "/settings/requests/decide", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ id: body.cardId, approve: true }) });
    expect(self.status).toBe(403);
    expect(existsSync(w.wt)).toBe(true);

    const no = await fetch(base + "/settings/requests/decide", { method: "POST", headers: { "content-type": "application/json", ...person() }, body: JSON.stringify({ id: body.cardId, approve: false }) });
    expect(no.status).toBe(200);
    expect(existsSync(w.wt)).toBe(true);
  });

  test("a person's run with the right id removes the checkout, no card", async () => {
    const p = await plan();
    const ok = await fetch(base + "/cleanup/run", { method: "POST", headers: { "content-type": "application/json", ...person() }, body: JSON.stringify({ repo: w.main, pr: PR, planId: p.plan.id }) });
    const body = (await ok.json()) as { ok: boolean; items: { kind: string; status: string }[]; remaining: { items: unknown[]; bytes: number; blocks: unknown[] } | null };
    expect(body.ok).toBe(true);
    // the re-read the dialog needs to say "Cleaned up": nothing is left of the pull request
    expect(body.remaining).toEqual({ items: [], bytes: 0, blocks: [] });
    expect(body.items.find((i) => i.kind === "worktree")!.status).toBe("done");
    expect(existsSync(w.wt)).toBe(false);
    expect(w.git(w.main, "branch", "--list", BRANCH)).toBe("");
  });

  test("a body that is not JSON is a 400", async () => {
    const r = await fetch(base + "/cleanup/run", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: "{" });
    expect(r.status).toBe(400);
  });

  test("the per-project settings read and write through the door at the project root (what Settings > Git and pull requests does)", async () => {
    const at = (id: string) => `${base}/settings/door?id=${id}&root=${encodeURIComponent(w.main)}`;
    expect(((await (await fetch(at("cleanup.mode"), { headers: AUTH })).json()) as { value: string }).value).toBe("ask");
    const set = await fetch(`${base}/settings/door`, { method: "POST", headers: { "content-type": "application/json", ...person() }, body: JSON.stringify({ id: "cleanup.mode", value: "auto", root: w.main }) });
    expect(((await set.json()) as { ok: boolean }).ok).toBe(true);
    expect(((await (await fetch(at("cleanup.mode"), { headers: AUTH })).json()) as { value: string }).value).toBe("auto");
    // no root is still refused: the value is per project
    expect((await fetch(`${base}/settings/door?id=cleanup.mode`, { headers: AUTH })).status).toBe(404);
  });

  test("cleanup.evidenceRoots is validated and stored per project through the door", async () => {
    const door = (value: unknown) => fetch(`${base}/settings/door`, { method: "POST", headers: { "content-type": "application/json", ...person() }, body: JSON.stringify({ id: "cleanup.evidenceRoots", value, root: w.main }) });
    expect((await door(["/"])).status).toBe(400);
    expect((await door("/ev/orbit")).status).toBe(400);
    expect(((await (await door([join(w.home, "ev", "orbit")])).json()) as { ok: boolean }).ok).toBe(true);
    const r = await (await fetch(`${base}/settings/door?id=cleanup.evidenceRoots&root=${encodeURIComponent(w.main)}`, { headers: AUTH })).json() as { value: string[] };
    expect(r.value).toEqual([join(w.home, "ev", "orbit")]);
  });

  test("the build cache size comes from docker buildx du, and a prune is the person's and runs docker builder prune", async () => {
    const size = await (await fetch(`${base}/cleanup/build-cache`, { headers: AUTH })).json() as { ok: boolean; reclaimableBytes: number; totalBytes: number };
    expect(size).toEqual({ ok: true, reclaimableBytes: 49_200_000_000, totalBytes: 52_100_000_000 });
    const log = () => (existsSync(join(w.root, "docker.log")) ? readFileSync(join(w.root, "docker.log"), "utf8") : "");
    expect(log()).not.toContain("builder prune");
    const post = (h: Record<string, string>) => fetch(`${base}/cleanup/build-cache/prune`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: "{}" });
    // an agent (the machine token without the app's origin) is refused and nothing runs
    expect((await post(AUTH)).status).toBeGreaterThanOrEqual(400);
    expect(log()).not.toContain("builder prune");
    const ok = await post(person());
    expect(await ok.json()).toEqual({ ok: true, freedBytes: 12_500_000_000, remainingBytes: 52_100_000_000 });
    expect(log()).toContain("builder prune -a -f");
    // a prune is never part of a pull request's plan
    expect((await plan()).plan?.items?.map((i: { kind: string }) => i.kind) ?? []).not.toContain("build-cache");
  });
});
