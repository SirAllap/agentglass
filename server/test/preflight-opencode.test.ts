/*
 * Preflight on OpenCode: the engine the Reviewer's role picks, one stream of
 * `opencode run --format json` read back, and the argv that keeps the reviewer
 * read-only. The certificate records the engine and model that really ran, and
 * a run whose engine said nothing about cost says so instead of costing $0.00.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightFallbackNote, preflightLabel, preflightTarget } from "../../shared/preflightEngine.ts";
import { ISOLATION_OPENCODE, OPENCODE_STEPS, openCodeLock, parseOpenCodeTurn, runPreflight } from "../src/preflight.ts";

const STUB = new URL("./opencodePreflightStub.ts", import.meta.url).pathname;
let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-pfoc-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the engine is the Reviewer role's", () => {
  test("claude reviews on claude, with the model the role names", () => {
    const t = preflightTarget({ provider: "claude", model: "haiku" });
    expect(t).toEqual({ engine: "claude", model: "haiku", fellBack: false, reviewer: "claude" });
    expect(preflightLabel(t)).toBe("Claude · haiku");
    expect(preflightFallbackNote(t)).toBeNull();
  });

  test("an empty claude model is Sonnet", () => {
    expect(preflightTarget({ provider: "claude", model: "" })).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  test("opencode reviews on opencode, keeping its provider/model for the -m flag", () => {
    const t = preflightTarget({ provider: "opencode", model: "opencode-go/deepseek-v4.1-flash" });
    expect(t).toEqual({ engine: "opencode", model: "opencode-go/deepseek-v4.1-flash", fellBack: false, reviewer: "opencode" });
    expect(preflightLabel(t)).toBe("OpenCode · deepseek-v4.1-flash");
    expect(preflightFallbackNote(t)).toBeNull();
  });

  test("any other engine falls back to Claude Sonnet, and the card says so", () => {
    const t = preflightTarget({ provider: "codex", model: "gpt-something" });
    expect(t).toEqual({ engine: "claude", model: "sonnet", fellBack: true, reviewer: "codex" });
    expect(preflightLabel(t)).toBe("Claude · sonnet");
    expect(preflightFallbackNote(t)).toBe("Preflight runs on Claude sonnet: codex is not supported here yet");
  });
});

describe("parseOpenCodeTurn", () => {
  const stream = [
    JSON.stringify({ type: "step_start", timestamp: 1791655313013, sessionID: "ses_orbit01", part: { type: "step-start" } }),
    JSON.stringify({ type: "text", timestamp: 1791655313100, sessionID: "ses_orbit01", part: { type: "text", text: "Reading the material." } }),
    JSON.stringify({ type: "tool_use", sessionID: "ses_orbit01", part: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "MATERIAL.md" } } } }),
    JSON.stringify({ type: "text", timestamp: 1791655313900, sessionID: "ses_orbit01", part: { type: "text", text: "### F1 - Blocker - No way to check it\nQuote: it works on my machine\nEvidence: files/src/a.ts:12 says nothing runs it" } }),
    JSON.stringify({ type: "step_finish", timestamp: 1791655314100, sessionID: "ses_orbit01", part: { type: "step-finish", cost: 0.0041, modelID: "deepseek-v4.1-flash" } }),
  ].join("\n");

  test("text parts in order, the spend added up, and the model it said it ran", () => {
    const turn = parseOpenCodeTurn(stream);
    expect(turn.texts).toEqual(["Reading the material.", "### F1 - Blocker - No way to check it\nQuote: it works on my machine\nEvidence: files/src/a.ts:12 says nothing runs it"]);
    expect(turn.cost).toBeCloseTo(0.0041, 6);
    expect(turn.costKnown).toBe(true);
    expect(turn.model).toBe("deepseek-v4.1-flash");
    expect(turn.error).toBe("");
  });

  test("a subscription plan reports no cost, and that is not 0", () => {
    const turn = parseOpenCodeTurn(JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }));
    expect(turn.costKnown).toBe(false);
    expect(turn.cost).toBe(0);
  });

  test("an error event keeps its message; prose lines are not events", () => {
    const turn = parseOpenCodeTurn(`the model is rate limited\n${JSON.stringify({ type: "error", error: { name: "ProviderAuthError", data: { message: "no key for this provider" } } })}`);
    expect(turn.error).toBe("no key for this provider");
    expect(turn.texts).toEqual([]);
  });
});

describe("the OpenCode invocation", () => {
  test("read-only is in the lock the child is handed, and a step ceiling with it", () => {
    const lock = JSON.parse(openCodeLock()) as { default_agent: string; permission: Record<string, string>; agent: { build: { steps: number; permission: Record<string, string> } } };
    const readOnly = { edit: "deny", write: "deny", patch: "deny", bash: "deny", webfetch: "deny", websearch: "deny", task: "deny", subagent: "deny", external_directory: "deny" };
    expect(lock.permission).toEqual(readOnly);
    expect(lock.agent.build.permission).toEqual(readOnly);
    expect(lock.default_agent).toBe("build");
    expect(lock.agent.build.steps).toBe(OPENCODE_STEPS);
    expect(OPENCODE_STEPS).toBeGreaterThan(0);
  });

  test("a run on the opencode engine: read-only config, its model, the same prompt, and a certificate with the engine and no invented cost", async () => {
    const plan = join(dir, "ORBIT-1042.md");
    writeFileSync(plan, "# Plan\nRename the flag.\n");
    const record = join(dir, "record.json");
    const cert = await runPreflight(
      { files: [plan], engine: "opencode", model: "opencode-go/deepseek-v4.1-flash", budgetUsd: 0.5, id: "pf_oc" },
      { bin: [process.execPath, STUB], env: { STUB_RECORD: record } },
    );
    const r = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string>; cwd: string };
    expect(r.argv.slice(0, 5)).toEqual(["run", "--standalone", "--format", "json", "--agent"]);
    /* Without its own server the turn takes the person's background one and never
       reads OPENCODE_CONFIG_CONTENT, so the lock would be there and not applied. */
    expect(r.argv).toContain("--standalone");
    expect(r.argv).toContain("build");
    expect(r.argv[r.argv.indexOf("-m") + 1]).toBe("opencode-go/deepseek-v4.1-flash");
    expect(r.argv[r.argv.length - 2]).toBe("--");
    expect(r.argv[r.argv.length - 1]).toContain("MATERIAL.md");
    expect((JSON.parse(r.env.OPENCODE_CONFIG_CONTENT!) as { permission: { bash: string } }).permission.bash).toBe("deny");
    expect(r.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(r.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeNull();
    expect(cert.engine).toBe("opencode");
    expect(cert.model).toBe("deepseek-v4.1-flash");
    expect(cert.costKnown).toBe(false);
    expect(cert.costUsd).toBe(0);
    expect(cert.isolation).toBe(ISOLATION_OPENCODE);
    expect(cert.findings.map((f) => f.title)).toEqual(["No way to check it"]);
  });

  test("the claude engine keeps its argv and reports a known cost", async () => {
    const plan = join(dir, "ORBIT-1043.md");
    writeFileSync(plan, "# Plan\nKeep the flag.\n");
    const cert = await runPreflight(
      { files: [plan], model: "sonnet", budgetUsd: 0.5 },
      { bin: [process.execPath, new URL("./preflightStub.ts", import.meta.url).pathname], env: { STUB_REPLY: "No findings" } },
    );
    expect(cert.engine).toBe("claude");
    expect(cert.costKnown).toBeUndefined();
    expect(cert.costUsd).toBe(0.0123);
  });
});
