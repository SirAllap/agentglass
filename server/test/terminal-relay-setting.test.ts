// The relay was on only with AGENTGLASS_TERMRELAY=1 in the server's
// environment. An app closed and opened again from the launcher starts
// without it, and the relay went off with nothing to say so. The choice is
// now stored, and the environment still wins when it speaks.
import { expect, test } from "bun:test";
import { relayHeldByEnv, relayWanted } from "../src/relay/wire.ts";
import { serverSettingDefs } from "../src/serverSettings.ts";
import { classOf } from "../../shared/settingClass.ts";

const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
// The switch is a row on the Advanced page's list, which advanced.tsx renders with data-setting={id}.
const advRows = await Bun.file(new URL("../../web/src/components/settings/pages/advancedRows.ts", import.meta.url)).text();
const advPage = await Bun.file(new URL("../../web/src/components/settings/pages/advanced.tsx", import.meta.url)).text();

test("the environment decides when it says 1 or 0, the stored choice when it does not", () => {
  for (const setting of [true, false]) {
    expect(relayWanted("1", setting)).toBe(true);
    expect(relayWanted("0", setting)).toBe(false);
    // Unset, empty, or a word that is neither: the person's choice stands.
    for (const env of [undefined, "", "true", "yes"]) expect(relayWanted(env, setting)).toBe(setting);
  }
  expect(relayHeldByEnv("1")).toBe("1");
  expect(relayHeldByEnv("0")).toBe("0");
  expect(relayHeldByEnv(undefined)).toBeNull();
  expect(relayHeldByEnv("yes")).toBeNull();
});

test("the server boots on that rule, not on the variable alone", () => {
  expect(index).toContain("const RELAY_ON = relayWanted(process.env.AGENTGLASS_TERMRELAY, terminalRelaySetting())");
  expect(index).not.toContain('process.env.AGENTGLASS_TERMRELAY === "1"');
});

test("terminal.relay is a setting with a class, a switch, and a refusal while the environment holds it", async () => {
  const def = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged() {} }).find((d) => d.id === "terminal.relay");
  expect(def).not.toBeUndefined();
  expect(def!.type).toBe("boolean");
  expect(def!.page).toBe("terminal");
  expect(def!.validate("on")).toEqual({ error: "true or false" });
  expect(classOf("terminal.relay")?.class).toBe("low");
  expect(advRows).toMatch(/\{ id: "terminal\.relay", key: "terminal\.relay", kind: "bool"/);
  expect(advPage).toContain("data-setting={id}");

  // Held by the environment: a write would be a choice that does nothing, so it is refused with the reason.
  const before = process.env.AGENTGLASS_TERMRELAY;
  try {
    process.env.AGENTGLASS_TERMRELAY = "0";
    const r = await def!.apply(true);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain("AGENTGLASS_TERMRELAY=0");
  } finally {
    if (before === undefined) delete process.env.AGENTGLASS_TERMRELAY; else process.env.AGENTGLASS_TERMRELAY = before;
  }
});
