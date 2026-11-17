/*
 * A repository's tracker settings through the settings door, on a booted
 * server: `--root` names the project whose checkout carries the repository, the
 * choice and the ClickUp-writes switch are read and written for it, and turning
 * writes on waits for the person while turning them off applies at once.
 *
 * The checkouts are real git repositories with a real remote, because that is
 * where the repository's identity comes from (prs.ts `repoNameOf`); nothing is
 * fetched, so no network is touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "tok-tracker-door-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
/** The person at the desk: the app's own origin (SECURITY.md, a hand-started server). */
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
/** An agent: the same token, no origin. */
const fromAgent = () => ({ ...auth, "Content-Type": "application/json" });

const get = async <T,>(path: string): Promise<T> => (await fetch(base + path, { headers: auth })).json() as Promise<T>;
const post = async (body: unknown, headers: Record<string, string>) => {
  const res = await fetch(base + "/settings/door", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const decide = async (id: string, approve: boolean) => {
  const res = await fetch(base + "/settings/requests/decide", { method: "POST", headers: fromApp(), body: JSON.stringify({ id, approve }) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
type Req = { id: string; setting: string; root?: string; diff: string[] };
const requests = async () => (await (await fetch(base + "/settings/requests", { headers: fromApp() })).json() as { requests: Req[] }).requests;
const valueOf = async (id: string, root: string) =>
  (await get<{ ok: boolean; value: unknown; scopedSet?: boolean }>(`/settings/door?id=${id}&root=${encodeURIComponent(root)}`));
const trackerFile = () => JSON.parse(readFileSync(join(dir, "agentglass", "tracker-projects.json"), "utf8"));
const writesFile = () => JSON.parse(readFileSync(join(dir, "agentglass", "clickup-writes.json"), "utf8"));

/** A checkout of `name` with these remotes, under the test's own HOME. */
function checkout(name: string, remotes: [string, string][]): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  run("init", "-q");
  for (const [remote, url] of remotes) run("remote", "add", remote, url);
  return path;
}

let orbit = "", fork = "";
const notACheckout = () => join(dir, "not-a-checkout");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-tracker-door-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  orbit = checkout("orbit", [["origin", "https://github.com/acme/orbit.git"]]);
  fork = checkout("orbit-fork", [["origin", "https://github.com/someone/orbit.git"], ["upstream", "https://github.com/acme/upstream.git"]]);
  mkdirSync(notACheckout(), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the door lists and reads them per project", () => {
  test("both are listed, held per project, and a project's value is not in the list", async () => {
    const l = (await get<{ settings: { id: string; class: string; scoped: boolean; value?: unknown; page: string }[] }>("/settings/door")).settings;
    for (const id of ["tracker.choice", "tracker.clickupWrites"]) {
      expect(l.find((x) => x.id === id), id).toMatchObject({ class: "escalation", scoped: true, page: "tasks" });
      expect(l.find((x) => x.id === id)).not.toHaveProperty("value");
    }
  });

  test("a checkout reads its repository's own values: auto, writes off", async () => {
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ ok: true, value: "auto", scopedSet: false });
    expect(await valueOf("tracker.clickupWrites", orbit)).toMatchObject({ ok: true, value: false, scopedSet: false });
  });

  test("a folder that is not a checkout names no repository, and a write there is a sentence", async () => {
    expect(await valueOf("tracker.choice", notACheckout())).toMatchObject({ value: "auto" });
    const r = await post({ id: "tracker.choice", value: "jira", root: notACheckout() }, fromApp());
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not a checkout of a repository");
    const w = await post({ id: "tracker.clickupWrites", value: true, root: notACheckout() }, fromApp());
    expect(w.status).toBe(400);
  });

  test("a root that is not a path, and no root at all, are refused", async () => {
    const res = await fetch(base + "/settings/door?id=tracker.choice&root=relative", { headers: auth });
    expect(res.status).toBe(400);
    expect((await post({ id: "tracker.choice", value: "jira" }, fromApp())).body.error).toContain("kept per project");
  });
});

describe("the person's own change applies", () => {
  test("the choice lands on the repository the checkout's remote names", async () => {
    const r = await post({ id: "tracker.choice", value: "clickup", root: orbit }, fromApp());
    expect(r).toMatchObject({ status: 200, body: { ok: true, applied: true, value: "clickup" } });
    expect(trackerFile()).toEqual({ "acme/orbit": "clickup" });
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ value: "clickup", scopedSet: true });
  });

  test("and the Settings page's own route reads the same choice", async () => {
    const page = await get<{ projects: Record<string, string> }>("/tracker/projects");
    expect(page.projects).toEqual({ "acme/orbit": "clickup" });
  });

  test("ClickUp writes on and off, through the door", async () => {
    expect(await post({ id: "tracker.clickupWrites", value: true, root: orbit }, fromApp())).toMatchObject({ status: 200, body: { applied: true, value: true } });
    expect(writesFile()).toEqual({ "acme/orbit": true });
    expect(await get<{ clickupWrites: Record<string, true> }>("/tracker/projects")).toMatchObject({ clickupWrites: { "acme/orbit": true } });
    expect(await post({ id: "tracker.clickupWrites", value: false, root: orbit }, fromApp())).toMatchObject({ status: 200, body: { applied: true, value: false } });
    expect(writesFile()).toEqual({});
  });

  test("a project on a fork is named by its upstream, which is where pull requests live", async () => {
    expect((await post({ id: "tracker.choice", value: "jira", root: fork }, fromApp())).status).toBe(200);
    expect(trackerFile()).toEqual({ "acme/orbit": "clickup", "acme/upstream": "jira" });
  });
});

