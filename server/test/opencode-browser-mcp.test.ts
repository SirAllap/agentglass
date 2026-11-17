import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { mcpConfigFor } from "../src/agents/headless.ts";
import { BROWSER_SERVER, compileEnvelope, openCodeMcpFor } from "../src/agents/envelope.ts";

/* Q89: OpenCode gets the browser entry exactly when Claude would, same tab name. */
const roles = ["builder", "reviewer", "verifier", "planner", "unknown-role"];
describe("browser MCP entry, both engines", () => {
  for (const id of roles) {
    test(`${id}: OpenCode has the entry iff Claude has it`, () => {
      const role = { id } as never;
      const claude = BROWSER_SERVER in mcpConfigFor(role, []).mcpServers;
      const oc = openCodeMcpFor(role, "alba").mcp;
      expect(!!oc?.[BROWSER_SERVER]).toBe(claude);
      if (claude) {
        const e = oc![BROWSER_SERVER] as { command: string[]; environment: { AGENTGLASS_BROWSER_AS: string } };
        expect(e.command).toEqual([(mcpConfigFor(role, []).mcpServers[BROWSER_SERVER] as { command: string }).command]);
        expect(e.environment.AGENTGLASS_BROWSER_AS).toBe("alba");
      }
    });
  }
  test("at least one role has the door and one does not", () => {
    const has = roles.map((id) => BROWSER_SERVER in mcpConfigFor({ id } as never, []).mcpServers);
    expect(has).toContain(true);
    expect(has).toContain(false);
  });
});

/* The real config: the lock compileEnvelope hands the OpenCode window carries the entry. */
describe("the OpenCode lock compileEnvelope builds", () => {
  const env = { write: "worktree", commit: true, network: false, docker: false, deny: [] } as never;
  for (const id of roles) {
    test(`${id}: mcp section iff the role has the door`, () => {
      const o = compileEnvelope("opencode", { id } as never, env, "", mkdtempSync(join(tmpdir(), "agx-oc-")));
      if (!o.ok) throw new Error(o.error);
      const cfg = JSON.parse(Object.values(o.env).find((v) => v.startsWith("{"))!) as { mcp?: Record<string, unknown> };
      expect(!!cfg.mcp?.[BROWSER_SERVER]).toBe(!!openCodeMcpFor({ id } as never).mcp);
    });
  }
});
