/*
 * A flow role's `allow` at the moment it reaches the engine: a save takes a
 * prefix (a history rewrite, a cloud provider CLI) that no ceiling lifts, and
 * what the engine is handed must still deny it. Own file, because it starts
 * real workers: a booted server, the fake engines first on PATH and its own
 * tmux socket (fixtures/workerHarness.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("flow-allow"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

/** The template flow plus `allow-orbit`: Claude, writing, and two grants. */
async function saveAllowFlow(): Promise<void> {
  const cur = await (await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, { headers: { Authorization: `Bearer ${MACHINE}` } })).json() as { flow: { roster: Record<string, unknown>[] } };
  const base = cur.flow.roster[0]!;
  const flow = {
    ...cur.flow,
    roster: [...cur.flow.roster, {
      ...base, id: "allow-orbit", name: "Allow orbit", does: "Runs what it may", prompt: "ALLOW ORBIT",
      policyRole: undefined, chain: [{ engine: "claude", model: "sonnet" }], tools: [], readsOnly: false, required: false,
      // `git merge` is not never-liftable, so the save takes it; no ceiling lifts it.
      allow: ["docker", "git merge"], resolvedChain: undefined,
    }],
  };
  const res = await fetch(`${h.base}/flow?root=${encodeURIComponent(h.dir)}`, {
    method: "PUT", body: JSON.stringify(flow),
    headers: { "Content-Type": "application/json", Origin: h.base, Authorization: `Bearer ${MACHINE}` },
  });
  const body = await res.json() as { ok: boolean; error?: string };
  if (!body.ok) throw new Error(`flow refused: ${body.error}`);
}

describe.skipIf(!have)("the grant a flow role asks for, at the start", () => {
  test("what the ceiling does not lift never reaches the engine's argv", async () => {
    await saveAllowFlow();
    /* The denial list the Claude turn was handed, read off the argv the stub
       ran. A TUI turn's call is written beside the turn (workerHarness.ts), so
       the one this start made is the file that was not there before it. */
    const denyFor = async (name: string, extra: Record<string, unknown> = {}): Promise<string[]> => {
      const before = new Set(readdirSync(h.logs));
      const r = await h.asSeat("/agents/named/start", { name, cwd: h.wt, flowRole: "allow-orbit", prompt: "x", ...extra });
      expect(r.ok).toBe(true);
      // The argv file is the event this reads: the stub writes it once its turn
      // is done, so waiting for the worker's exit as well only adds the server's
      // own turn-end poll, a delay that grows under load and tells nothing here.
      const argv = await h.until(async () => {
        const file = readdirSync(h.logs).find((n) => /^tui-\d+\.argv$/.test(n) && !before.has(n));
        return file ? readFileSync(join(h.logs, file), "utf8").split("\0").filter(Boolean) : undefined;
      });
      const settings = argv[argv.indexOf("--settings") + 1]!;
      return (JSON.parse(settings) as { permissions: { deny: string[] } }).permissions.deny;
    };
    // Commit is the one thing this ceiling lifts: both grants are dropped, and
    // the lock the engine is handed still denies them.
    const off = await denyFor("w-allow-off");
    expect(off).toContain("Bash(docker:*)");
    // `git merge` left the worker floor with the seat's powers: the base never-rules own the trunk.
    expect(off).not.toContain("Bash(git merge:*)");
    // A ceiling that lifts docker still does not lift it for a worker whose own
    // envelope does not have it: only the start asking for it does, and the
    // grant then reaches the argv. `git merge` has no lift anywhere.
    await h.usePolicy({ ceiling: { docker: true } });
    const unasked = await denyFor("w-allow-unasked");
    expect(unasked).toContain("Bash(docker:*)");
    const on = await denyFor("w-allow-on", { allow: ["docker"] });
    expect(on).not.toContain("Bash(docker:*)");
    expect(on).not.toContain("Bash(git merge:*)");
  }, 60_000);
});
