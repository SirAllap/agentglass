/*
 * The app's own doors a worker's shell is denied (agentglass-agent, -ui,
 * -cockpit-mcp) are closed unless a project's person opens one. Opening is
 * only the person's, closing is anyone's, and the browser door stays
 * browser.workers' alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { agentVerdict } from "../../shared/settingClass.ts";
import { deniedFor } from "../src/agents/envelope.ts";
import { DEFAULT_WORKER_ENVELOPE } from "../../shared/orchestration.ts";
import { workerRole } from "../../shared/workerRoles.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness, other: string;
beforeAll(async () => {
  if (!have) return;
  h = await startHarness("appdoors");
  other = `${h.dir}-other-project`;
  mkdirSync(other);
}, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const DOOR = "agentglass-ui";
const id = `workers.appDoors.${DOOR}`;
const valueAt = async (root: string) => ((await h.read(`/settings/door?id=${id}&root=${encodeURIComponent(root)}`, MACHINE)).body as { value: unknown }).value;

describe("the deny list", () => {
  const builder = workerRole("builder")!;
  test("all three doors are denied by default, and an opened one is not", () => {
    const shut = deniedFor(DEFAULT_WORKER_ENVELOPE, builder);
    for (const d of ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"]) expect(shut).toContain(d);
    const open = deniedFor(DEFAULT_WORKER_ENVELOPE, builder, ["agentglass-ui"]);
    expect(open).not.toContain("agentglass-ui");
    expect(open).toContain("agentglass-agent");
    expect(open).toContain("agentglass-cockpit-mcp");
  });
  test("opening a door never opens the commands the floor keeps", () => {
    const open = deniedFor(DEFAULT_WORKER_ENVELOPE, builder, ["agentglass-agent", "agentglass-ui", "agentglass-cockpit-mcp"]);
    // `git push` and `rm` left the floor with the seat's powers (the base never-rules guard the trunk); sudo and the worktree verbs stay.
    expect(open).toContain("sudo");
    expect(open).toContain("git worktree repair");
    expect(open).not.toContain("git push");
  });
});

describe("the class", () => {
  test("an agent may close a door and never open one, trusted or not", () => {
    expect(agentVerdict(id, true, false, false)).toBe("apply");
    expect(agentVerdict(id, false, true, false)).toBe("refuse");
    expect(agentVerdict(id, false, true, true)).toBe("refuse");
  });
});

describe.skipIf(!have)("through the door", () => {
  test("the person opens it for one project and no other, and an agent cannot", async () => {
    expect(await valueAt(other)).toBe(false);
    expect(await h.asPerson("/settings/door", { id, value: true, root: other })).toMatchObject({ status: 200, ok: true });
    expect(await valueAt(other)).toBe(true);
    expect(await valueAt(h.dir)).toBe(false);
    const seat = await h.asSeat("/settings/door", { id, value: true });
    expect(seat.ok).toBe(false);
    expect(await valueAt(h.dir)).toBe(false);
  });
});
