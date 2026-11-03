/*
 * The first run's keys through the settings door.
 *
 * They answer before any project is open, so they are app-wide values: a write
 * that names a project still lands under APP, which is what lets a second
 * window read the same answer. An agent is refused all four (personOnly), and
 * `setup.agent` refuses an id that is not an engine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { SetupState } from "../../shared/types.ts";

const TOKEN = "tok-setup-flag-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const auth = { Authorization: `Bearer ${TOKEN}` };
const fromApp = () => ({ ...auth, Origin: base, "Content-Type": "application/json" });
const namedAgent = () => ({ ...fromApp(), "X-Agentglass-Agent": "builder-orbit-1" });

const post = async (body: Record<string, unknown>, headers: Record<string, string> = fromApp()) => {
  const res = await fetch(base + "/settings/door", { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const state = async (): Promise<SetupState> =>
  (await fetch(base + "/setup/state", { headers: auth })).json() as Promise<SetupState>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-setup-flag-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
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

describe("the person's own writes", () => {
  test("setup.done round-trips, and only then says finished", async () => {
    expect((await state()).setupDone).toBeNull();
    expect(await post({ id: "setup.done", value: true })).toMatchObject({ status: 200, body: { ok: true, applied: true } });
    expect((await state()).setupDone).toBe(true);
  });

  test("setup.inProgress round-trips", async () => {
    expect(await post({ id: "setup.inProgress", value: true })).toMatchObject({ status: 200, body: { applied: true } });
    expect((await state()).setupInProgress).toBe(true);
  });

  test("setup.tutorial round-trips as a comma list", async () => {
    expect(await post({ id: "setup.tutorial", value: "terminal,pull-requests" })).toMatchObject({ status: 200, body: { applied: true } });
    expect((await state()).tutorialSeen).toBe("terminal,pull-requests");
  });

  test("setup.agent takes an engine id", async () => {
    expect(await post({ id: "setup.agent", value: "opencode" })).toMatchObject({ status: 200, body: { applied: true } });
    expect((await state()).setupAgent).toBe("opencode");
  });

  test("a write that names a project still lands on the app row", async () => {
    expect(await post({ id: "setup.done", value: false, root: "/tmp/acme/orbit" })).toMatchObject({ status: 200, body: { applied: true } });
    // No root reaches them: the next window reads the same answer.
    expect((await state()).setupDone).toBe(false);
    expect(await post({ id: "setup.done", value: true })).toMatchObject({ status: 200, body: { applied: true } });
  });
});

describe("what is refused", () => {
  test("an id that is not an engine", async () => {
    expect((await post({ id: "setup.agent", value: "not-an-engine" })).status).toBe(400);
    expect((await state()).setupAgent).toBe("opencode");
  });

  test("an agent may not answer any of the four", async () => {
    for (const [id, value] of [["setup.done", false], ["setup.inProgress", false], ["setup.tutorial", ""], ["setup.agent", "claude"]] as const) {
      expect((await post({ id, value }, namedAgent())).status).toBe(403);
    }
    // Nothing moved.
    const s = await state();
    expect(s.setupDone).toBe(true);
    expect(s.setupInProgress).toBe(true);
    expect(s.setupAgent).toBe("opencode");
  });
});

describe("finish, and the way back", () => {
  test("finish writes setup.done from one place in the wizard", () => {
    const flow = readFileSync(new URL("../../web/src/components/setup/SetupFlow.tsx", import.meta.url), "utf8");
    const writes = flow.match(/settingsDoorSet\("setup\.done"/g) ?? [];
    expect(writes).toHaveLength(1);
    const finish = flow.slice(flow.indexOf("const finish ="), flow.indexOf("const next ="));
    expect(finish).toContain('settingsDoorSet("setup.done", true)');
    // Finish and Skip share it, so a second press cannot write it twice by
    // another route.
    expect(flow.slice(flow.indexOf("const skip ="))).toContain("finish(false)");
  });

  test("the restart row writes false, and a project open does not hide the wizard", async () => {
    const root = join(dir, "orbit");
    mkdirSync(root, { recursive: true });
    const git = Bun.spawnSync(["git", "init", "-q", root]);
    expect(git.exitCode).toBe(0);
    const opened = await fetch(base + "/workspace", {
      method: "POST", headers: fromApp(), body: JSON.stringify({ roots: [root] }),
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ ok: true });
    // The picker's own gate: a project open is a fact, and the stored false wins.
    expect((await state()).projectOpen).toBe(true);
    expect(await post({ id: "setup.done", value: false })).toMatchObject({ status: 200, body: { applied: true } });
    const s = await state();
    expect(s.setupDone).toBe(false);
    expect(s.projectOpen).toBe(true);
    expect(await post({ id: "setup.done", value: true })).toMatchObject({ status: 200, body: { applied: true } });
    expect((await state()).setupDone).toBe(true);
  });
});
