/*
 * GET /setup/state on a database nothing has ever written.
 *
 * The window's gate reads this once at launch. What matters here is the
 * difference the gate depends on: `setupDone` is null (never asked) rather than
 * false (asked and not finished), and on a fresh state directory every machine
 * fact is false.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { SetupState } from "../../shared/types.ts";

const TOKEN = "tok-setup-state-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

const state = async (): Promise<SetupState> =>
  (await fetch(base + "/setup/state", { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<SetupState>;

/** A request from the app's own window: the origin is what makes it the person. */
const asPerson = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  headers.set("Origin", base);
  headers.set("Content-Type", "application/json");
  return fetch(base + path, { ...init, headers });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-setup-state-"));
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

describe("a machine nobody set up", () => {
  test("setupDone is null: never asked, which is not the same as not finished", async () => {
    expect((await state()).setupDone).toBeNull();
  });

  test("nothing is open, no session has run and no hook is installed", async () => {
    expect(await state()).toMatchObject({ projectOpen: false, sessionsSeen: false, hooksInstalled: false });
  });

  test("the defaults the wizard starts from", async () => {
    const s = await state();
    expect(s.setupInProgress).toBe(false);
    expect(s.setupAgent).toBe("claude");
    expect(s.tutorialSeen).toBe("");
  });

  test("the server sends the home directory, so the browser never abbreviates with a guess", async () => {
    expect((await state()).homedir).toBe(dir);
  });
});

describe("the app's own settings before a project is open", () => {
  test("the flight plan switch answers instead of refusing for want of a project", async () => {
    const r = await asPerson("/settings/door?id=flightPlan.enabled");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, id: "flightPlan.enabled", value: false });
  });

  test("the setup flag written false is stored, so `Run the setup again` can bring the wizard back", async () => {
    expect((await state()).setupDone).toBeNull();
    const r = await asPerson("/settings/door", { method: "POST", body: JSON.stringify({ id: "setup.done", value: false }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, applied: true });
    expect((await state()).setupDone).toBe(false);
  });
});
