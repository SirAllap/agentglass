/*
 * `workers.memoryMax` is the ceiling one worker's scope runs under. Stored in
 * the config file the scopes already read, the environment's
 * AGENTGLASS_SCOPE_MEMORY_MAX wins and the door says so, and raising it waits
 * for the person; a lower number is a narrowing wherever the caller is not
 * confined to one project (the class row, tested below).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { MACHINE, startHarness, type Harness } from "./fixtures/workerHarness.ts";
import { classOf } from "../../shared/settingClass.ts";
import { memoryMaxEnv, scopeSettings } from "../src/scopes.ts";

const have = !!Bun.which("tmux") && !!Bun.which("python3");
let h: Harness;
beforeAll(async () => { if (have) h = await startHarness("memorymax"); }, SERVER_BOOT_MS);
afterAll(async () => { if (have) await h.stop(); });

const value = async () => ((await h.read("/settings/door?id=workers.memoryMax", MACHINE)).body as { value: unknown }).value;

describe("workers.memoryMax", () => {
  test("a lower number is a narrowing and a higher one or automatic is not", () => {
    const narrows = (prev: unknown, next: unknown) => classOf("workers.memoryMax")?.narrows?.(prev, next);
    expect(narrows("20G", "8G")).toBe(true);
    expect(narrows("8G", "20G")).toBe(false);
    expect(narrows("1024M", "2G")).toBe(false);
    expect(narrows("", "8G")).toBe(false);
    expect(narrows("8G", "")).toBe(false);
  });

  test("the stored value is what scopes uses, and the environment wins over it", () => {
    const meminfo = "MemTotal:       65536000 kB\n";
    expect(scopeSettings({}, { memoryMax: "6G" }, meminfo).memoryMax).toBe("6G");
    expect(scopeSettings({ AGENTGLASS_SCOPE_MEMORY_MAX: "9G" }, { memoryMax: "6G" }, meminfo).memoryMax).toBe("9G");
    expect(memoryMaxEnv({ AGENTGLASS_SCOPE_MEMORY_MAX: "9G" })).toEqual({ name: "AGENTGLASS_SCOPE_MEMORY_MAX", value: "9G" });
    expect(memoryMaxEnv({ AGENTGLASS_SCOPE_MEMORY_MAX: "lots" })).toBeNull();
    expect(memoryMaxEnv({})).toBeNull();
  });

  describe.skipIf(!have)("through the door", () => {
    test("the person sets a size, and a bad one is refused and changes nothing", async () => {
      expect(await value()).toBe("");
      expect(await h.asPerson("/settings/door", { id: "workers.memoryMax", value: "12g" })).toMatchObject({ status: 200, ok: true });
      expect(await value()).toBe("12G");
      const bad = await h.asPerson("/settings/door", { id: "workers.memoryMax", value: "plenty" });
      expect(bad.ok).toBe(false);
      expect(await value()).toBe("12G");
    });

    test("a seat is held to its own project, so an app-wide ceiling is never its to change, lower or higher", async () => {
      for (const v of ["40G", "6G"]) {
        expect(await h.asSeat("/settings/door", { id: "workers.memoryMax", value: v })).toMatchObject({ status: 202, applied: false });
      }
      expect(await value()).toBe("12G");
    });
  });
});
