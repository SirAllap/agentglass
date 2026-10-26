import { describe, expect, test } from "bun:test";
import { AGENT_PROVIDERS, agentProvider, type Provider } from "../../shared/agentKinds.ts";
import { extractVersion, versionAtLeast } from "../../shared/semverLite.ts";
import { __running, screenNeedsYou } from "../src/chatpane.ts";
import { SHAPE, STATUS_DEFAULT, type FakeEngineId } from "./fixtures/fakeEngines.ts";

// The table's ids and the fakes' file names differ for one engine.
const FAKE: Record<string, FakeEngineId> = {
  claude: "claude", codex: "codex", gemini: "gemini", opencode: "opencode", hermes: "hermes", antigravity: "agy",
};
const get = (id: string): Provider => agentProvider(id)!;

describe("the table keeps its shape", () => {
  test("the providers are the same, in the same order", () => {
    expect(AGENT_PROVIDERS.map((p) => p.id)).toEqual(
      ["claude", "antigravity", "hermes", "codex", "gemini", "opencode", "qwen"]);
  });
});

describe("version", () => {
  test("every provider with a tab can be asked for its version", () => {
    for (const p of AGENT_PROVIDERS.filter((x) => x.tab)) {
      expect(p.version, p.id).toBeDefined();
      expect(p.version!.args.length, p.id).toBeGreaterThan(0);
    }
  });

  test("each pattern compiles and picks the number out of that engine's own banner", () => {
    for (const p of AGENT_PROVIDERS.filter((x) => x.version && FAKE[x.id])) {
      const banner = SHAPE[FAKE[p.id]].version;
      const got = extractVersion(banner, p.version!.pattern);
      expect(got, `${p.id}: ${banner}`).toMatch(/^\d+\.\d+\.\d+$/);
      // the number in the banner, not another one in it
      expect(banner.includes(got!), p.id).toBe(true);
    }
    expect(extractVersion("2.1.296 (Claude Code)", get("claude").version!.pattern)).toBe("2.1.296");
    expect(extractVersion("codex-cli 0.157.1", get("codex").version!.pattern)).toBe("0.157.1");
    expect(extractVersion("1.18.32", get("opencode").version!.pattern)).toBe("1.18.32");
    expect(extractVersion("qwen 0.3.1", get("qwen").version!.pattern)).toBe("0.3.1");
  });

  test("opencode reads both the bare number and the `opencode v2.0.32` banner", () => {
    const pattern = get("opencode").version!.pattern;
    expect(extractVersion("1.18.32", pattern)).toBe("1.18.32");
    expect(extractVersion("opencode v2.0.32", pattern)).toBe("2.0.32");
  });

  test("a banner that is not this engine's gives nothing, and a pattern that is not a regex too", () => {
    expect(extractVersion("codex-cli 0.157.1", get("hermes").version!.pattern)).toBeNull();
    expect(extractVersion("anything 1.2.3", "(")).toBeNull();
  });

  test("Hermes is held to the first release with the stream format, and says why", () => {
    const v = get("hermes").version!;
    expect(v.min).toBe("0.21.4");
    expect(v.minWhy).toMatch(/output format/);
    expect(AGENT_PROVIDERS.filter((p) => p.version?.min).map((p) => p.id)).toEqual(["hermes"]);
    const ok = (banner: string) => versionAtLeast(extractVersion(banner, v.pattern) ?? "", v.min!);
    expect(ok("Hermes Agent v0.21.0 (2026.8.31) · upstream 9a71d5a8")).toBe(false);
    expect(ok("Hermes Agent v0.21.5 (2026.9.24)")).toBe(true);
    expect(ok("not hermes")).toBe(false);
  });
});

