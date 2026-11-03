/*
 * The walk behind `Search this computer`.
 *
 * What matters here is the boundary, not the speed: a repository three levels
 * down is found, the folders nobody means (node_modules, a hidden folder, a
 * symlink) are not entered, the caps stop the walk and are said out loud, one
 * server walks once, and Stop leaves no walker behind.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { SetupScan } from "../../shared/types.ts";

const TOKEN = "tok-setup-scan-example";
const dirs: string[] = [];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];

const git = (root: string, branch = "main") => {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  mkdirSync(join(root, ".git", "logs"), { recursive: true });
  writeFileSync(join(root, ".git", "logs", "HEAD"), "");
};

async function boot(home: string, extra: Record<string, string> = {}): Promise<string> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  procs.push(Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
      AGENTGLASS_STATE_DIR: join(home, "state"),
      AGENTGLASS_DB: join(home, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
      ...extra,
    },
    stdout: "ignore", stderr: "pipe",
  }));
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return base; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

const start = async (base: string): Promise<SetupScan> =>
  (await fetch(base + "/setup/scan", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<SetupScan>;
const read = async (base: string, id: string): Promise<SetupScan> =>
  (await fetch(`${base}/setup/scan?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<SetupScan>;
const stop = async (base: string, id: string): Promise<SetupScan> =>
  (await fetch(base + "/setup/scan/stop", {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })).json() as Promise<SetupScan>;

async function settled(base: string, id: string): Promise<SetupScan> {
  for (let i = 0; i < 200; i++) {
    const s = await read(base, id);
    if (s.state !== "running") return s;
    await Bun.sleep(20);
  }
  throw new Error("the scan did not finish");
}

beforeAll(async () => {
  dirs.length = 0;
  procs.length = 0;
});

afterAll(() => {
  for (const p of procs) p.kill();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the walk", () => {
  let base: string;
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "agx-setup-scan-"));
    dirs.push(home);
    git(join(home, "work", "acme", "orbit"), "feat/canvas-board");
    git(join(home, "work", "acme", "harbour"));
    git(join(home, "work", "node_modules", "vendored"), "main");
    git(join(home, ".hidden", "secret"));
    // Inside the home on purpose: a symlink out of the root is already refused
    // by the boundary, and this test is about not following one at all.
    symlinkSync(join(home, "work", "acme", "orbit"), join(home, "work", "link-to-away"));
    base = await boot(home);
  }, SERVER_BOOT_MS);

  test("a repository three levels down is found, with its branch", async () => {
    const s = await settled(base, (await start(base)).id);
    expect(s.state).toBe("done");
    const names = s.repos.map((r) => r.name).sort();
    expect(names).toEqual(["harbour", "orbit"]);
    const orbit = s.repos.find((r) => r.name === "orbit")!;
    expect(orbit.parent).toBe(join(home, "work", "acme"));
    expect(orbit.branch).toBe("feat/canvas-board");
  });

  test("node_modules, a hidden folder and a symlink are not entered", async () => {
    const s = await settled(base, (await start(base)).id);
    const names = s.repos.map((r) => r.name);
    expect(names).not.toContain("vendored");
    expect(names).not.toContain("secret");
    expect(names).not.toContain("link-to-away");
  });

  test("an id this server never started is not answered", async () => {
    const r = await fetch(`${base}/setup/scan?id=scan-9999`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
  });
});

describe("the caps", () => {
  test("the repository cap stops the walk and says which cap it was", async () => {
    const home = mkdtempSync(join(tmpdir(), "agx-setup-scan-cap-"));
    dirs.push(home);
    for (const name of ["a", "b", "c"]) git(join(home, name));
    const base = await boot(home, { AGENTGLASS_SETUP_SCAN_MAX: "2" });
    const s = await settled(base, (await start(base)).id);
    expect(s.state).toBe("stopped");
    expect(s.capped).toBe("count");
    expect(s.repos).toHaveLength(2);
  }, SERVER_BOOT_MS);
});

describe("Stop", () => {
  test("stops the walk, and no walker keeps reading folders", async () => {
    const home = mkdtempSync(join(tmpdir(), "agx-setup-scan-stop-"));
    dirs.push(home);
    for (let i = 0; i < 1200; i++) mkdirSync(join(home, `f${i}`, "deeper"), { recursive: true });
    const base = await boot(home);
    const started = await start(base);
    // A second start while it is walking answers the first, not a new walk.
    const again = await start(base);
    expect(again.id).toBe(started.id);
    expect((await read(base, started.id)).id).toBe(started.id);
    const stopped = await stop(base, started.id);
    expect(stopped.state).toBe("stopped");
    expect(stopped.capped).toBe("person");
    const before = (await read(base, started.id)).folders;
    await Bun.sleep(250);
    const after = await read(base, started.id);
    expect(after.folders).toBe(before);
    expect(after.state).toBe("stopped");
  }, SERVER_BOOT_MS);
});
