/*
 * With no policy stored anywhere, `start --role` is the TUI under the role's
 * lock, exactly as before. Its own file and its own server because a policy,
 * once stored, cannot be taken back, and "nothing stored" is the precondition.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { startHarness, MACHINE, type Harness } from "./fixtures/workerHarness.ts";
import { roleLaunch, workerRole } from "../../shared/workerRoles.ts";
import { agentProvider } from "../../shared/agentKinds.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { deniedFor, narrowEnvelope } from "../src/agents/envelope.ts";
import { mergeSandboxIntoSettingsArgs, runFiles, sandboxFor } from "../src/agents/headless.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("wlegacy"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("a seat's role start with no policy stored", () => {
  test("is the TUI under the role's lock, and the row is the seat's", async () => {
    const r = await h.asSeat("/agents/named/start", { name: "legacy1", cwd: h.wt, role: "builder", keep: true });
    expect(r.ok).toBe(true);
    expect(r.result?.engine).toBeUndefined();
    const argv = await h.until(async () => readdirSync(h.logs).filter((n) => n.startsWith("tui-") && n.endsWith(".argv"))
      .map((n) => readFileSync(join(h.logs, n), "utf8").split("\0").filter(Boolean)).find((a) => a.includes("--settings") && a.includes("sonnet")));
    // The floor is the same one `compileEnvelope` applies — `roleStart` passes
    // `deniedFor(...)` rather than the bare DENIED_COMMANDS — so the expected
    // settings file is built the same way. Built with the default instead, this
    // compared against a lock that still let a worker run agentglass-agent and
    // its siblings, which is the hole the start path was fixed to close.
    // The lock is the floor PLUS what the start path adds on top, and the
    // test used to build only the floor, so it went red the day those landed:
    // the Agent tool ("Agent", and "Task" in older Claude Code) is denied unless the role may start subagents,
    // and the same network sandbox a policy-started turn gets is merged into
    // --settings. The start path is the stricter of the two, so the expected
    // lock is built with both rather than the start path loosened to match.
    const builder = workerRole("builder")!;
    const want = roleLaunch(agentProvider("claude")!, builder, "sonnet",
      deniedFor(DEFAULT_WORKER_ENVELOPE, builder), ["Agent", "Task"])!.args;
    // The server resolves its secret dirs and run folder from its own env, so
    // the expected lock is built against the harness's, then the env is put back.
    const was = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = h.dir;
    try {
      mergeSandboxIntoSettingsArgs(want, sandboxFor(builder, narrowEnvelope(DEFAULT_WORKER_ENVELOPE, null), h.wt, runFiles("legacy1", join(h.state, "worker-runs")).dir));
    } finally {
      if (was === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = was;
    }
    expect(argv[argv.indexOf("--settings") + 1]).toBe(want[want.indexOf("--settings") + 1]!);
    // And the floor is really in it: the browser door is open to a builder, the
    // three it must not reach are not.
    const lock = JSON.parse(want[want.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } };
    expect(lock.permissions.deny).toContain("Bash(agentglass-agent:*)");
    expect(lock.permissions.deny).not.toContain("Bash(agentglass-browser:*)");
    expect(argv).not.toContain("-p");
    const a = await h.row("legacy1");
    expect(a?.seatRoot).toBe(h.dir);
    expect(a?.startedBy).toBeUndefined();
    // The role is on the row all the same: the Flow counts a project's workers
    // by it, and this start is a builder whether or not a policy decided it.
    expect(a?.role).toBe("builder");
    await h.asSeat("/agents/named/stop", { name: "legacy1" });
  }, 30_000);

  test("the board counts it as its role, so the Flow is not empty with it running", async () => {
    expect((await h.asSeat("/agents/named/start", { name: "legacy3", cwd: h.wt, role: "builder", keep: true })).ok).toBe(true);
    // The row first (cheap), then one board read: the board is the expensive
    // request and polling it is what a loaded runner cannot afford.
    await h.until(async () => (await h.row("legacy3")) ? true : undefined);
    const r = await h.read("/agents/board", MACHINE);
    const row = (r.body.agents ?? []).find((x: { name?: string }) => x.name === "legacy3");
    expect(row?.worker?.role).toBe("builder");
    expect(row?.state).toBe("working");
    await h.asSeat("/agents/named/stop", { name: "legacy3" });
  }, 60_000);

  test("a worker of that kind can still report to its seat: the wall is for policy-started workers", async () => {
    expect((await h.asSeat("/agents/named/start", { name: "legacy2", cwd: h.wt, role: "builder", keep: true })).ok).toBe(true);
    const r = await h.asSeat("/seat/say", { root: h.dir, line: "still here" }, { "X-Agentglass-Agent": "legacy2" });
    expect(r.status).not.toBe(403);
    await h.asSeat("/agents/named/stop", { name: "legacy2" });
  }, 30_000);
});
