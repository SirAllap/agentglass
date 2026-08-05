/*
 * Which agents are here, and — the half that matters — whether one is talking.
 *
 * Connecting a second agent is where people stop, and every failure in that
 * area looks like a successful write: a config in the right shape the CLI does
 * not read, a session started before the change, a typo in an endpoint. So the
 * assertion worth having is that "connected" and "an event arrived" stay two
 * separate facts, and that the pane can tell somebody which one they are in.
 *
 * `Bun.which` and the last-seen lookup are injected, because what is under test
 * is the judgement, not this container's PATH.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeAgents, agentState, ROSTER } from "../src/agentprobe.ts";
import type { AgentProbe } from "../../shared/types.ts";

let home: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agx-agents-"));
  saved = { HOME: process.env.HOME, CLAUDE: process.env.CLAUDE_CONFIG_DIR };
  /*
   * `HOME`, for every agent including Claude Code.
   *
   * hooksetup.ts resolves its settings path from `$HOME`, which is the same
   * thing `agentHome()` follows and the same thing the CLIs themselves read —
   * so one variable isolates all three. Setting `CLAUDE_CONFIG_DIR` instead
   * looked right and isolated nothing: `bun test` shares one process, an
   * earlier suite had left `HOME` pointing at a scratch tree with hooks
   * installed in it, and this file reported Claude Code as connected on a
   * machine where it had asserted nothing was.
   */
  process.env.HOME = home;
});
afterEach(() => {
  if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  if (saved.CLAUDE === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE;
});

const has = (...bins: string[]) => (c: string) => (bins.includes(c) ? `/usr/bin/${c}` : null);
const never = () => null;
const by = (rows: AgentProbe[], id: string) => rows.find((r) => r.id === id)!;

describe("what is on this machine", () => {
  test("an agent that is not installed is listed anyway, and says how to get it", () => {
    // A list of what is present says nothing about what is *supported*, which
    // is the question somebody has before they try a second agent at all.
    const rows = probeAgents(never, never);
    expect(rows).toHaveLength(ROSTER.length);
    for (const r of rows) {
      expect(r.found).toBe(false);
      expect(agentState(r)).toBe("missing");
      expect(r.install.length).toBeGreaterThan(0);
    }
  });

  test("one that is installed is found, and where", () => {
    const rows = probeAgents(has("gemini"), never);
    expect(by(rows, "gemini")).toMatchObject({ found: true, path: "/usr/bin/gemini" });
    expect(by(rows, "codex").found).toBe(false);
  });

  test("looks in the home the CLIs themselves use, not the one Bun reports", () => {
    /*
     * A real bug, found by a test that would not pass.
     *
     * Bun's `os.homedir()` resolves from the passwd entry and ignores `$HOME`.
     * Node prefers `$HOME` on POSIX, and so does Python's `Path.home()` — which
     * is what hooks/connect_otel.py writes through. On any machine where the
     * two differ (a container, `sudo -E`, CI) this module read a config the
     * installer had never written, and reported a correctly connected agent as
     * unconnected. `$HOME` is also what the CLIs read, so it is the right
     * answer rather than merely the consistent one.
     */
    process.env.HOME = home;
    for (const r of probeAgents(never, never)) {
      if (r.via !== "otel") continue;
      expect(r.configPath.startsWith(home + "/"), `${r.id} → ${r.configPath}`).toBe(true);
    }
  });

  test("and every entry that writes a config names the file", () => {
    // It is a file in somebody's home directory, so it is said rather than
    // implied — including for Claude Code, whose path comes from the hook
    // installer rather than from the roster.
    //
    // A `chat` agent is exempt because there is no such file: it reports by
    // being run from the chat panel, so connecting it writes nothing anywhere.
    // An empty path is the honest answer, and inventing one to satisfy this
    // would put a filename in the UI that nothing ever reads or writes.
    for (const r of probeAgents(never, never)) {
      if (r.via === "chat") { expect(r.configPath, r.id).toBe(""); continue; }
      expect(r.configPath, r.id).toBeTruthy();
      expect(r.configPath.length, r.id).toBeGreaterThan(1);
    }
  });
});

describe("connected, and actually reporting", () => {
  test("are two different facts", () => {
    // The state this whole pane exists for: a config was written and nothing
    // has arrived. Before, that was indistinguishable from working.
    const rows = probeAgents(has("gemini"), never);
    const g = by(rows, "gemini");
    expect(g.seenAt).toBeNull();
    expect(agentState({ ...g, connected: true })).toBe("waiting");
    expect(agentState({ ...g, connected: true, seenAt: 1 })).toBe("live");
  });

  test("an event makes it live even if the config is not recognised", () => {
    // A hand-written exporter config this app does not know how to read still
    // produces events, and reporting that agent as unconnected while its data
    // is on the dashboard would be the more confusing of the two mistakes.
    const g = by(probeAgents(has("gemini"), () => 1_700_000), "gemini");
    expect(g.connected).toBe(false);
    expect(g.seenAt).toBe(1_700_000);
    expect(agentState(g)).toBe("live");
  });

  test("installed but unwired is its own state, distinct from missing", () => {
    const g = by(probeAgents(has("gemini"), never), "gemini");
    expect(agentState(g)).toBe("ready");
    expect(agentState({ ...g, found: false })).toBe("missing");
  });

  test("the last-seen lookup is asked about a fragment, not an exact name", () => {
    // For an OTel agent, `source_app` is whatever the CLI puts in its own
    // `service.name` — this app does not choose it and cannot pin it.
    const asked: string[] = [];
    probeAgents(never, (m) => { asked.push(m); return null; });
    expect(asked).toEqual(ROSTER.map((a) => a.match));
    for (const m of asked) expect(m).not.toContain("/");
  });
});

describe("reading a config that already exists", () => {
  const geminiCfg = (obj: unknown) => {
    process.env.HOME = home;
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify(obj));
  };

  test("a Gemini config pointing here counts as connected", () => {
    geminiCfg({ telemetry: { enabled: true, traces: true, otlpEndpoint: "http://localhost:4000", otlpProtocol: "http" } });
    expect(by(probeAgents(has("gemini"), never), "gemini").connected).toBe(true);
  });

  test("and one on a different port still counts, because the port is not the point", () => {
    // A stricter match would report a server on 4001 as unconnected while its
    // events were arriving.
    geminiCfg({ telemetry: { enabled: true, otlpEndpoint: "http://127.0.0.1:4055" } });
    expect(by(probeAgents(has("gemini"), never), "gemini").connected).toBe(true);
  });

  test("one pointing somewhere else is left alone and reported as unconnected", () => {
    // Somebody's own collector. Claiming it as ours would offer to disconnect
    // something this app never wired.
    geminiCfg({ telemetry: { enabled: true, otlpEndpoint: "https://otel.corp.example" } });
    expect(by(probeAgents(has("gemini"), never), "gemini").connected).toBe(false);
  });

  test("telemetry switched off is not connected, whatever the endpoint says", () => {
    geminiCfg({ telemetry: { enabled: false, otlpEndpoint: "http://localhost:4000" } });
    expect(by(probeAgents(has("gemini"), never), "gemini").connected).toBe(false);
  });

  test("and a config that is not JSON costs the answer, not the probe", () => {
    process.env.HOME = home;
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), "{ not json");
    const rows = probeAgents(has("gemini"), never);
    expect(by(rows, "gemini").connected).toBe(false);
    expect(rows).toHaveLength(ROSTER.length);
  });

  test("a Codex config pointing here counts, and one that does not, does not", () => {
    process.env.HOME = home;
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(path, '[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:4000/v1/logs", protocol = "binary" } }\n');
    expect(by(probeAgents(has("codex"), never), "codex").connected).toBe(true);
    writeFileSync(path, '[otel]\nexporter = { otlp-http = { endpoint = "https://otel.corp.example", protocol = "binary" } }\n');
    expect(by(probeAgents(has("codex"), never), "codex").connected).toBe(false);
  });
});
