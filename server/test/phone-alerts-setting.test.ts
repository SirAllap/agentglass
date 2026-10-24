/*
 * "Alerts on paired phones": one switch the server keeps, so the desk can show
 * it and an agent can read it through the settings door. On until the person
 * turns it off; only `false` is off, so a hand-edited config cannot silence it
 * by accident.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVerdict, classOf } from "../../shared/settingClass.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const HOME = join(tmpdir(), `agx-phone-alerts-${process.pid}`);
process.env.XDG_CONFIG_HOME = HOME;

let cfg: typeof import("../src/config.ts");
let defsOf: typeof import("../src/serverSettings.ts").serverSettingDefs;
beforeAll(async () => {
  mkdirSync(join(HOME, "agentglass"), { recursive: true });
  cfg = await import("../src/config.ts");
  defsOf = (await import("../src/serverSettings.ts")).serverSettingDefs;
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = REAL_XDG;
});

const def = () => defsOf({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === "phone.alerts")!;

describe("phone.alerts", () => {
  test("a fresh install has it on", () => {
    rmSync(join(HOME, "agentglass", "config.json"), { force: true });
    expect(cfg.phoneAlerts()).toBe(true);
    expect(def().read()).toBe(true);
  });

  test("off and on again are stored and read back", () => {
    expect(cfg.writePhoneAlerts(false).ok).toBe(true);
    expect(cfg.phoneAlerts()).toBe(false);
    expect(def().read()).toBe(false);
    expect(cfg.writePhoneAlerts(true).ok).toBe(true);
    expect(cfg.phoneAlerts()).toBe(true);
  });

  test("only a real false turns it off", () => {
    writeFileSync(join(HOME, "agentglass", "config.json"), JSON.stringify({ phoneAlerts: "no" }));
    cfg.writePhoneAlerts(true);
    expect(cfg.phoneAlerts()).toBe(true);
  });

  test("the door takes a boolean and nothing else", () => {
    expect(def().validate(false)).toEqual({ value: false });
    for (const raw of ["false", 0, null, undefined, "off"]) expect(def().validate(raw)).toHaveProperty("error");
  });

  test("it lives on the Notifications page, with a low class an agent may change at once", () => {
    expect(def().page).toBe("notifications");
    expect(classOf("phone.alerts")?.class).toBe("low");
    expect(agentVerdict("phone.alerts", true, false, false)).toBe("apply");
    expect(agentVerdict("phone.alerts", false, true, false)).toBe("apply");
  });
});
