/*
 * `openCodeLockLoosened` asks OpenCode for its rules and must not wait on
 * anything but OpenCode.
 *
 * OpenCode starts helpers of its own. A helper that outlives it keeps the write
 * end of a stdout pipe open, so a read to EOF waited for the helper: two of 41
 * loaded runs of the role-start tests hit their 30 s ceiling, and the 20 s kill
 * never helped because it reaches only the process it was sent to.
 *
 * The OpenCode here is a script on disk, so the test runs everywhere and does
 * not depend on the installed one. Its helper is a `sleep` it leaves behind,
 * and the test asserts on the pid the script wrote down, not on a pattern.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ops from "../src/agentops.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-oc-grandchild-"));
const helperPidFile = join(dir, "helper.pid");

afterAll(() => {
  // By pid, and only while it is still the sleep this file started.
  try {
    const pid = Number(readFileSync(helperPidFile, "utf8"));
    if (pid > 1 && readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("sleep\u000030")) process.kill(pid, "SIGKILL");
  } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nsleep 30 &\necho $! > "${helperPidFile}"\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: "build", permission: {} }) };

describe.skipIf(process.platform !== "linux")("the rules are read from OpenCode, not from whoever holds its pipe", () => {
  test("OpenCode answers and exits, a helper it left behind still holds stdout: the answer is not held up", async () => {
    const bin = fake("answers", `printf '%s' '{"permission":[]}'`);
    const t0 = Date.now();
    expect(await ops.openCodeLockLoosened(bin, dir, env)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The helper really was still there: the test would pass for the wrong reason otherwise.
    expect(existsSync(`/proc/${Number(readFileSync(helperPidFile, "utf8"))}`)).toBe(true);
  }, 15_000);

  test("OpenCode never answers: the wait ends at the deadline even though a helper holds stdout, and the lock is not vouched for", async () => {
    const bin = fake("hangs", `wait`);
    const t0 = Date.now();
    const why = await ops.openCodeLockLoosened(bin, dir, env, 500);
    expect(why).toContain("would not show");
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 15_000);
});