describe("an agent's change", () => {
  test("turning ClickUp writes on waits for the person and writes nothing", async () => {
    const r = await post({ id: "tracker.clickupWrites", value: true, root: orbit }, fromAgent());
    expect(r.status).toBe(202);
    expect(r.body.pending).toMatchObject({ setting: "tracker.clickupWrites", root: orbit });
    expect(await valueOf("tracker.clickupWrites", orbit)).toMatchObject({ value: false });
    expect((await get<{ clickupWrites: Record<string, true> }>("/tracker/projects")).clickupWrites).toEqual({});
    const [q] = (await requests()).filter((x) => x.setting === "tracker.clickupWrites");
    expect(q!.diff[0]).toContain("ClickUp changes");
    expect(q!.diff.some((l) => l.endsWith('false -> true'))).toBe(true);
  });

  test("the agent cannot approve its own request; the person can, and exactly that applies", async () => {
    const [q] = (await requests()).filter((x) => x.setting === "tracker.clickupWrites");
    const asAgent = await fetch(base + "/settings/requests/decide", { method: "POST", headers: fromAgent(), body: JSON.stringify({ id: q!.id, approve: true }) });
    expect(asAgent.status).toBe(403);
    expect(await valueOf("tracker.clickupWrites", orbit)).toMatchObject({ value: false });
    expect((await decide(q!.id, true)).status).toBe(200);
    expect(await valueOf("tracker.clickupWrites", orbit)).toMatchObject({ value: true });
    expect(await requests()).toEqual([]);
  });

  test("turning them off applies at once: it is the narrowing direction", async () => {
    const r = await post({ id: "tracker.clickupWrites", value: false, root: orbit }, fromAgent());
    expect(r).toMatchObject({ status: 200, body: { ok: true, applied: true, value: false } });
    expect(await valueOf("tracker.clickupWrites", orbit)).toMatchObject({ value: false });
    expect(writesFile()).toEqual({});
    expect(await requests()).toEqual([]);
  });

  test("pinning a repository to ClickUp waits; moving it off ClickUp applies", async () => {
    const widen = await post({ id: "tracker.choice", value: "clickup", root: orbit }, fromAgent());
    // Already the stored value, so nothing is asked and nothing moves.
    expect(widen.status).toBe(200);
    expect((await post({ id: "tracker.choice", value: "jira", root: orbit }, fromApp())).status).toBe(200);
    expect((await post({ id: "tracker.choice", value: "clickup", root: orbit }, fromAgent())).status).toBe(202);
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ value: "jira" });
    const [q] = (await requests()).filter((x) => x.setting === "tracker.choice");
    expect(q!.diff[0]).toContain("tracker");
    expect((await decide(q!.id, false)).status).toBe(200);
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ value: "jira" });
    expect((await post({ id: "tracker.choice", value: "auto", root: orbit }, fromAgent())).status).toBe(200);
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ value: "auto" });
  });

  test("one project's change never moves another repository's", async () => {
    expect(await valueOf("tracker.choice", fork)).toMatchObject({ value: "jira" });
    expect(await valueOf("tracker.choice", orbit)).toMatchObject({ value: "auto" });
  });
});
