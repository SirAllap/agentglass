// cleanup.config through the settings door's definition: per project, validated
// before it is stored, empty until set, and an escalation for an agent.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVerdict, classOf } from "../../shared/settingClass.ts";

const HOME = mkdtempSync(join(tmpdir(), "agx-cleanup-settings-"));
process.env.XDG_CONFIG_HOME = HOME;
const { serverSettingDefs, cleanupConfigOf } = await import("../src/serverSettings.ts");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const def = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === "cleanup.config")!;
const ROOT = "/work/orbit", OTHER = "/work/acme";

describe("cleanup.config", () => {
  test("is per project and empty until a project says it", () => {
    expect(def.scoped).toBe(true);
    expect(def.isSet!(ROOT)).toBe(false);
    expect(cleanupConfigOf(ROOT)).toMatchObject({ testDbPrefix: "", briefsDir: "", sharedContainerNames: [] });
  });

  test("a valid value is stored for that project only and read back", async () => {
    const v = def.validate({ sharedContainerNames: ["orbit-db"], testDbPrefix: "acme_test_" }, ROOT);
    expect(v).toHaveProperty("value");
    expect(await def.apply((v as { value: unknown }).value, ROOT)).toEqual({ ok: true });
    expect(def.isSet!(ROOT)).toBe(true);
    expect(cleanupConfigOf(ROOT).sharedContainerNames).toEqual(["orbit-db"]);
    expect((def.read(ROOT) as { testDbPrefix: string }).testDbPrefix).toBe("acme_test_");
    expect(def.isSet!(OTHER)).toBe(false);
    expect(cleanupConfigOf(OTHER).sharedContainerNames).toEqual([]);
  });

  test("a value the engine could not use is refused with a reason, before anything is stored", () => {
    expect(def.validate({ evidenceDirs: ["/ev/{slug}/x"] }, OTHER)).toHaveProperty("error");
    expect(def.validate("nope", OTHER)).toHaveProperty("error");
    expect(def.isSet!(OTHER)).toBe(false);
  });

  test("an agent's change waits for the person: it widens what gets deleted", () => {
    expect(classOf("cleanup.config")?.class).toBe("escalation");
  });
});

describe("cleanup.mode, cleanup.autoCleanDays, cleanup.include", () => {
  const defs = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} });
  const get = (id: string) => defs.find((d) => d.id === id)!;
  const R = "/work/mode-project";

  test("defaults: ask, 0 days (never), every kind but the agent's session history", () => {
    expect(get("cleanup.mode").read(R)).toBe("ask");
    expect(get("cleanup.autoCleanDays").read(R)).toBe(0);
    expect(get("cleanup.include").read(R)).toEqual(["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch"]);
    expect(get("cleanup.evidenceRoots").read(R)).toEqual([]);
    for (const id of ["cleanup.mode", "cleanup.autoCleanDays", "cleanup.include", "cleanup.evidenceRoots"]) expect(get(id).scoped).toBe(true);
  });

  test("values are validated, stored per project and read back", async () => {
    expect(get("cleanup.mode").validate("sometimes", R)).toHaveProperty("error");
    expect(get("cleanup.autoCleanDays").validate(-1, R)).toHaveProperty("error");
    expect(get("cleanup.autoCleanDays").validate(1.5, R)).toHaveProperty("error");
    expect(get("cleanup.include").validate(["docker", "root"], R)).toHaveProperty("error");
    await get("cleanup.mode").apply("auto", R);
    await get("cleanup.autoCleanDays").apply(14, R);
    await get("cleanup.include").apply(["worktree", "branch"], R);
    expect(get("cleanup.mode").read(R)).toBe("auto");
    expect(get("cleanup.mode").read(OTHER)).toBe("ask");
    expect(cleanupConfigOf(R).include).toEqual(["worktree", "branch"]);
    expect(cleanupConfigOf(OTHER).include).toHaveLength(8);
  });

  test("an agent may tighten at once and must wait for the person to loosen", () => {
    const v = (id: string, prev: unknown, next: unknown) => agentVerdict(id, prev, next, false);
    expect(v("cleanup.mode", "ask", "off")).toBe("apply");
    expect(v("cleanup.mode", "auto", "atMerge")).toBe("apply");
    expect(v("cleanup.mode", "ask", "atMerge")).toBe("ask");
    expect(v("cleanup.mode", "off", "ask")).toBe("ask");
    expect(v("cleanup.mode", "atMerge", "auto")).toBe("ask");
    expect(v("cleanup.autoCleanDays", 7, 0)).toBe("apply");
    expect(v("cleanup.autoCleanDays", 7, 30)).toBe("apply");
    expect(v("cleanup.autoCleanDays", 7, 3)).toBe("ask");
    expect(v("cleanup.autoCleanDays", 0, 30)).toBe("ask");
    expect(v("cleanup.include", ["docker", "tab"], ["tab"])).toBe("apply");
    expect(v("cleanup.include", ["tab"], ["docker", "tab"])).toBe("ask");
    expect(v("cleanup.include", ["tab"], ["tab", "agent-history"])).toBe("ask");
    expect(v("cleanup.evidenceRoots", ["/ev/a", "/ev/b"], ["/ev/a"])).toBe("apply");
    expect(v("cleanup.evidenceRoots", ["/ev/a"], ["/ev/a", "/ev/b"])).toBe("ask");
  });
});
