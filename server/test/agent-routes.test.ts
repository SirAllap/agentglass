/*
 * Connecting an agent, for real.
 *
 * The route shells out to hooks/connect_otel.py, and what makes that script
 * safe is behaviour a mock cannot have: it backs the file up before touching
 * it, refuses a config it cannot parse, and leaves a hand-written `[otel]`
 * block alone. So this drives the real script against a scratch HOME, which is
 * also the only way to find out that the reader and the writer agree about
 * where that home is.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-agentsrv-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // A named environment, never `...process.env` — and HOME pointed at a
    // scratch directory, so nothing here can write a developer's real
    // ~/.gemini or ~/.codex.
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  // `gemini` is not on this PATH, and connect_otel.py treats an existing
  // ~/.gemini as the other evidence a CLI is installed — which is deliberate,
  // since a config directory is proof somebody has run it. Creating it is what
  // makes this machine look like one with Gemini on it, without inventing a
  // binary. The script refusing an agent that is genuinely absent is correct
  // behaviour and is asserted separately.
  mkdirSync(join(dir, ".gemini"), { recursive: true });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const jsonOf = (r: Response) => r.json() as Promise<Json>;
const agents = () => fetch(base + "/agents").then(jsonOf);
const connect = (id: unknown, undo = false) =>
  fetch(base + "/agents/connect", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, undo }),
  });
const by = (rows: Json[], id: string) => rows.find((r) => r.id === id)!;

const GEMINI = () => join(dir, ".gemini", "settings.json");

describe("what the pane is told", () => {
  test("every known agent, installed or not", async () => {
    const r = await agents();
    expect(r.agents.map((a: Json) => a.id).sort()).toEqual(["antigravity", "claude-code", "codex", "gemini"]);
  });

  test("with the file connecting it would write, under this machine's HOME", async () => {
    // The bug this catches: the reader used Bun's `os.homedir()`, which ignores
    // $HOME, while the writer uses Python's Path.home(), which does not. On a
    // machine where they differ the app read a config the installer never wrote.
    for (const a of (await agents()).agents as Json[]) {
      if (a.via !== "otel") continue;
      expect(String(a.configPath).startsWith(dir + "/"), `${a.id} → ${a.configPath}`).toBe(true);
    }
  });

  test("and nothing has been seen from any of them yet", async () => {
    // A fresh database. This is the state that used to be indistinguishable
    // from "connected", which is the whole reason the field exists.
    for (const a of (await agents()).agents as Json[]) expect(a.seenAt, a.id).toBeNull();
  });

});

describe("connecting one", () => {
  test("writes the config, and says so in the script's own words", async () => {
    const r = await jsonOf(await connect("gemini"));
    expect(r.ok).toBe(true);
    // The script's own words, kept: it knows things this route does not — that
    // a config already pointed here, or that the user has an `[otel]` block of
    // their own it will not touch.
    expect(String(r.detail)).toContain("connected Gemini CLI");
    expect(String(r.detail).length).toBeGreaterThan(10);
    const cfg = JSON.parse(readFileSync(GEMINI(), "utf8"));
    expect(cfg.telemetry).toMatchObject({ enabled: true, traces: true });
    // Loopback by literal address, not by name. This endpoint is what the
    // exporter dials on every span, and the server binds IPv4-only — a
    // `localhost` that resolves to ::1 first would make each one pay a refused
    // connect before falling back.
    expect(String(cfg.telemetry.otlpEndpoint)).toContain("127.0.0.1");
  });

  test("and the probe agrees, without claiming anything has arrived", async () => {
    // The distinction the whole feature rests on. A file was written; that is
    // not the same as an event landing, and the pane must be able to say so.
    const g = by((await agents()).agents, "gemini");
    expect(g.connected).toBe(true);
    expect(g.seenAt).toBeNull();
  });

  test("twice is not an error, and does not write again", async () => {
    const r = await jsonOf(await connect("gemini"));
    expect(r.ok).toBe(true);
    expect(String(r.detail)).toContain("already connected");
  });

  test("connects only the one asked for", async () => {
    // The pane offers a button per agent. Wiring all of them because somebody
    // pressed one is not what the button says it does — and `bun run connect`
    // with no flag still does all of them, which is the behaviour this must
    // not have inherited.
    expect(readdirSync(dir).includes(".codex")).toBe(false);
  });

  test("and refuses an agent this machine does not have", async () => {
    // Codex has neither a binary on PATH nor a config directory here. A route
    // that wrote a config for a CLI nobody has installed would leave a file
    // that never does anything and a pane claiming it is connected.
    const r = await connect("codex");
    expect(r.status).toBe(400);
    const body = await jsonOf(r);
    // Both, because they are set from different expressions: a body saying
    // `ok: true` under a 400 is what a client actually reads.
    expect(body.ok).toBe(false);
    expect(String(body.detail)).toContain("not installed");
    expect(readdirSync(dir).includes(".codex")).toBe(false);
  });

  test("and disconnecting takes it back out", async () => {
    const r = await jsonOf(await connect("gemini", true));
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(GEMINI(), "utf8"));
    expect(cfg.telemetry?.otlpEndpoint).toBeUndefined();
    expect(by((await agents()).agents, "gemini").connected).toBe(false);
  });

  test("backing the file up before it changes it", async () => {
    await connect("gemini");
    const backups = readdirSync(join(dir, ".gemini")).filter((f) => f.includes("bak"));
    expect(backups.length, "no backup was written").toBeGreaterThan(0);
    await connect("gemini", true);
  });
});

describe("leaving alone what is not ours", () => {
  test("a config pointing at somebody else's collector is not claimed", async () => {
    // Reporting it as connected would offer to disconnect something this app
    // never wired, and taking it out would break their setup.
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(GEMINI(), JSON.stringify({ telemetry: { enabled: true, otlpEndpoint: "https://otel.corp.example" } }));
    expect(by((await agents()).agents, "gemini").connected).toBe(false);
  });

  test("and a Codex block the user wrote is reported rather than overwritten", async () => {
    const codex = join(dir, ".codex", "config.toml");
    // The directory is what makes it look installed — see the note in beforeAll.
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const mine = '[otel]\nexporter = { otlp-http = { endpoint = "https://otel.corp.example" } }\n';
    writeFileSync(codex, mine);
    const r = await jsonOf(await connect("codex"));
    expect(String(r.detail)).toContain("leaving it");
    expect(readFileSync(codex, "utf8")).toBe(mine);
  });
});

describe("refusing what is not an agent", () => {
  test("an id nobody knows", async () => {
    const r = await connect("not-an-agent");
    expect(r.status).toBe(400);
    expect(String((await jsonOf(r)).error)).toContain("no such agent");
  });

  test("and an id that is not a string", async () => {
    for (const id of [null, 42, {}, undefined]) {
      expect((await connect(id)).status, String(id)).toBe(400);
    }
  });

  test("a body that is not JSON", async () => {
    const r = await fetch(base + "/agents/connect", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(r.status).toBe(400);
  });
});

/**
 * Last, and deliberately.
 *
 * Ingesting an event changes what every "nothing has arrived yet" assertion
 * above is looking at — the first version of this file put it near the top and
 * quietly broke a test three describes later. A suite whose order matters
 * should say so rather than be discovered.
 */
describe("once something actually reports", () => {
  test("an event makes its agent live, matched on the part of the name that is fixed", async () => {
    // Gemini's events arrive under whatever the CLI puts in its own
    // `service.name` — "gemini-cli" today, and not something this app chooses
    // or can pin. An exact match on `source_app` would report a reporting agent
    // as silent, which is the failure this whole pane exists to prevent.
    await fetch(base + "/ingest", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_app: "gemini-cli", session_id: "s-1", hook_event_type: "Stop", timestamp: Date.now(),
      }),
    });
    const g = by((await agents()).agents, "gemini");
    expect(g.seenAt, "an event under 'gemini-cli' did not match the agent").toBeGreaterThan(0);
    // …and it did not light up every other agent at the same time.
    expect(by((await agents()).agents, "codex").seenAt).toBeNull();
  });
});
