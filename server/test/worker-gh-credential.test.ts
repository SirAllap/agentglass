/*
 * A worker's turn gets the person's own GitHub token for that turn only: in the
 * spawn environment, never in argv or the settings JSON, and only when the
 * envelope can reach GitHub.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GH_LIMIT, GH_TOKEN_FILE_VAR, dropGh, grantGh, serverGhToken } from "../src/agents/ghcred.ts";
import { GH_FILE_LINE, headlessTurn } from "../src/agents/headless.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("gh credential for one turn", () => {
  test("given only when the envelope has the network, through the environment", async () => {
    const off: Record<string, string> = {};
    expect(await grantGh(off, { network: false }, async () => TOKEN)).toBe(false);
    expect(off.GH_TOKEN).toBeUndefined();
    const on: Record<string, string> = {};
    expect(await grantGh(on, { network: true }, async () => TOKEN)).toBe(true);
    // Never in the environment the window is opened with (that rides in its command line): a 0600 file names it.
    expect(on.GH_TOKEN).toBeUndefined();
    expect(JSON.stringify(on)).not.toContain(TOKEN);
    const file = on[GH_TOKEN_FILE_VAR]!;
    expect(readFileSync(file, "utf8")).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    dropGh(on);
    expect(existsSync(file)).toBe(false);
    expect(on[GH_TOKEN_FILE_VAR]).toBeUndefined();
  });
  test("nobody signed in: nothing is set", async () => {
    const env: Record<string, string> = {};
    expect(await grantGh(env, { network: true }, async () => null)).toBe(false);
    expect(env).toEqual({});
  });
  test("a token-shaped answer is read from gh auth token only on success", async () => {
    expect(await serverGhToken(async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: "" }))).toBe(TOKEN);
    expect(await serverGhToken(async () => ({ code: 1, stdout: TOKEN, stderr: "" }))).toBeNull();
    expect(await serverGhToken(async () => ({ code: 0, stdout: "not a token!", stderr: "" }))).toBeNull();
  });
  test("the turn's argv carries no token, and the start answer says the honest limit", () => {
    // A directory of its own: a fixed /tmp/x was a plain file on one machine, the
    // turn threw while writing its MCP config, and the token check never ran.
    const dir = mkdtempSync(join(tmpdir(), "agx-ghcred-"));
    try {
      const t = headlessTurn({ engine: "claude", bin: "/usr/bin/claude", model: "sonnet", role: workerRole("builder")!, envelope: { ...DEFAULT_WORKER_ENVELOPE, network: true }, limits: { maxWorkers: 3, turnMinutes: 30, maxRetries: 1 }, prompt: "do x", cwd: dir, runDir: join(dir, ".run"), unwalledEngines: true /* not about the wall: a container without bubblewrap would refuse the start */ } as never);
      // A turn that failed to build has no argv to check, so it must not pass as clean.
      expect(t.ok).toBe(true);
      if (t.ok) expect(JSON.stringify(t.argv)).not.toContain(TOKEN);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(GH_LIMIT).toContain("cannot be revoked");
  });
  test("the wrapper turns the file into GH_TOKEN and deletes it", async () => {
    const line = GH_FILE_LINE;
    const env: Record<string, string> = {};
    await grantGh(env, { network: true }, async () => TOKEN);
    const file = env[GH_TOKEN_FILE_VAR]!;
    const r = Bun.spawnSync(["sh", "-c", `${line}; printf %s "$GH_TOKEN"`], { env: { PATH: process.env.PATH ?? "", ...env } });
    expect(r.stdout.toString()).toBe(TOKEN);
    expect(existsSync(file)).toBe(false);
  });
  test("the limit says what remains", () => {
    expect(GH_LIMIT).toContain("/proc/<pid>/environ");
  });
});
