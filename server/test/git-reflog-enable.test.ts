// "Turn it on for this repository": enables the reflog, is fine when it is
// already on, and refuses a folder that is not a repository.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-reflog-")));
const SAVED = Object.fromEntries(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMUX_TMPDIR"].map((k) => [k, process.env[k]]));
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "AGENTGLASS_STATE_DIR", "TMUX_TMPDIR"]) {
  process.env[k] = join(dir, k.toLowerCase());
  mkdirSync(process.env[k]!, { recursive: true });
}
process.env.AGENTGLASS_DB = join(dir, "g.db");
process.env.AGENTGLASS_ROOT = dir;

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim() };
}
const REPO = join(dir, "orbit");
const PLAIN = join(dir, "not-a-repo");
let gw: typeof import("../src/gitwork.ts");

beforeAll(async () => {
  mkdirSync(REPO, { recursive: true });
  mkdirSync(PLAIN, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  gw = await import("../src/gitwork.ts");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  // TMUX_TMPDIR left pointing at the deleted dir confined every later tmux test to it.
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("reflogEnable", () => {
  test("turns core.logAllRefUpdates on where it was false, and the list stops reporting it off", () => {
    git(REPO, "config", "core.logAllRefUpdates", "false");
    expect(gw.reflogIsOff(REPO)).toBe(true);
    expect(gw.reflogEnable(REPO).ok).toBe(true);
    expect(git(REPO, "config", "--get", "core.logAllRefUpdates").out).toBe("true");
    expect(gw.reflogIsOff(REPO)).toBe(false);
  });
  test("is ok when it is already on", () => {
    expect(gw.reflogEnable(REPO).ok).toBe(true);
    expect(git(REPO, "config", "--get", "core.logAllRefUpdates").out).toBe("true");
  });
  test("an unset setting is not off", () => {
    git(REPO, "config", "--unset", "core.logAllRefUpdates");
    expect(gw.reflogIsOff(REPO)).toBe(false);
  });
  test("refuses a folder that is not a repository, like fetch does", () => {
    const r = gw.reflogEnable(PLAIN);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(gw.fetch(PLAIN).error);
    expect(git(PLAIN, "config", "--get", "core.logAllRefUpdates").out).toBe("");
  });
  test("the route is wired next to fetch", async () => {
    const idx = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(idx).toContain('case "/git/reflog-enable": res = gitReflogEnable(root); break;');
  });
});

// A real request to a server scoped to one project: the route refuses a repository
// outside it and leaves its config alone, and answers a plain folder like fetch does.
describe("POST /git/reflog-enable", () => {
  const TOKEN = "reflog-enable-token";
  const VAULT = join(dir, "vault");
  let base = "";
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const post = async (root: string) => {
    const r = await fetch(`${base}/git/reflog-enable`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ root }),
    });
    return { status: r.status, body: await r.json() as { ok?: boolean; error?: string } };
  };
  beforeAll(async () => {
    mkdirSync(VAULT, { recursive: true });
    git(VAULT, "init", "-q", "-b", "main");
    git(VAULT, "config", "core.logAllRefUpdates", "false");
    git(REPO, "config", "core.logAllRefUpdates", "false");
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const state = join(dir, `state-${port}`);
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "", HOME: dir, TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        XDG_CONFIG_HOME: join(state, "config"), XDG_DATA_HOME: join(state, "data"), XDG_CACHE_HOME: join(state, "cache"),
        AGENTGLASS_STATE_DIR: state, AGENTGLASS_DB: join(state, "agx.db"), AGENTGLASS_TOKEN: TOKEN,
        AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_ROOT: REPO, GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    throw new Error("the server did not come up");
  }, SERVER_BOOT_MS);
  afterAll(() => { try { proc?.kill(); } catch { /* already gone */ } });

  test("refuses a repository outside the open project and leaves its config alone", async () => {
    const r = await post(VAULT);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain("outside the open project");
    expect(git(VAULT, "config", "--get", "core.logAllRefUpdates").out).toBe("false");
  });
  test("turns it on in the open project", async () => {
    expect((await post(REPO)).body.ok).toBe(true);
    expect(git(REPO, "config", "--get", "core.logAllRefUpdates").out).toBe("true");
  });
  test("a folder that is not a repository is refused, in scope or not", async () => {
    expect((await post(PLAIN)).body.ok).toBe(false);
    expect((await post(join(dir, "missing"))).body.ok).toBe(false);
  });
});
