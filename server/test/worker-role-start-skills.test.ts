/*
 * `start --role` with no orchestration policy stored for the project never
 * goes through `headlessTurn` (policystart.ts `startNow`): it is the plain
 * TUI lock `AgentOps.startAgent` has always used (policystart.ts's own
 * top-of-file comment). That path never knew about `workers.projectSkills`
 * — a project that turned it on, with no policy stored, got none of its own
 * skills in a worker's Skill tool, because the worker's `cwd` can be a
 * worktree whose `.claude` is not what the project keeps (index.ts, the
 * `start` route, the `AgentOps.startAgent` call).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;

beforeAll(async () => { if (have) h = await startHarness("rolestartskills"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

describe.skipIf(!have)("a role start with no stored policy still stages workers.projectSkills", () => {
  test("on (the default): the TUI's --plugin-dir carries the project's own skill, staged from the project root, not the worker's worktree cwd", async () => {
    mkdirSync(join(h.dir, ".claude", "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(h.dir, ".claude", "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\nDo the demo thing.\n");
    const before = h.callsOf("claude").length;
    const r = await h.asSeat("/agents/named/start", { name: "probe-on", cwd: h.wt, role: "builder" });
    expect(r).toMatchObject({ ok: true });
    await h.until(async () => h.callsOf("claude").length > before);
    const argv = h.callsOf("claude").at(-1)!.argv;
    expect(argv).toContain("--plugin-dir");
    const staged = argv[argv.indexOf("--plugin-dir") + 1]!;
    expect(readFileSync(join(staged, "skills", "demo-skill", "SKILL.md"), "utf8")).toContain("Do the demo thing.");
    await h.asSeat("/agents/named/stop", { name: "probe-on" });
  });

  test("off: no --plugin-dir at all", async () => {
    const off = await h.asSeat("/settings/door", { id: "workers.projectSkills", value: false });
    expect(off).toMatchObject({ status: 200, ok: true });
    const before = h.callsOf("claude").length;
    const r = await h.asSeat("/agents/named/start", { name: "probe-off", cwd: h.wt, role: "builder" });
    expect(r).toMatchObject({ ok: true });
    await h.until(async () => h.callsOf("claude").length > before);
    const argv = h.callsOf("claude").at(-1)!.argv;
    expect(argv).not.toContain("--plugin-dir");
    await h.asSeat("/agents/named/stop", { name: "probe-off" });
  });
});
