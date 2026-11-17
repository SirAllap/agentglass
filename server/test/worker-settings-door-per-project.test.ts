/*
 * `agents.permissionMode` and `workers.*` resolve through the settings door
 * exactly like the other PER_PROJECT ids (preflightStore.ts): a seat's own
 * project, the person's explicit `root`, or the app-wide value with neither.
 *
 * Before this fix these three ids fell through doorRoot's final `{}` and
 * silently read and wrote the APP row no matter who asked or which root they
 * named: a seat in one project could flip another project's worker settings.
 *
 * `workers.mcpServers` resolves through the exact same doorRoot branch
 * exercised below (`id === "agents.permissionMode" || id.startsWith("workers.")`);
 * it is not repeated here because a non-empty value needs a configured
 * `~/.claude.json`, which this harness's server subprocess does not get.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness, other: string;

beforeAll(async () => {
  if (!have) return;
  h = await startHarness("settingsdoor");
  // A sibling of the seat's project, never a directory under it: seatSpeaksFor
  // (seat.ts) treats a path under the seat's own root as the seat's own
  // project (worktree support), so a nested "other" would silently pass as
  // "own" instead of exercising the refusal this file is testing.
  other = `${h.dir}-other-project`;
  mkdirSync(other);
}, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const valueAt = async (id: string, root: string, token: string) =>
  (await h.read(`/settings/door?id=${id}&root=${encodeURIComponent(root)}`, token)).body as { value: unknown };

describe.skipIf(!have)("agents.permissionMode and workers.projectSkills through the door", () => {
  test("a seat's write with no root lands in its own project, never APP", async () => {
    const before = await valueAt("agents.permissionMode", h.dir, MACHINE);
    expect(before.value).toBe("");
    const r = await h.asSeat("/settings/door", { id: "agents.permissionMode", value: "dontAsk" });
    expect(r).toMatchObject({ status: 200, ok: true });
    expect((await valueAt("agents.permissionMode", h.dir, MACHINE)).value).toBe("dontAsk");
    // Nobody asked for APP's own value to move: a project with no row of its own still reads "".
    expect((await valueAt("agents.permissionMode", other, MACHINE)).value).toBe("");
  });

  test("a seat widening to bypassPermissions waits for the person: the door never applies it on its own", async () => {
    const r = await h.asSeat("/settings/door", { id: "agents.permissionMode", value: "bypassPermissions" });
    expect(r).toMatchObject({ status: 202, ok: true, applied: false });
    // The stricter value this seat set a moment ago is still what is live.
    expect((await valueAt("agents.permissionMode", h.dir, MACHINE)).value).toBe("dontAsk");
  });

  test("a seat is refused writing another project's root, and nothing there moves", async () => {
    const r = await h.asSeat("/settings/door", { id: "agents.permissionMode", value: "bypassPermissions", root: other });
    expect(r.status).toBe(403);
    expect((await valueAt("agents.permissionMode", other, MACHINE)).value).toBe("");
    expect((await valueAt("agents.permissionMode", h.dir, MACHINE)).value).toBe("dontAsk");
  });

  test("the person's explicit root reaches the project it names, not APP", async () => {
    const before = await valueAt("workers.projectSkills", other, MACHINE);
    expect(before.value).toBe(true);
    const r = await h.asPerson("/settings/door", { id: "workers.projectSkills", value: false, root: other });
    expect(r).toMatchObject({ status: 200, ok: true });
    expect((await valueAt("workers.projectSkills", other, MACHINE)).value).toBe(false);
    // The seat's own project never saw this write.
    expect((await valueAt("workers.projectSkills", h.dir, MACHINE)).value).toBe(true);
  });

  test("workers.unixSockets written for a project lands on that project's row, not the app one", async () => {
    expect((await valueAt("workers.unixSockets", other, MACHINE)).value).toBe("off");
    const r = await h.asPerson("/settings/door", { id: "workers.unixSockets", value: "all", root: other });
    expect(r).toMatchObject({ status: 200, ok: true });
    expect((await valueAt("workers.unixSockets", other, MACHINE)).value).toBe("all");
    // Neither the seat's project nor the app-wide row (no root) saw it.
    expect((await valueAt("workers.unixSockets", h.dir, MACHINE)).value).toBe("off");
    expect(((await h.read("/settings/door?id=workers.unixSockets", MACHINE)).body as { value: unknown }).value).toBe("off");
  });
});
