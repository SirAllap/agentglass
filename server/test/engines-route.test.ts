/*
 * GET /engines and POST /engines/test, through a booted server whose PATH
 * starts with the fake engines: what the page will actually call, answered by
 * the stubs and not by a CLI of the developer's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { installFakeEngines, readCalls } from "./fixtures/fakeEngines.ts";

let dir: string, fakes: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
const SECRET = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-engines-route-"));
  fakes = join(dir, "bin");
  installFakeEngines(fakes, {
    claude: { status: { out: `{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "apiKey": "${SECRET}"}` } },
    hermes: { version: { out: "Hermes Agent v0.21.0 (2026.9.1)" } },
    codex: { status: { out: "Not logged in", exit: 1 } },
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [fakes, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "e.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
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

describe("/engines", () => {
  test("answers the six engines for this host, from the stubs, with no secret in the body", async () => {
    const res = await fetch(base + "/engines");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const r = JSON.parse(text) as { host: string; engines: { id: string; found: boolean; versionOk: boolean | null; roles: { worker: { ok: boolean } } }[] };
    expect(r.host.length).toBeGreaterThan(0);
    expect(r.engines.map((e) => e.id)).toEqual(["claude", "codex", "antigravity", "gemini", "hermes", "opencode"]);
    const by = (id: string) => r.engines.find((e) => e.id === id)!;
    expect(by("claude").roles.worker.ok).toBe(true);
    expect(by("hermes").versionOk).toBe(false);
    expect(by("codex").roles.worker.ok).toBe(false);
    expect(by("gemini").found).toBe(false);
    // The server ran the stub: the first-on-PATH claude is the fake.
    expect(readCalls(fakes, "claude").length).toBeGreaterThan(0);
  });

  test("a second GET spawns nothing and ?fresh=1 does", async () => {
    await fetch(base + "/engines");
    const n = readCalls(fakes).length;
    await fetch(base + "/engines");
    expect(readCalls(fakes).length).toBe(n);
    await fetch(base + "/engines?fresh=1");
    expect(readCalls(fakes).length).toBeGreaterThan(n);
  });

  test("the test route runs one turn and the next GET reports it", async () => {
    const res = await fetch(base + "/engines/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "claude" }) });
    const r = await res.json() as { ok: boolean; ms: number };
    expect(r.ok).toBe(true);
    const e = ((await (await fetch(base + "/engines")).json()) as { engines: { id: string; answers: { state: string } }[] }).engines.find((x) => x.id === "claude")!;
    expect(e.answers.state).toBe("ok");
  });

  test("an engine that is not there, and a body that is not JSON, are refused", async () => {
    const miss = await fetch(base + "/engines/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "emacs" }) });
    expect(miss.status).toBe(400);
    const bad = await fetch(base + "/engines/test", { method: "POST", body: "not json" });
    expect(bad.status).toBe(400);
  });

  test("a page from another origin cannot start a turn", async () => {
    const res = await fetch(base + "/engines/test", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ engine: "claude" }),
    });
    expect(res.status).toBe(403);
  });
});
