/*
 * Which custom field is the PR link and which is the swatch, as the pure
 * functions the board reads. The default is the guess the panel always made;
 * a name typed into Settings replaces it, and a name that matches nothing on a
 * card means the card has none (it does not fall back to the guess).
 */
import { describe, expect, test } from "bun:test";
import { prLinkValue, swatchField } from "../src/lib/clickupFields.ts";

const f = (name: string, value = "v", color?: string) => ({ id: name, name, value, ...(color ? { color } : {}) }) as never;

describe("prLinkValue", () => {
  const custom = [f("Github Url", "https://example.invalid/acme/orbit/pull/7"), f("Review link", "https://example.invalid/r/1")];
  test("default: the first field with github in its name", () => {
    expect(prLinkValue(custom)).toBe("https://example.invalid/acme/orbit/pull/7");
    expect(prLinkValue(custom, "")).toBe("https://example.invalid/acme/orbit/pull/7");
    expect(prLinkValue(custom, "   ")).toBe("https://example.invalid/acme/orbit/pull/7");
  });
  test("a named field wins, case and spaces aside", () => {
    expect(prLinkValue(custom, " review LINK ")).toBe("https://example.invalid/r/1");
  });
  test("a named field the card does not have is no link, not the guess", () => {
    expect(prLinkValue(custom, "Merge request")).toBe("");
  });
  test("no fields at all", () => {
    expect(prLinkValue(undefined)).toBe("");
    expect(prLinkValue(undefined, "Github Url")).toBe("");
  });
});

describe("swatchField", () => {
  const custom = [f("Severity", "high", "#e05252"), f("Pod", "Blue", "#2ea1e5"), f("Notes", "x")];
  test("default: a team-sounding coloured field, else the first coloured one", () => {
    expect(swatchField(custom)?.name).toBe("Pod");
    expect(swatchField([f("Severity", "high", "#e05252"), f("Area", "web", "#111111")])?.name).toBe("Severity");
    expect(swatchField([f("Notes", "x")])).toBeUndefined();
  });
  test("a named field is the only candidate", () => {
    expect(swatchField(custom, "severity")?.name).toBe("Severity");
    expect(swatchField(custom, "Area")).toBeUndefined();
  });
  test("a named field with no colour is not a swatch", () => {
    expect(swatchField(custom, "Notes")).toBeUndefined();
  });
});

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
describe("the panel reads the saved names", () => {
  test("no row guesses the PR field or the swatch by itself any more", () => {
    expect(code).not.toContain("/github/i.test(");
    expect(code).not.toContain("squad|team|pod|tribe");
  });
  test("both PR-field reads and both swatch reads go through the setting", () => {
    expect(code.match(/prLinkValue\(t\.custom, cuPrefs\?\.prLinkField\)/g)?.length).toBe(2);
    expect(code).toContain("swatch(t, cuPrefs?.swatchField)");
    expect(code.match(/swatch\(t, cuPrefs\?\.swatchField\)/g)?.length).toBe(2);
  });
  test("the skills menu and its grouping use the saved pattern", () => {
    expect(code).toContain("cardSkills(r.skills ?? [], p?.cardSkillPattern)");
    expect(code.match(/namedForIt\([^)]*cuPrefs\?\.cardSkillPattern\)/g)?.length).toBe(2);
  });
});
