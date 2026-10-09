/*
 * The lens looks at the newest push to the default branch through `gh`, and what
 * that costs is counted: the branch name once, the run, its jobs when it failed,
 * and two requests for each failed job read. A stub `gh` answers like the real
 * one and logs every call it gets.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { story } from "./story.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-lens-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(join(dir, "body.txt"), "2026-10-01T10:00:01.0000000Z error: timeout after 20000ms\n2026-10-01T10:00:01.0000000Z (fail) orbit sync > gives its slot back [20000.1ms]\n");
const stub = join(dir, "gh");
writeFileSync(stub, `#!/bin/sh
echo "$*" >> "$AGX_STUB_CALLS"
case "$*" in
  *annotations*) echo '[]' ;;
  *"/logs"*) printf 'HTTP/1.1 200 OK\\r\\nContent-Length: %s\\r\\n\\r\\n' "$(wc -c < "$AGX_STUB_BODY")"; cat "$AGX_STUB_BODY" ;;
  *"--jq .default_branch"*) echo main ;;
  *"actions/runs?branch=main"*) echo '{"workflow_runs":[{"id":9001,"head_sha":"abc123","conclusion":"failure","updated_at":"2026-10-01T10:05:00Z"}]}' ;;
  *"runs/9001/jobs"*) echo '{"jobs":[{"id":9101,"name":"build","conclusion":"failure","completed_at":"2026-10-01T10:04:00Z","steps":[{"name":"Tests (server)","conclusion":"failure"}]},{"id":9102,"name":"lint","conclusion":"success"}]}' ;;
esac
`);
chmodSync(stub, 0o755);

async function refresh() {
  const calls = join(dir, "calls.txt");
  writeFileSync(calls, "");
  const script = `import { failingTestsFor } from ${JSON.stringify(new URL("../src/prs.ts", import.meta.url).pathname)};
    console.log(JSON.stringify(await failingTestsFor("gh:acme/orbit", true)));`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, NODE_ENV: "test", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "t.db"), AGX_STUB_CALLS: calls, AGX_STUB_BODY: join(dir, "body.txt") },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(err).not.toContain("error:");
  return { got: JSON.parse(out.trim().split("\n").pop()!), lines: readFileSync(calls, "utf8").split("\n").filter(Boolean) };
}

const step = story();

describe("refreshing the lens through gh", () => {
  step("a red newest main push: the branch, the run, its jobs, then two requests per failed job", async () => {
    const { got, lines } = await refresh();
    expect(lines).toHaveLength(1 + 1 + 1 + 2);
    expect(got.refresh).toMatchObject({ main: "red", read: 1, requests: 5, pending: 0 });
    expect(got.rows[0]).toMatchObject({ title: "orbit sync > gives its slot back", check: "build", verdict: { kind: "main" } });
  });

  step("pressed again it costs ONE request: the run, and nothing it already has", async () => {
    const { got, lines } = await refresh();
    // the branch name and the run's jobs are kept: only the run itself is asked again
    expect(lines).toHaveLength(1);
    expect(got.refresh).toMatchObject({ main: "red", read: 0, requests: 1 });
  });
});
