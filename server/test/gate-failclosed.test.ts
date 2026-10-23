/*
 * AGENTGLASS_GATE_FAILCLOSED=1 says "when agentglass cannot answer, deny". Two
 * paths allowed instead: a server address that is not this machine (which a
 * repo-local settings.json can set, so a repo could switch fail-closed off) and
 * a payload that is not JSON. Both now deny when fail-closed, and still allow
 * silently by default.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const python = ["python3", "python", "py"].find((exe) => spawnSync(exe, ["--version"], { stdio: "ignore" }).status === 0);
const GATE = join(import.meta.dir, "..", "..", "hooks", "gate_event.py");

function run(server: string, stdin: string, failClosed: boolean) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: server };
  if (failClosed) env.AGENTGLASS_GATE_FAILCLOSED = "1";
  const r = spawnSync(python!, [GATE, "--server", server], { env, input: stdin, encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() };
}
const decision = (out: string): string | undefined => (out ? JSON.parse(out).hookSpecificOutput?.permissionDecision : undefined);

describe.skipIf(!python)("gate fail-closed", () => {
  test("a non-local server denies when fail-closed, and allows silently otherwise", () => {
    expect(decision(run("http://example.com", "{}", true).out)).toBe("deny");
    expect(run("http://example.com", "{}", false)).toEqual({ status: 0, out: "" });
  });

  test("a payload that is not JSON denies when fail-closed, and allows silently otherwise", () => {
    expect(decision(run("http://127.0.0.1:9", "garbage", true).out)).toBe("deny");
    expect(run("http://127.0.0.1:9", "garbage", false)).toEqual({ status: 0, out: "" });
  });
});
