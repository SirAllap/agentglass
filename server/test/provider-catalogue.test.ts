/*
 * One table of providers, and the four lists that used to be written apart.
 *
 * The tab menu, the requirements roster, a run leg's spellings and the chat
 * panel's roster each held their own copy of "which CLIs exist", and they
 * disagreed about which ones. They are now views of shared/agentKinds.ts. The
 * pins below are the rows each list held before it became a view: moving the
 * data must not move what any of them says about the CLIs they already had.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_KINDS, AGENT_PROVIDERS, agentKind } from "../../shared/agentKinds.ts";
import { ROSTER } from "../src/agentprobe.ts";
import { SPELLINGS } from "../src/agents/launch.ts";
import { agentArgv } from "../src/agentticket.ts";

let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "agx-catalogue-"));
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
});

describe("the provider table", () => {
  test("every id is written once", () => {
    const ids = AGENT_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const roster = ROSTER.map((r) => r.id);
    expect(new Set(roster).size).toBe(roster.length);
  });

  test("the tab menu is the four it had, in the same order, and Qwen Code after them", () => {
    expect(AGENT_KINDS.map((a) => a.id)).toEqual(["claude", "codex", "gemini", "opencode", "qwen"]);
    // Antigravity is a provider but has never been started in a pane, so a
    // route validating a tab kind still refuses it.
    expect(agentKind("antigravity")).toBeUndefined();
  });

  test("the requirements roster holds the same four CLIs with the same words", () => {
    const home = process.env.HOME!;
    const rows = Object.fromEntries(ROSTER.map((r) => [r.id, { ...r, configPath: r.configPath() }]));
    expect(Object.keys(rows).sort()).toEqual(["antigravity", "claude-code", "codex", "gemini"]);
    expect(rows["gemini"]).toEqual({
      id: "gemini", label: "Gemini CLI", bin: "gemini", via: "otel",
      configPath: join(home, ".gemini", "settings.json"), match: "gemini",
      install: "npm i -g @google/gemini-cli", connects: "OpenTelemetry traces → /v1/traces",
    });
    expect(rows["codex"]).toEqual({
      id: "codex", label: "OpenAI Codex CLI", bin: "codex", via: "otel",
      configPath: join(home, ".codex", "config.toml"), match: "codex",
      install: "npm i -g @openai/codex", connects: "OpenTelemetry logs → /v1/logs",
    });
    expect(rows["antigravity"]).toEqual({
      id: "antigravity", label: "Google Antigravity", bin: "agy", via: "chat",
      configPath: "", match: "antigravity",
      install: "https://antigravity.google/docs/cli",
      connects: "the chat panel, which turns its own turns into events",
    });
    const { configPath: claudePath, ...claude } = rows["claude-code"]!;
    expect(claude).toEqual({
      id: "claude-code", label: "Claude Code", bin: "claude", via: "hooks", match: "claude",
      install: "npm i -g @anthropic-ai/claude-code", connects: "hooks that post each event to this server",
    });
    // The hook installer's path, which follows HOME like the rest.
    expect(claudePath.startsWith(home)).toBe(true);
  });

  test("a run leg spells each CLI as it did", () => {
    expect(SPELLINGS).toEqual({
      "claude-code": { bypass: "--dangerously-skip-permissions", promptFlag: "" },
      antigravity: { bypass: "--dangerously-skip-permissions", promptFlag: "" },
      codex: { bypass: "--dangerously-bypass-approvals-and-sandbox", promptFlag: "" },
      gemini: { bypass: "--yolo", promptFlag: "-i" },
    });
  });
});

describe("Qwen Code on the tab menu", () => {
  test("opens with the prompt seeded, the way the Gemini CLI it forked from does", () => {
    expect(agentArgv("/usr/bin/qwen", { prompt: "map the auth module", yolo: false, title: "", kind: "qwen" }, false))
      .toEqual(["/usr/bin/qwen", "--prompt-interactive", "map the auth module"]);
  });

  test("buys no permission flag and no session name, because none has been offered for it", () => {
    expect(agentArgv("/usr/bin/qwen", { prompt: "go", yolo: true, title: "ORBIT-1042", kind: "qwen" }, true))
      .toEqual(["/usr/bin/qwen", "--prompt-interactive", "go"]);
  });
});