describe("versionAtLeast", () => {
  test("compares numbers, not strings", () => {
    expect(versionAtLeast("0.21.0", "0.21.4")).toBe(false);
    expect(versionAtLeast("0.21.10", "0.21.4")).toBe(true);
    expect(versionAtLeast("0.21.4", "0.21.4")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
    expect(versionAtLeast("", "0.0.1")).toBe(false);
  });

  test("a banner is compared after its pattern has taken the number out", () => {
    const got = extractVersion("v0.21.5 (2026.9.21)", "v(\\d+\\.\\d+\\.\\d+)")!;
    expect(versionAtLeast(got, "0.21.4")).toBe(true);
  });
});

describe("account", () => {
  const SIGNED_OUT: Record<string, string> = {
    claude: '{\n  "loggedIn": false\n}',
    codex: "Not logged in",
    hermes: "◆ Auth Providers\n  Nous Portal   ✗ not logged in (run: hermes model)",
    opencode: "Credentials ~/.local/share/opencode/auth.json: 0 credentials",
  };

  test("the signed-in pattern matches what each CLI prints signed in, and not signed out", () => {
    for (const id of Object.keys(SIGNED_OUT)) {
      const a = get(id).account!;
      const re = new RegExp(a.signedIn, "m");
      expect(re.test(STATUS_DEFAULT[FAKE[id]]), `${id} signed in`).toBe(true);
      expect(re.test(SIGNED_OUT[id]), `${id} signed out`).toBe(false);
    }
  });

  test("the real multi-line status of Claude Code matches too", () => {
    expect(new RegExp(get("claude").account!.signedIn).test('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}')).toBe(true);
  });

  test("only OpenCode may be used without an account", () => {
    expect(AGENT_PROVIDERS.filter((p) => p.account?.optional).map((p) => p.id)).toEqual(["opencode"]);
  });

  test("an engine nobody has seen answer a status question has no account facet", () => {
    for (const id of ["gemini", "antigravity", "qwen"]) expect(get(id).account, id).toBeUndefined();
  });
});

describe("headless and envelope", () => {
  test("a headless engine says how a follow-up names its session", () => {
    for (const p of AGENT_PROVIDERS.filter((x) => x.headless)) expect(p.headless!.resume, p.id).not.toBe("");
    expect(get("hermes").headless!.ceilings).toEqual({ turns: "--max-turns", seconds: "--run-budget" });
    expect(get("claude").headless!.ceilings).toEqual({ usd: "--max-budget-usd" });
    expect(get("codex").headless!.resume).toBe("exec resume");
  });

  test("Gemini's headless form is left out: nobody has run it", () => {
    expect(get("gemini").headless).toBeUndefined();
    expect(get("gemini").envelope).toBeUndefined();
  });

  test("an envelope agrees with the lock the role code already uses", () => {
    const via = { flag: "settings-flag", env: "config-env", file: "config-env" } as const;
    for (const p of AGENT_PROVIDERS.filter((x) => x.lock)) {
      expect(p.envelope?.via, p.id).toBe(via[p.lock!.via]);
    }
  });

  test("Hermes's check is the dry run that exits 3 on a denied push", () => {
    expect(get("hermes").envelope).toEqual({
      via: "own-config",
      check: { args: ["approvals", "test", "--", "git", "push", "origin", "main"], exit: 3 },
    });
  });
});

describe("screen", () => {
  test("Claude's patterns see the same screens as the chat pane's own", () => {
    const s = get("claude").screen!;
    const needs = new RegExp(s.needsYou);
    const running = new RegExp(s.running, "i");
    for (const screen of ["Esc to cancel", "Enter to confirm", "Yes, to use this session only", "idle > ", "esc to interrupt"]) {
      expect(needs.test(screen), screen).toBe(screenNeedsYou(screen));
      expect(running.test(screen), screen).toBe(__running(screen));
    }
    expect(needs.test("Enter to confirm")).toBe(true);
    expect(running.test("Esc to interrupt")).toBe(true);
  });

  test("only engines whose screens were captured have one (seat-engine.test.ts holds the fixtures)", () => {
    expect(AGENT_PROVIDERS.filter((p) => p.screen).map((p) => p.id)).toEqual(["claude", "opencode"]);
  });
});
