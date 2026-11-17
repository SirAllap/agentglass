/*
 * The limits the environment used to hold alone (shared/envLimits.ts) are settings: the stored value is
 * what the app uses until the variable is set, the variable wins and the door says so, and no agent moves
 * one. The last test reads the source: a raw read of a listed variable would make its row a lie.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { classOf } from "../../shared/settingClass.ts";
import { ENV_LIMITS } from "../../shared/envLimits.ts";
import { envLimit, envLimitHeldBy } from "../src/config.ts";
import { diskRoots } from "../src/disk.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("envlimits"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const row = async (id: string) => (await h.read(`/settings/door?id=${id}`, MACHINE)).body as { value: unknown; env?: { name: string; value: string } | null };

describe("limits the environment also holds", () => {
  test("a variable that is set wins, even empty, and the page is told which", () => {
    expect(envLimit("AGENTGLASS_GIT_TIMEOUT_SECONDS", { AGENTGLASS_GIT_TIMEOUT_SECONDS: "9" })).toBe("9");
    expect(envLimit("AGENTGLASS_COMMIT_DISABLED", { AGENTGLASS_COMMIT_DISABLED: "" })).toBe("");
    expect(envLimitHeldBy("AGENTGLASS_COMMIT_DISABLED", { AGENTGLASS_COMMIT_DISABLED: "1" })).toEqual({ name: "AGENTGLASS_COMMIT_DISABLED", value: "1" });
    expect(envLimitHeldBy("AGENTGLASS_COMMIT_DISABLED", {})).toBeNull();
  });

  test("none is an agent's to move, either way", () => {
    for (const l of ENV_LIMITS) expect(classOf(l.id)?.class, l.id).toBe("personOnly");
  });

  test("no listed variable is read raw: a stored value would not reach it", () => {
    const raw: string[] = [];
    for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: join(import.meta.dir, "..", "src"), absolute: true })) {
      const text = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      for (const l of ENV_LIMITS) if (new RegExp(`process\\.env(\\.|\\[["'])${l.env}\\b`).test(text)) raw.push(`${f}: ${l.env}`);
    }
    expect(raw).toEqual([]);
  });

  test("limits.diskRoots says what diskRoots() splits on: a colon, not a comma", () => {
    const hint = ENV_LIMITS.find((l) => l.id === "limits.diskRoots")!.hint;
    expect(hint).toContain("colon");
    expect(hint).not.toContain("Comma");
    process.env.AGENTGLASS_DISK_ROOTS = "/srv/orbit-a:/srv/orbit-b";
    try { expect(diskRoots().slice(1)).toEqual(["/srv/orbit-a", "/srv/orbit-b"]); } finally { delete process.env.AGENTGLASS_DISK_ROOTS; }
  });

  test("the spawn limit is read on every spawn, so it is not marked as read once at start", () => {
    expect(ENV_LIMITS.find((l) => l.id === "limits.spawnLimit")!.restart).toBeUndefined();
  });

  test("the folder-browsing switch is read at call time in every place, so its row does not wait for a restart", () => {
    expect(ENV_LIMITS.find((l) => l.id === "limits.fsBrowseDisabled")!.restart).toBeUndefined();
    const raw = readFileSync(join(import.meta.dir, "..", "src", "fsbrowse.ts"), "utf8");
    expect(raw).toContain("export const fsBrowseEnabled = (): boolean =>");
  });

  describe.skipIf(!have)("through the door", () => {
    test("the person stores a limit, and a wrong shape is refused and changes nothing", async () => {
      expect((await row("limits.gitTimeout")).value).toBe(0);
      expect(await h.asPerson("/settings/door", { id: "limits.gitTimeout", value: 45 })).toMatchObject({ status: 200, ok: true });
      expect((await row("limits.gitTimeout")).value).toBe(45);
      expect((await h.asPerson("/settings/door", { id: "limits.gitTimeout", value: 99999 })).ok).toBe(false);
      expect((await h.asPerson("/settings/door", { id: "limits.commitDisabled", value: "yes" })).ok).toBe(false);
      expect((await row("limits.gitTimeout")).value).toBe(45);
      expect(await h.asPerson("/settings/door", { id: "limits.commitDisabled", value: true })).toMatchObject({ ok: true });
      expect((await row("limits.commitDisabled")).value).toBe(true);
    });

    test("a seat can neither loosen nor tighten one", async () => {
      /* The stored value is on: turning it off loosens, and a different limit turned on tightens; neither waits as a request: both are refused outright. */
      expect(await h.asSeat("/settings/door", { id: "limits.commitDisabled", value: false })).toMatchObject({ status: 403, ok: false });
      expect(await h.asSeat("/settings/door", { id: "limits.editorDisabled", value: true })).toMatchObject({ status: 403, ok: false });
      expect((await row("limits.editorDisabled")).value).toBe(false);
      expect((await row("limits.commitDisabled")).value).toBe(true);
    });
  });
});
