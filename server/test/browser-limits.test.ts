/*
 * What a worker's browser may reach, from Settings ▸ Browser: the verb groups,
 * and the origin and profile allow lists. The defaults are what shipped, the
 * operator's environment variable still wins, and each refusal names the row
 * that lifts it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedCfg = process.env.XDG_CONFIG_HOME;
const configDir = mkdtempSync(join(tmpdir(), "agx-browser-limits-"));
process.env.XDG_CONFIG_HOME = configDir;

import { agentAskRefusal, noteWorkerPage, resetWorkerPages } from "../src/browserdrive.ts";
import { limitEnv, originsAllow, profilesAllow, workerVerbGroups } from "../src/browserLimits.ts";
import { writeBrowserLimit } from "../src/config.ts";
import { allowListNarrows, cleanAllowList, cleanVerbGroups, verbGroupsNarrow } from "../../shared/browserLimits.ts";

const OWN = "orbit-1";
const PAGE = "t9-own";

beforeEach(() => {
  delete process.env.AGENTGLASS_BROWSER_ORIGINS;
  delete process.env.AGENTGLASS_BROWSER_PROFILES;
  for (const k of ["origins", "profiles", "verbs"] as const) writeBrowserLimit(k, k === "verbs" ? ["read", "act"] : ["*"]);
  resetWorkerPages();
  noteWorkerPage(OWN, PAGE);
});
afterAll(() => {
  delete process.env.AGENTGLASS_BROWSER_ORIGINS;
  delete process.env.AGENTGLASS_BROWSER_PROFILES;
  if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedCfg;
  rmSync(configDir, { recursive: true, force: true });
});

const ask = (op: string, extra: Record<string, unknown> = {}) => agentAskRefusal({ as: OWN, page: PAGE, ...extra }, OWN, op);

describe("verb groups", () => {
  test("the default is read and act: today's table", () => {
    expect(workerVerbGroups()).toEqual(["read", "act"]);
    expect(ask("read")).toBeNull();
    expect(ask("click", { selector: "#go" })).toBeNull();
    for (const op of ["eval", "cookies", "trace"]) expect(ask(op), op).not.toBeNull();
  });
  test("a refused verb names the group that lifts it", () => {
    expect(ask("eval")).toContain("Settings ▸ Browser ▸ Worker verbs lifts it: turn on Eval");
    expect(ask("cookies")).toContain("turn on Cookies and storage");
    expect(ask("trace")).toContain("turn on DevTools");
    expect(ask("settings")).toContain("No setting lifts it");
  });
  test("turning eval on lifts eval and nothing else", () => {
    writeBrowserLimit("verbs", ["read", "act", "eval"]);
    expect(ask("eval", { js: "1+1" })).toBeNull();
    expect(ask("cookies")).not.toBeNull();
    expect(ask("trace")).not.toBeNull();
  });
  test("a lifted verb is still the worker's own page: another page is refused", () => {
    writeBrowserLimit("verbs", ["read", "act", "eval"]);
    expect(agentAskRefusal({ as: OWN, page: "t9-theirs" }, OWN, "eval")).toContain("not one it opened");
    expect(agentAskRefusal({ as: OWN, page: PAGE, shared: true }, OWN, "eval")).not.toBeNull();
  });
  test("turning act off refuses click and keeps read", () => {
    writeBrowserLimit("verbs", ["read"]);
    expect(ask("click", { selector: "#go" })).toContain("Worker verbs lifts it: turn on Act");
    expect(ask("read")).toBeNull();
  });
  test("cleaning and narrowing", () => {
    expect("error" in cleanVerbGroups(["read", "bogus"])).toBe(true);
    expect(cleanVerbGroups(["eval", "read"])).toEqual({ value: ["read", "eval"] });
    expect(verbGroupsNarrow(["read", "act", "eval"], ["read", "act"])).toBe(true);
    expect(verbGroupsNarrow(["read", "act"], ["read", "act", "eval"])).toBe(false);
  });
});

describe("origin and profile lists", () => {
  test("the default is every origin and every profile", () => {
    expect(originsAllow()).toEqual(["*"]);
    expect(profilesAllow()).toEqual(["*"]);
  });
  test("a stored list is read on the next call", () => {
    writeBrowserLimit("origins", ["localhost:8001", "example.com"]);
    expect(originsAllow()).toEqual(["localhost:8001", "example.com"]);
  });
  test("the environment variable wins when set, and the page can say so", () => {
    writeBrowserLimit("origins", ["example.com"]);
    process.env.AGENTGLASS_BROWSER_ORIGINS = "localhost:9000";
    expect(originsAllow()).toEqual(["localhost:9000"]);
    expect(limitEnv("origins")).toEqual({ name: "AGENTGLASS_BROWSER_ORIGINS", value: "localhost:9000" });
    delete process.env.AGENTGLASS_BROWSER_ORIGINS;
    expect(originsAllow()).toEqual(["example.com"]);
    expect(limitEnv("origins")).toBeNull();
  });
  test("cleaning, and only a shorter list narrows", () => {
    expect(cleanAllowList([" a ", "", "a", "b"], "origins")).toEqual({ value: ["a", "b"] });
    expect(cleanAllowList([], "origins")).toEqual({ value: ["*"] });
    expect(allowListNarrows(["*"], ["a"])).toBe(true);
    expect(allowListNarrows(["a", "b"], ["a"])).toBe(true);
    expect(allowListNarrows(["a"], ["a", "b"])).toBe(false);
    expect(allowListNarrows(["a"], ["*"])).toBe(false);
  });
});

describe("the origin and profile refusals name the row that lifts them", () => {
  test("every refusal built from the lists ends with the setting", async () => {
    const src = await Bun.file(new URL("../src/browserdrive.ts", import.meta.url).pathname).text();
    expect(src).not.toContain("in AGENTGLASS_BROWSER_ORIGINS");
    expect(src.match(/\$\{originsLift\(\)\}/g)?.length).toBeGreaterThanOrEqual(4);
    expect(src).toContain("${profilesLift()}");
    expect(src).toContain("Settings ▸ Browser ▸ Allowed origins");
    expect(src).toContain("Settings ▸ Browser ▸ Allowed profiles");
  });
});
