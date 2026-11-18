/*
 * The commands no role's grant can lift (NEVER_LIFTABLE) are refused to every worker's shell unless a
 * project's person opens one by name. Opening is only the person's, closing is anyone's, and a grant in a
 * flow file still lifts none of them: only the setting does, and only for the project that holds it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { agentVerdict } from "../../shared/settingClass.ts";
import { deniedFor } from "../src/agents/envelope.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { FIXED_COMMANDS, NEVER_LIFTABLE, SWITCHABLE_COMMANDS, workerRole } from "../../shared/workerRoles.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness, other: string;
beforeAll(async () => {
  if (!have) return;
  h = await startHarness("commands");
  other = `${h.dir}-other-project`;
  mkdirSync(other);
}, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const idOf = (cmd: string) => `workers.commands.${cmd.replace(/ /g, "-")}`;
const valueAt = async (id: string, root: string) => ((await h.read(`/settings/door?id=${id}&root=${encodeURIComponent(root)}`, MACHINE)).body as { value: unknown }).value;

describe("the deny list", () => {
  const builder = workerRole("builder")!;
  test("every one is denied by default, and an opened one is the only one that is not", () => {
    const shut = deniedFor(DEFAULT_WORKER_ENVELOPE, builder);
    for (const c of NEVER_LIFTABLE) expect(shut, c).toContain(c);
    const open = deniedFor(DEFAULT_WORKER_ENVELOPE, builder, ["rm"]);
    expect(open).not.toContain("rm");
    for (const c of NEVER_LIFTABLE.filter((x) => x !== "rm")) expect(open, c).toContain(c);
  });
  test("a role's own grant still lifts none of them", () => {
    const granted = { ...builder, allow: [...NEVER_LIFTABLE] };
    const lifted = { ...DEFAULT_WORKER_ENVELOPE, commit: true, network: true, docker: true };
    for (const c of NEVER_LIFTABLE) expect(deniedFor(lifted, granted), c).toContain(c);
  });
  test("opening one never opens a command the floor keeps besides it", () => {
    const open = deniedFor(DEFAULT_WORKER_ENVELOPE, builder, ["git push"]);
    expect(open).not.toContain("git push");
    // Only what the envelope's flags narrow is still denied beside it: the network and docker are off by default; commit and merge are open now.
    for (const c of ["docker", "curl", "sudo"]) expect(open, c).toContain(c);
  });
});

describe("the class", () => {
  test("an agent may close one and never open one, trusted or not", () => {
    // A worker has its seat's powers: the fixed floor is `sudo` and the `git worktree` verbs that point a worktree at another gitdir.
    // `git push` and `gh` are switchable now (open by default), and the base never-rules own the trunk.
    expect([...FIXED_COMMANDS].sort()).toEqual(["git worktree lock", "git worktree move", "git worktree repair", "git worktree unlock", "sudo"]);
    // Nothing is fixed AND switchable: the never-liftable floor is the fixed list, the switchable ones are open by default and a project closes them.
    expect([...FIXED_COMMANDS].sort()).toEqual([...NEVER_LIFTABLE].sort());
    for (const c of SWITCHABLE_COMMANDS) expect(FIXED_COMMANDS, c).not.toContain(c);
    for (const c of SWITCHABLE_COMMANDS) {
      expect(agentVerdict(idOf(c), true, false, false), c).toBe("apply");
      expect(agentVerdict(idOf(c), false, true, false), c).toBe("refuse");
      expect(agentVerdict(idOf(c), false, true, true), c).toBe("refuse");
    }
  });
});

describe.skipIf(!have)("through the door", () => {
  test("the person opens one for one project and no other, and an agent cannot", async () => {
    const id = idOf("ssh");
    // Open by default now: the person closes one for one project, and an agent can never open it again.
    expect(await valueAt(id, other)).toBe(true);
    expect(await h.asPerson("/settings/door", { id, value: false, root: other })).toMatchObject({ status: 200, ok: true });
    expect(await valueAt(id, other)).toBe(false);
    expect(await valueAt(id, h.dir)).toBe(true);
    expect(await h.asPerson("/settings/door", { id: idOf("rm"), value: false, root: other })).toMatchObject({ ok: true });
    expect(await h.asSeat("/settings/door", { id: idOf("rm"), value: true, root: other })).toMatchObject({ ok: false });
    expect(await valueAt(idOf("rm"), other)).toBe(false);
  });
});
