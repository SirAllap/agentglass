/*
 * Each MCP server that serves HTTP has a token of its own, and that token opens
 * only what that server opens: the machine's token, the browser's, the cockpit's
 * and the app-window's must be four different secrets. A server started with its
 * token equal to another's refuses to bind, so a shell that exports one value
 * under two names does not quietly turn the narrow door into the wide one.
 *
 * Each case starts the real file with `--http` and the two variables equal. A
 * refusal exits at once; the timeout is for the regression, where it would bind
 * and wait.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";

const HAVE_PY = !!Bun.which("python3");
const BIN = (name: string) => new URL(`../../bin/${name}`, import.meta.url).pathname;
const SHARED = "t".repeat(40);

const SERVERS: { bin: string; own: string; others: string[] }[] = [
  { bin: "agentglass-ui-mcp", own: "AGENTGLASS_UI_MCP_TOKEN", others: ["AGENTGLASS_TOKEN", "AGENTGLASS_MCP_TOKEN", "AGENTGLASS_COCKPIT_TOKEN"] },
  { bin: "agentglass-browser-mcp", own: "AGENTGLASS_MCP_TOKEN", others: ["AGENTGLASS_TOKEN", "AGENTGLASS_COCKPIT_TOKEN", "AGENTGLASS_UI_MCP_TOKEN"] },
  { bin: "agentglass-cockpit-mcp", own: "AGENTGLASS_COCKPIT_TOKEN", others: ["AGENTGLASS_TOKEN", "AGENTGLASS_MCP_TOKEN", "AGENTGLASS_UI_MCP_TOKEN"] },
];

async function start(bin: string, env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "agx-mcp-tok-"));
  try {
    const p = Bun.spawnSync(["python3", BIN(bin), "--http", `127.0.0.1:${await freePort()}`], {
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_CACHE_HOME: join(home, "k"), AGENTGLASS_SERVER: "http://127.0.0.1:1", ...env },
      stdout: "pipe", stderr: "pipe", timeout: 8000, killSignal: "SIGKILL",
    });
    return { code: p.exitCode, err: p.stderr.toString() };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe.skipIf(!HAVE_PY)("an MCP server's HTTP token must differ from the other doors' tokens", () => {
  for (const s of SERVERS) {
    for (const other of s.others) {
      test(`${s.bin}: ${s.own} equal to ${other} is refused`, async () => {
        const r = await start(s.bin, { [s.own]: SHARED, [other]: SHARED });
        expect(r.err).toContain(`${s.own} must not be ${other}`);
        expect(r.code).not.toBe(0);
        expect(r.code).not.toBeNull();
      });
    }
  }
});
