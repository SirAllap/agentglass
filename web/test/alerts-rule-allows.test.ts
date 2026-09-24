/*
 * The "nobody chose this" strip reads the last few resolved gates. A rule
 * writes a row for every call its allow list waves through, so a strip that
 * asked for the plain history would see twenty-five allowed Reads and none of
 * the denial it exists to show. It asks the server to leave those rows out.
 */
import { describe, expect, test } from "bun:test";

const alerts = await Bun.file(new URL("../src/components/Alerts.tsx", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();

describe("the unattended strip and a rule's allows", () => {
  test("Alerts asks for the history without a rule's allows", () => {
    expect(alerts).toMatch(/\.gateHistory\(\d+, \{ ruleAllows: false \}\)/);
  });

  test("the client sends that as rule_allows=0, which the server reads", () => {
    expect(api).toContain('opts?.ruleAllows === false ? "&rule_allows=0" : ""');
  });
});

const settings = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

describe("the activity pane and a rule's allows", () => {
  test("its long read leaves a rule's allows out, and a short one brings the recent ones back", () => {
    const pane = settings.slice(settings.indexOf("function ActivityPane"), settings.indexOf("const VERBS"));
    expect(pane).toContain("api.gateHistory(200, { ruleAllows: false })");
    expect(pane).toMatch(/api\.gateHistory\(50\)/);
  });
});
