/*
 * `workers.mcpServers`: Off / Read-only / All, per server (default Off).
 * Read-only puts a known server's write tools in the turn's `--settings`
 * deny list (`mcpDenyFor`, envelope.ts); All is an agent's never (All needs
 * the person, shared/settingClass.ts).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpDenyFor } from "../src/agents/envelope.ts";
import { headlessTurn } from "../src/agents/headless.ts";
import { agentVerdict } from "../../shared/settingClass.ts";
import { workerRole } from "../../shared/workerRoles.ts";
import type { Envelope } from "../../shared/orchestration.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-mcp-readonly-"));
const restore = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTGLASS_DB: process.env.AGENTGLASS_DB, AGENTGLASS_STATE_DIR: process.env.AGENTGLASS_STATE_DIR };
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.AGENTGLASS_DB = join(dir, "mcp-readonly.db");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");
const { putSetting, workerMcpModes } = await import("../src/preflightStore.ts");
afterAll(() => {
  for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
});

const NARROW: Envelope = { write: "worktree", network: false, commit: false, docker: false, deny: [] };
const builder = workerRole("builder")!;

describe("mcpDenyFor: the deny entries a chosen server's mode adds", () => {
  test("Read-only on a known server adds its write-tool globs", () => {
    const d = mcpDenyFor([{ name: "atlassian", mode: "readOnly" }]);
    for (const g of ["mcp__atlassian__create*", "mcp__atlassian__transition*", "mcp__atlassian__executeWrite", "mcp__atlassian__executeDestructive"]) {
      expect(d).toContain(g);
    }
  });

  test("All adds nothing: the server keeps every tool", () => {
    expect(mcpDenyFor([{ name: "atlassian", mode: "all" }])).toEqual([]);
  });

  test("an unknown server set to Read-only (never reached through validate) denies nothing, rather than guessing", () => {
    expect(mcpDenyFor([{ name: "acme-tool", mode: "readOnly" }])).toEqual([]);
  });

  test("a server with no mode adds nothing", () => {
    expect(mcpDenyFor([{ name: "atlassian" }])).toEqual([]);
  });
});

describe("a Read-only turn's --settings really deny the write tools", () => {
  const t = (mode: "readOnly" | "all") => headlessTurn({
    engine: "claude", bin: "/x/claude", model: "sonnet", role: builder, envelope: NARROW,
    limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "go", cwd: "/w/orbit",
    mcpServers: [{ name: "atlassian", config: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" }, mode }],
  }) as { argv: string[] };
  const denyOf = (turn: { argv: string[] }) =>
    (JSON.parse(turn.argv[turn.argv.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }).permissions.deny;

  test("Read-only: the write tools are in the deny list", () => {
    const deny = denyOf(t("readOnly"));
    expect(deny).toContain("mcp__atlassian__create*");
    expect(deny).toContain("mcp__atlassian__executeDestructive");
  });

  test("All: none of those entries ride on the turn", () => {
    const deny = denyOf(t("all"));
    expect(deny).not.toContain("mcp__atlassian__create*");
    expect(deny).not.toContain("mcp__atlassian__executeDestructive");
  });
});

describe("an agent's own change to workers.mcpServers", () => {
  const ID = "workers.mcpServers";

  test("choosing Read-only on a known server is a widening: it waits unless the person trusts the project", () => {
    expect(agentVerdict(ID, {}, { atlassian: "readOnly" }, false)).toBe("ask");
    expect(agentVerdict(ID, {}, { atlassian: "readOnly" }, true)).toBe("apply");
  });

  test("turning a server back off always applies: it only narrows", () => {
    expect(agentVerdict(ID, { atlassian: "readOnly" }, {}, false)).toBe("apply");
  });

  test("All is refused for an agent, trusted or not: that direction is only the person's", () => {
    expect(agentVerdict(ID, {}, { atlassian: "all" }, true)).toBe("refuse");
    expect(agentVerdict(ID, { atlassian: "readOnly" }, { atlassian: "all" }, true)).toBe("refuse");
  });

  test("a server already on All staying on All is not a new widening: it still applies for a trusted project", () => {
    expect(agentVerdict(ID, { atlassian: "all" }, { atlassian: "all" }, true)).toBe("apply");
  });
});

describe("a project that chose servers before per-server modes existed", () => {
  const ID = "workers.mcpServers";
  const root = join(dir, "old-array-project");

  test("workerMcpModes reads the old stored array as each name at All, not dropped", () => {
    putSetting(root, "workers.mcpServers", ["atlassian"]);
    expect(workerMcpModes(root)).toEqual({ atlassian: "all" });
  });

  test("old array to Read-only narrows: it was already on All", () => {
    expect(agentVerdict(ID, ["atlassian"], { atlassian: "readOnly" }, false)).toBe("apply");
  });

  test("old array to empty narrows too: turning a server back off", () => {
    expect(agentVerdict(ID, ["atlassian"], {}, false)).toBe("apply");
  });

  test("old array to the same server still on All is not a new widening", () => {
    expect(agentVerdict(ID, ["atlassian"], { atlassian: "all" }, false)).toBe("apply");
  });
});
