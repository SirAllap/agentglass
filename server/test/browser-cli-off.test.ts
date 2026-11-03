/*
 * A worker the app handed no browser credential is marked, and the CLI refuses
 * every verb under the marker — no request, no fallback to the person's token
 * file. The marker is the app's half of the contract (server/src/browseraccess.ts);
 * this runs the real script, because the refusal lives in it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../bin/agentglass-browser");
const python = Bun.which("python3");
let dir = "", base = "", calls = 0;
let srv: ReturnType<typeof Bun.serve> | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-cli-off-"));
  // The person's file, readable and tempting: a refusal must not touch it.
  mkdirSync(join(dir, "agentglass"));
  writeFileSync(join(dir, "agentglass", "token"), "mk_person_example_never_sent");
  srv = Bun.serve({ port: 0, fetch() { calls++; return new Response("{}", { headers: { "Content-Type": "application/json" } }); } });
  base = `http://127.0.0.1:${srv.port}`;
});
afterAll(() => { srv?.stop(true); rmSync(dir, { recursive: true, force: true }); });

async function run(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn({
    cmd: [python!, cli, ...args],
    env: {
      PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir,
      AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_STATE_DIR: join(dir, "state"), ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

describe.skipIf(!python)("a worker whose browser access is off", () => {
  test("refuses every verb without a request and without the person's token file", async () => {
    calls = 0;
    for (const argv of [["health"], ["read"], ["observe", "--shot"], ["--shared", "open", "https://example.test/"]]) {
      const r = await run({ AGENTGLASS_BROWSER_OFF: "1" }, ...argv);
      expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
      expect(r.err).toContain("browser access is off for this worker");
      expect(r.err).not.toContain("mk_person_example_never_sent");
      expect(r.out).not.toContain("mk_person_example_never_sent");
    }
    expect(calls).toBe(0);
  });

  test("the marker absent (or 0) is not a refusal", async () => {
    calls = 0;
    const r = await run({ AGENTGLASS_BROWSER_OFF: "0", AGENTGLASS_TOKEN: "tok-example" }, "health");
    // It got as far as the network: this stub answers, so the run is not the refusal.
    expect(r.err).not.toContain("browser access is off for this worker");
    expect(calls).toBeGreaterThan(0);
  });

  test("the MCP server refuses through the same marker", async () => {
    const mcp = join(import.meta.dir, "../../bin/agentglass-browser-mcp");
    const p = Bun.spawn({
      cmd: [python!, mcp],
      env: { PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_OFF: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    calls = 0;
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_health", arguments: {} } }) + "\n");
    await p.stdin.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain("browser access is off for this worker");
    expect(calls).toBe(0);
  });
});
