// The install guard that asks whether the deputy is mid-run.
//
// It went in to stop a reinstall killing an agent inside a worktree, and it did
// the opposite: the count came from `curl | grep -o | wc -l`, `grep` exits 1
// when it matches nothing, install-local.sh runs under `set -euo pipefail`, and
// so the answer "no runs at all" killed the install before it printed a word.
// Two green suites and a packaged build sat there unusable, with `EXIT=1` and
// an empty log as the only symptom.
//
// These tests drive the shell function against a stub that answers like the
// sidecar does, because the bug was in the exit code of a pipeline — reading
// the script would have shown a guard that looks exactly right.
import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";

const APPCTL = join(import.meta.dir, "..", "..", "electron", "appctl.sh");
const servers: { stop(): void }[] = [];

afterEach(() => { while (servers.length) servers.pop()!.stop(); });

/** A sidecar that answers /understudy/work/next with `running` rows. */
function stubSidecar(running: number): number {
  const runs = Array.from({ length: running }, (_, i) => ({ id: i + 1, state: "running" }));
  runs.push({ id: 99, state: "done" });
  const s = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, item: null, runs }) });
  servers.push(s);
  /* `Bun.serve` types `port` as possibly undefined; asked for 0, it is always
     the one the OS gave us. */
  return s.port!;
}

/** Call the guard the way install-local.sh calls it: under `set -euo pipefail`. */
async function guard(port: number, env: Record<string, string> = {}) {
  const p = Bun.spawn(
    ["bash", "-c", `set -euo pipefail; . "${APPCTL}"; refuse_if_deputy_busy`],
    { env: { ...process.env, AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: "t", ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

describe("the install guard", () => {
  test("lets the install through when the deputy has nothing running", async () => {
    const r = await guard(stubSidecar(0));
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test("refuses, and says how many, while runs are going", async () => {
    const r = await guard(stubSidecar(2));
    expect(r.code).toBe(1);
    expect(r.err).toContain("2 run(s) going");
  });

  test("lets the install through when nobody is listening at all", async () => {
    // An app that is not running has no agent to kill. The port is one the stub
    // just released, so nothing answers on it.
    const port = stubSidecar(0);
    servers.pop()!.stop();
    const r = await guard(port);
    expect(r.code).toBe(0);
  });

  test("AGENTGLASS_INSTALL_ANYWAY is the way past it", async () => {
    const r = await guard(stubSidecar(3), { AGENTGLASS_INSTALL_ANYWAY: "1" });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});
